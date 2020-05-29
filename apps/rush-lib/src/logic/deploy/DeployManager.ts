// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from "path";
import * as resolve from "resolve";
import * as fsx from "fs-extra";
import {
  Path,
  FileSystem,
  PackageJsonLookup,
  FileSystemStats,
  Sort,
  JsonFile,
  IPackageJson
} from "@rushstack/node-core-library";
import { RushConfiguration } from '../../api/RushConfiguration';
import { SymlinkAnalyzer, ILinkInfo } from './SymlinkAnalyzer';
import { RushConfigurationProject } from "../../api/RushConfigurationProject";

interface IDeployScenarioProjectJson {
  projectName: string;
  subdeploymentFolderName?: string;
  additionalProjectsToInclude?: string[];
}

interface IDeploySubdeploymentsJson {
  enabled?: boolean;
  subdeploymentProjects?: string[];
}

interface IDeployScenarioJson {
  includeDevDependencies?: boolean;
  includeNpmIgnoreFiles?: boolean;
  symlinkCreation?: "default" | "script" | "none";
  projectSettings?: IDeployScenarioProjectJson[];
  subdeployments?: IDeploySubdeploymentsJson;
}

interface ISubdeploymentState {
  targetSubdeploymentFolder: string;
  symlinkAnalyzer: SymlinkAnalyzer;
  foldersToCopy: Set<string>;
}

export class DeployManager {
  private readonly _rushConfiguration: RushConfiguration;

  private _targetRootFolder: string;
  private _sourceRootFolder: string;

  private readonly _packageJsonLookup: PackageJsonLookup;

  private _deployScenarioJson: IDeployScenarioJson;
  private _deployScenarioProjectJsonsByName: Map<string, IDeployScenarioProjectJson>;

