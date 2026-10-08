import { beforeEach, describe, it, expect, vi } from 'vitest';
const capture = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  value: 'first',
}));
vi.mock('child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: null, result: { stdout: string }) => void
  ) => {
    capture.calls.push({ command, args, options });
    const stdout =
      args[0] === 'dump-keychain'
        ? 'keychain: fixture\nclass: "genp"\n"svce"<blob>="ink:OWNED"\nkeychain: fixture\nclass: "genp"\n"svce"<blob>="unrelated"'
        : capture.value;
    callback(null, { stdout });
  },
}));
import { readHostKeychainCredentials } from './keychain-credentials.js';
beforeEach(() => {
  capture.calls = [];
  capture.value = 'first';
});
describe('session keychain snapshot', () => {
  it('uses explicit env, the ink namespace and a fresh private map for each session', async () => {
    const a = await readHostKeychainCredentials({ platform: 'darwin', env: { HOME: '/owned' } });
    capture.value = 'second';
    const b = await readHostKeychainCredentials({ platform: 'darwin', env: { HOME: '/other' } });
    expect(a).toEqual({ OWNED: 'first' });
    expect(b).toEqual({ OWNED: 'second' });
    expect(capture.calls.map((c) => c.command)).toEqual(Array(4).fill('/usr/bin/security'));
    expect(capture.calls[0].options.env).toEqual({ HOME: '/owned' });
    expect(capture.calls[2].options.env).toEqual({ HOME: '/other' });
    expect(
      capture.calls.filter((c) => c.args[0] === 'find-generic-password').map((c) => c.args)
    ).toEqual(Array(2).fill(['find-generic-password', '-s', 'ink:OWNED', '-w']));
  });
  it('does nothing off macOS and refuses an already cancelled read', async () => {
    expect(await readHostKeychainCredentials({ platform: 'linux', env: {} })).toEqual({});
    const stop = new AbortController();
    stop.abort();
    await expect(
      readHostKeychainCredentials({ platform: 'darwin', env: {}, signal: stop.signal })
    ).rejects.toThrow();
    expect(capture.calls).toEqual([]);
  });
});
