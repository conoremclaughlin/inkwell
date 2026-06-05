import { describe, expect, it, vi } from 'vitest';
import { getHeartbeatProcessingConfig } from './heartbeat-flags';

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    statSync: vi.fn((path: string) => {
      if (path.endsWith('worktree-repo/.git')) {
        return { isFile: () => true };
      }
      // Default: .git is a directory (root repo)
      return { isFile: () => false };
    }),
    readFileSync: vi.fn(() => 'gitdir: /some/repo/.git/worktrees/worktree-repo'),
  };
});

describe('getHeartbeatProcessingConfig', () => {
  it('defaults to enabled when heartbeat flags are unset', () => {
    const result = getHeartbeatProcessingConfig({});
    expect(result.enabled).toBe(true);
  });

  it.each([
    { ENABLE_HEARTBEATS: 'false' },
    { ENABLE_HEARTBEATS: 'FALSE' },
    { ENABLE_HEARTBEATS: ' false ' },
    { ENABLE_HEARTBEATS: '0' },
    { ENABLE_REMINDERS: 'no' },
  ])('disables heartbeat processing for false-like flag values: %o', (envVars) => {
    const result = getHeartbeatProcessingConfig(envVars);
    expect(result.enabled).toBe(false);
  });

  it('stays enabled for true-like values', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEATS: 'true',
      ENABLE_REMINDERS: 'yes',
    });
    expect(result.enabled).toBe(true);
  });
});
