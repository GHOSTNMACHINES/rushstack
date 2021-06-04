// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { JestConfigLoader } from '../JestConfigLoader';

import type { Config } from '@jest/types';

describe('JestConfigLoader', () => {
  it('resolves preset config modules', async () => {
    const configPath: string = path.join(__dirname, 'testProject', 'config', 'jest.config.json');
    const rootDir: string = path.join(__dirname, 'testProject');
    const loadedConfig: Config.InitialOptions = await JestConfigLoader.loadConfigAsync(configPath, rootDir);

    expect(loadedConfig.preset).toBe(undefined);

    // Resolution of string fields is validated implicitly during load since the preset field is
    // parsed like this.
    // Validate string[]
    expect(loadedConfig.setupFiles?.length).toBe(2);
    expect(loadedConfig.setupFiles![0]).toBe(path.join(rootDir, 'a', 'b', 'setupFile2.js'));
    expect(loadedConfig.setupFiles![1]).toBe(path.join(rootDir, 'a', 'b', 'setupFile1.js'));

    // Validate reporters
    expect(loadedConfig.reporters?.length).toBe(3);
    expect(loadedConfig.reporters![0]).toBe('default');
    expect(loadedConfig.reporters![1]).toBe(path.join(rootDir, 'a', 'c', 'mockReporter1.js'));
    expect((loadedConfig.reporters![2] as Config.ReporterConfig)[0]).toBe(
      path.join(rootDir, 'a', 'c', 'd', 'mockReporter2.js')
    );

    // Validate transformers
  });
});