  public constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;
    this._packageJsonLookup = new PackageJsonLookup();
    this._deployScenarioProjectJsonsByName = new Map();
  }

  private _loadConfigFile(scenarioName: string): void {
    const deployScenarioPath: string = path.join(this._rushConfiguration.commonFolder, 'config/deploy-scenarios',
      scenarioName + '.json');

    if (!FileSystem.exists(deployScenarioPath)) {
      throw new Error('The scenario config file was not found: ' + deployScenarioPath);
    }

    this._deployScenarioJson = JsonFile.load(deployScenarioPath);

    for (const projectSetting of this._deployScenarioJson.projectSettings || []) {
      // Validate projectSetting.projectName
      if (!this._rushConfiguration.getProjectByName(projectSetting.projectName)) {
        throw new Error(`The "projectSettings" section refers to the project name "${projectSetting.projectName}"` +
          ` which was not found in rush.json`);
      }
      for (const additionalProjectsToInclude of projectSetting.additionalProjectsToInclude || []) {
        if (!this._rushConfiguration.getProjectByName(projectSetting.projectName)) {
          throw new Error(`The "additionalProjectsToInclude" setting refers to the` +
            ` project name "${additionalProjectsToInclude}" which was not found in rush.json`);
        }
      }
      this._deployScenarioProjectJsonsByName.set(projectSetting.projectName, projectSetting);
    }
  }

  private _collectFoldersRecursive(packageJsonPath: string, subdemploymentState: ISubdeploymentState): void {
    const packageJsonFolderPath: string = path.dirname(packageJsonPath);

    if (!subdemploymentState.foldersToCopy.has(packageJsonFolderPath)) {
      subdemploymentState.foldersToCopy.add(packageJsonFolderPath);

      const packageJson: IPackageJson = JsonFile.load(packageJsonPath);

      // Union of keys from regular dependencies, peerDependencies, and optionalDependencies
      const allDependencyNames: Set<string> = new Set<string>();
      // Just the keys from optionalDependencies
      const optionalDependencyNames: Set<string> = new Set<string>();

      for (const name of Object.keys(packageJson.dependencies || {})) {
        allDependencyNames.add(name);
      }
      if (this._deployScenarioJson.includeDevDependencies) {
        for (const name of Object.keys(packageJson.devDependencies || {})) {
          allDependencyNames.add(name);
        }
      }
      for (const name of Object.keys(packageJson.peerDependencies || {})) {
        allDependencyNames.add(name);
        optionalDependencyNames.add(name); // consider peers optional, since they are so frequently broken
      }
      for (const name of Object.keys(packageJson.optionalDependencies || {})) {
        allDependencyNames.add(name);
        optionalDependencyNames.add(name);
      }

      for (const dependencyPackageName of allDependencyNames) {
        const resolvedDependency: string = resolve.sync(dependencyPackageName, {
          basedir: packageJsonFolderPath,
          preserveSymlinks: false,
          packageFilter: (pkg, dir) => {
            // point "main" at a file that is guaranteed to exist
            // This helps resolve packages such as @types/node that have no entry point
            pkg.main = "./package.json";
            return pkg;
          },
          realpathSync: (filePath) => {
            try {
              const resolvedPath: string = require("fs").realpathSync(filePath);

              subdemploymentState.symlinkAnalyzer.analyzePath(filePath);
              return resolvedPath;
            } catch (realpathErr) {
              if (realpathErr.code !== "ENOENT") {
                throw realpathErr;
              }
            }
            return filePath;
          },
        });

        if (!resolvedDependency) {
          if (optionalDependencyNames.has(dependencyPackageName)) {
            // Ignore missing optional dependency
            continue;
          }
          throw new Error(`Error resolving ${dependencyPackageName} from ${packageJsonPath}`);
        }

        const dependencyPackageJsonPath: string | undefined
          = this._packageJsonLookup.tryGetPackageJsonFilePathFor(resolvedDependency);
        if (!dependencyPackageJsonPath) {
          throw new Error(`Error finding package.json for ${resolvedDependency}`);
        }

        this._collectFoldersRecursive(dependencyPackageJsonPath, subdemploymentState);
      }
    }
  }

  private _remapPathForDeployFolder(absolutePathInSourceFolder: string,
    subdemploymentState: ISubdeploymentState): string {

    if (!Path.isUnderOrEqual(absolutePathInSourceFolder, this._sourceRootFolder)) {
      throw new Error("Source path is not under " + this._sourceRootFolder + "\n" + absolutePathInSourceFolder);
    }
    const relativePath: string = path.relative(this._sourceRootFolder, absolutePathInSourceFolder);
    const absolutePathInTargetFolder: string = path.join(subdemploymentState.targetSubdeploymentFolder, relativePath);
    return absolutePathInTargetFolder;
  }

  private _deployFolder(sourceFolderPath: string, subdemploymentState: ISubdeploymentState): void {

    const targetFolderPath: string = this._remapPathForDeployFolder(sourceFolderPath, subdemploymentState);

    // When copying a package folder, we always ignore the node_modules folder; it will be added indirectly
    // only if needed
    const pathToIgnore: string = path.join(sourceFolderPath, "node_modules");

    fsx.copySync(sourceFolderPath, targetFolderPath, {
      overwrite: false,
      errorOnExist: true,
      filter: (src: string, dest: string) => {
        if (Path.isUnderOrEqual(src, pathToIgnore)) {
          return false;
        }

        const stats: FileSystemStats = FileSystem.getLinkStatistics(src);
        if (stats.isSymbolicLink()) {
          subdemploymentState.symlinkAnalyzer.analyzePath(src);
          return false;
        }

        return true;
      },
    });
  }

  private _deploySymlink(originalLinkInfo: ILinkInfo, subdemploymentState: ISubdeploymentState): boolean {
    const linkInfo: ILinkInfo = {
      kind: originalLinkInfo.kind,
      linkPath: this._remapPathForDeployFolder(originalLinkInfo.linkPath, subdemploymentState),
      targetPath: this._remapPathForDeployFolder(originalLinkInfo.targetPath, subdemploymentState),
    };

    // Has the link target been created yet?  If not, we should try again later
    if (!FileSystem.exists(linkInfo.targetPath)) {
      return false;
    }

    const newLinkFolder: string = path.dirname(linkInfo.linkPath);
    FileSystem.ensureFolder(newLinkFolder);

    // Link to the relative path for symlinks
    const relativeTargetPath: string = path.relative(FileSystem.getRealPath(newLinkFolder), linkInfo.targetPath);

    // NOTE: This logic is based on NpmLinkManager._createSymlink()
    if (process.platform === "win32") {
      if (linkInfo.kind === "folderLink") {
        // For directories, we use a Windows "junction".  On Unix, this produces a regular symlink.
        FileSystem.createSymbolicLinkJunction({
          linkTargetPath: relativeTargetPath,
          newLinkPath: linkInfo.linkPath,
        });
      } else {
        // For files, we use a Windows "hard link", because creating a symbolic link requires
        // administrator permission.

        // NOTE: We cannot use the relative path for hard links
        FileSystem.createHardLink({
          linkTargetPath: relativeTargetPath,
          newLinkPath: linkInfo.linkPath,
        });
      }
    } else {
      // However hard links seem to cause build failures on Mac, so for all other operating systems
      // we use symbolic links for this case.
      if (linkInfo.kind === "folderLink") {
        FileSystem.createSymbolicLinkFolder({
          linkTargetPath: relativeTargetPath,
          newLinkPath: linkInfo.linkPath,
        });
      } else {
        FileSystem.createSymbolicLinkFile({
          linkTargetPath: relativeTargetPath,
          newLinkPath: linkInfo.linkPath,
        });
      }
    }

    return true;
  }

  private _deploySubdeployment(includedProjectNames: string[], subdeploymentFolderName: string | undefined): void {
    // Include the additionalProjectsToInclude
    const includedProjectNamesSet: Set<string> = new Set();
    for (const projectName of includedProjectNames) {
      includedProjectNamesSet.add(projectName);

      const projectSettings: IDeployScenarioProjectJson | undefined
        = this._deployScenarioProjectJsonsByName.get(projectName);
      if (projectSettings && projectSettings.additionalProjectsToInclude) {
        for (const additionalProjectToInclude of projectSettings.additionalProjectsToInclude) {
          includedProjectNamesSet.add(additionalProjectToInclude);
        }
      }
    }

    const subdemploymentState: ISubdeploymentState = {
      targetSubdeploymentFolder: path.join(this._targetRootFolder, subdeploymentFolderName || ''),
      symlinkAnalyzer: new SymlinkAnalyzer(),
      foldersToCopy: new Set<string>()
    };

    for (const projectName of includedProjectNamesSet) {
      console.log(`Analyzing project "${projectName}"`);
      const project: RushConfigurationProject | undefined = this._rushConfiguration.getProjectByName(projectName);

      if (!project) {
        throw new Error(`The project ${projectName} is not defined in rush.json`);
      }

      this._collectFoldersRecursive(path.join(project.projectFolder, 'package.json'), subdemploymentState);
    }

    Sort.sortSet(subdemploymentState.foldersToCopy);

    console.log("Copying folders...");
    for (const folderToCopy of subdemploymentState.foldersToCopy) {
      this._deployFolder(folderToCopy, subdemploymentState);
    }

    console.log("Copying symlinks...");
    const linksToCopy: ILinkInfo[] = subdemploymentState.symlinkAnalyzer.reportSymlinks();

    for (const linkToCopy of linksToCopy) {
      if (!this._deploySymlink(linkToCopy, subdemploymentState)) {
        throw new Error("Target does not exist: " + JSON.stringify(linkToCopy, undefined, 2));
      }
    }
  }

  public deployScenario(scenarioName: string, overwriteExisting: boolean,
    targetFolderParameter: string | undefined): void {

    this._loadConfigFile(scenarioName);

    if (targetFolderParameter) {
      this._targetRootFolder = path.resolve(targetFolderParameter);
      if (!FileSystem.exists(this._targetRootFolder)) {
        throw new Error('The specified target folder does not exist: ' + JSON.stringify(targetFolderParameter));
      }
    } else {
      this._targetRootFolder = path.join(this._rushConfiguration.commonFolder, 'deploy');
    }
    this._sourceRootFolder = this._rushConfiguration.rushJsonFolder;

    console.log("Deploying to target folder: " + this._targetRootFolder);

    FileSystem.ensureFolder(this._targetRootFolder);

    // Is the target folder empty?
    if (FileSystem.readFolder(this._targetRootFolder).length > 0) {
      if (overwriteExisting) {
        console.log('Deleting folder contents because "--overwrite" was specified...');
        FileSystem.ensureEmptyFolder(this._targetRootFolder);
      } else {
        throw new Error('The deploy target folder is not empty. You can specify "--overwrite"'
          + ' to recursively delete all folder contents.');
      }
    }

    if (this._deployScenarioJson.subdeployments && this._deployScenarioJson.subdeployments.enabled) {
      const usedSubdeploymentFolderNames: Set<string> = new Set();
      for (const subdeploymentProjectName of this._deployScenarioJson.subdeployments.subdeploymentProjects || []) {
        const rushProject: RushConfigurationProject | undefined =
          this._rushConfiguration.getProjectByName(subdeploymentProjectName);
        if (!rushProject) {
          throw new Error(`The subdeploymentProjects specified the name "${subdeploymentProjectName}"` +
            ` which was not found in rush.json`);
        }

        let subdeploymentFolderName: string;

        const projectSettings: IDeployScenarioProjectJson | undefined
          = this._deployScenarioProjectJsonsByName.get(subdeploymentProjectName);
        if (projectSettings && projectSettings.subdeploymentFolderName) {
          subdeploymentFolderName = projectSettings.subdeploymentFolderName;
        } else {
          subdeploymentFolderName = this._rushConfiguration.packageNameParser.getUnscopedName(subdeploymentProjectName);
        }
        if (usedSubdeploymentFolderNames.has(subdeploymentFolderName)) {
          throw new Error(`The subdeployment folder name "${subdeploymentFolderName}" is not unique.`
            + `  Use the "subdeploymentFolderName" setting to specify a different name.`);
        }
        usedSubdeploymentFolderNames.add(subdeploymentFolderName);

        console.log(`\nPreparing subdeployment for "${subdeploymentFolderName}"`);

        this._deploySubdeployment([ subdeploymentProjectName ], subdeploymentFolderName);
      }
    } else {
      if (!this._deployScenarioJson.projectSettings || this._deployScenarioJson.projectSettings.length === 0) {
        throw new Error('No projects were specified to be deployed. If subdeployments.enabled is false,'
          + ' then the "projectSettings" section must specify at least one project.');
      }
      const includedProjectNames: string[] = this._deployScenarioJson.projectSettings.map(x => x.projectName);
      this._deploySubdeployment(includedProjectNames, undefined);
    }

    console.log("SUCCESS");
  }
}
