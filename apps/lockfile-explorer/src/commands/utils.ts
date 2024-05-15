// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as dp from '@pnpm/dependency-path';

interface IPackageInfo {
  name: string;
  peersSuffix: string | undefined;
  version: string;
}

export function convertLockfileV6DepPathToV5DepPath(newDepPath: string): string {
  if (!newDepPath.includes('@', 2) || newDepPath.startsWith('file:')) return newDepPath;
  const index = newDepPath.indexOf('@', newDepPath.indexOf('/@') + 2);
  if (newDepPath.includes('(') && index > dp.indexOfPeersSuffix(newDepPath)) return newDepPath;
  return `${newDepPath.substring(0, index)}/${newDepPath.substring(index + 1)}`;
}

export function parseDependencyPath(shrinkwrapFileMajorVersion: number, newDepPath: string): IPackageInfo {
  let dependencyPath: string = newDepPath;
  if (shrinkwrapFileMajorVersion === 6) {
    dependencyPath = convertLockfileV6DepPathToV5DepPath(newDepPath);
  }
  const packageInfo = dp.parse(dependencyPath);
  return {
    name: packageInfo.name as string,
    peersSuffix: packageInfo.peersSuffix,
    version: packageInfo.version as string
  };
}

export function getShrinkwrapFileMajorVersion(lockfileVersion: string | number): number {
  let shrinkwrapFileMajorVersion: number;
  if (typeof lockfileVersion === 'string') {
    const isDotIncluded: boolean = lockfileVersion.includes('.');
    shrinkwrapFileMajorVersion = parseInt(
      lockfileVersion.substring(0, isDotIncluded ? lockfileVersion.indexOf('.') : undefined),
      10
    );
  } else if (typeof lockfileVersion === 'number') {
    shrinkwrapFileMajorVersion = Math.floor(lockfileVersion);
  } else {
    shrinkwrapFileMajorVersion = 0;
  }

  if (shrinkwrapFileMajorVersion < 5 || shrinkwrapFileMajorVersion > 6) {
    throw new Error('The current lockfile version is not supported.');
  }

  return shrinkwrapFileMajorVersion;
}
