import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { statSync } from 'fs';
import { getHeartbeatProcessingConfig, isGitWorktree } from './heartbeat-flags';

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

// ═══════════════════════════════════════════════════════════════
// isGitWorktree — unit tests
// ═══════════════════════════════════════════════════════════════
describe('isGitWorktree', () => {
  it('returns true when .git is a file starting with gitdir:', () => {
    expect(isGitWorktree('/some/path/worktree-repo')).toBe(true);
  });

  it('returns false when .git is a directory (root repo)', () => {
    expect(isGitWorktree('/some/path/root-repo')).toBe(false);
  });

  it('returns false when .git does not exist (not a git repo)', () => {
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(isGitWorktree('/not/a/git/repo')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Worktree auto-disable — regression tests for PR #397
//
// Worktree dev servers should not process heartbeats/reminders
// unless explicitly enabled. The main server on port 3001 owns
// those globally. Without this guard, duplicate deliveries occur.
// ═══════════════════════════════════════════════════════════════
describe('Worktree auto-disable', () => {
  let originalCwd: () => string;

  beforeEach(() => {
    originalCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  it('auto-disables heartbeats when running in a git worktree', () => {
    process.cwd = () => '/some/path/worktree-repo';

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(false);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('explicit ENABLE_HEARTBEATS=true overrides worktree auto-disable', () => {
    process.cwd = () => '/some/path/worktree-repo';

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEATS: 'true' });

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('explicit ENABLE_REMINDERS=true overrides worktree auto-disable', () => {
    process.cwd = () => '/some/path/worktree-repo';

    const result = getHeartbeatProcessingConfig({ ENABLE_REMINDERS: 'true' });

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('non-true values do NOT override worktree auto-disable', () => {
    process.cwd = () => '/some/path/worktree-repo';

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEATS: 'yes' });

    expect(result.enabled).toBe(false);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('does not set isWorktree flag for root repo', () => {
    process.cwd = () => '/some/path/root-repo';

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBeUndefined();
  });
});
