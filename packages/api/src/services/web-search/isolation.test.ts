import { describe, expect, it } from 'vitest';
import { assertUnmanagedHost } from './isolation.js';

describe('managed policy presence precondition (metadata stand-ins only)', () => {
  it.each(['linux', 'win32', 'freebsd'] as const)(
    'refuses unsupported login storage on %s',
    async (platform) => {
      await expect(assertUnmanagedHost(platform, async () => true)).rejects.toMatchObject({
        reason: 'unsupported_platform',
      });
    }
  );

  it.each(['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'])(
    'refuses any %s, including unreadable or empty sources',
    async (file) => {
      await expect(
        assertUnmanagedHost('darwin', async (path) => !path.endsWith(file))
      ).rejects.toMatchObject({ reason: 'managed_configuration' });
    }
  );

  it('checks both device and per-user managed plist paths without reading their contents', async () => {
    const paths: string[] = [];
    await assertUnmanagedHost('darwin', async (path) => {
      paths.push(path);
      return true;
    });
    expect(paths.filter((path) => path.endsWith('.plist'))).toHaveLength(2);
    await expect(
      assertUnmanagedHost('darwin', async (path) => !path.endsWith('.plist'))
    ).rejects.toMatchObject({ reason: 'managed_configuration' });
  });
});
