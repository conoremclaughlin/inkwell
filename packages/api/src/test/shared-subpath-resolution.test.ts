import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import dbConfig from '../../vitest.integration.db.config';
import liveConfig from '../../vitest.live.config';

// Read only the resolver settings: never run either project's setup files,
// load dotenv, open a server, connect to a database, or call a model.
describe.each([
  ['DB', dbConfig],
  ['live', liveConfig],
] as const)('%s shared source imports', (_name, project) => {
  it.each([
    ['@inklabs/shared', 'index.ts'],
    ['@inklabs/shared/node-host', 'node-host/index.ts'],
    ['@inklabs/shared/runtime', 'runtime/index.ts'],
    ['@inklabs/shared/providers', 'providers/index.ts'],
    ['@inklabs/shared/security/untrusted-content', 'security/untrusted-content.ts'],
  ])('resolves %s to its source file, not beneath index.ts', async (specifier, file) => {
    const root = path.resolve(__dirname, '../..');
    const config = await resolveConfig(
      { root, configFile: false, envDir: false, resolve: project.resolve },
      'serve',
      'test'
    );
    const resolve = config.createResolver();
    expect(await resolve(specifier, path.join(root, 'src/services/web-fetch/extract.ts'))).toBe(
      path.resolve(root, '../shared/src', file)
    );
  });
});
