import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { statSync } from 'fs';
import { getHeartbeatProcessingConfig, isGitWorktree } from './heartbeat-flags';

// A filesystem with exactly two checkouts, modelled the way git really lays
// them out: `.git` exists ONLY at a repo root, and stat throws anywhere else.
//
// The previous mock returned `{ isFile: () => false }` for every unrecognised
// path, which silently claims `.git` exists in every directory on the machine.
// Under that mock a cwd of `<worktree>/packages/api` "found" a .git directory
// one level in and reported root-repo — the exact wrong answer, indistinguishable
// from the real bug's wrong answer. A mock that never throws cannot express the
// condition this guard walks past.
const ROOT_REPO = '/repos/personal-context-protocol';
const WORKTREE = '/repos/personal-context-protocol--wren';

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    statSync: vi.fn((path: string) => {
      if (path === '/repos/personal-context-protocol/.git') {
        return { isFile: () => false }; // root repo: .git is a directory
      }
      if (path === '/repos/personal-context-protocol--wren/.git') {
        return { isFile: () => true }; // worktree: .git is a file
      }
      const err = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }),
    readFileSync: vi.fn(
      () =>
        'gitdir: /repos/personal-context-protocol/.git/worktrees/personal-context-protocol--wren'
    ),
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
    { ENABLE_HEARTBEAT_SERVICE: 'false' },
    { ENABLE_HEARTBEAT_SERVICE: 'off' },
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
    expect(isGitWorktree(WORKTREE)).toBe(true);
  });

  it('returns false when .git is a directory (root repo)', () => {
    expect(isGitWorktree(ROOT_REPO)).toBe(false);
  });

  it('returns false when no ancestor has a .git (not a git repo)', () => {
    expect(isGitWorktree('/tmp/scratch')).toBe(false);
  });

  // ── The production shape. Every test above and every test this file shipped
  // with passes a repo ROOT — a directory the API server is never in. It starts
  // via `yarn workspace @inklabs/api server:dev`, so cwd is `<repo>/packages/api`.
  // Before the ancestor walk these two returned false, and false means "root
  // repo, go ahead and process reminders".
  it('detects a worktree from a subdirectory (the cwd the server actually has)', () => {
    expect(isGitWorktree(`${WORKTREE}/packages/api`)).toBe(true);
  });

  it('still reports the root repo from a subdirectory', () => {
    expect(isGitWorktree(`${ROOT_REPO}/packages/api`)).toBe(false);
  });

  it('finds the nearest .git when several levels deep', () => {
    expect(isGitWorktree(`${WORKTREE}/packages/api/src/config`)).toBe(true);
  });

  it('stops at the filesystem root rather than looping forever', () => {
    expect(isGitWorktree('/')).toBe(false);
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
    process.cwd = () => WORKTREE;

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(false);
    expect(result.flags.isWorktree).toBe(true);
  });

  // ── The 2026-09-11 outage, as a test.
  //
  // A second server ran from personal-context-protocol--wren for thirteen hours
  // with the heartbeat service live, racing the main server to claim Myra's
  // hourly reminder and killing roughly half her beats. This guard is what
  // should have stopped it on startup. It reported enabled: true, because cwd
  // was `<worktree>/packages/api` and the old check only ever stat'd `<cwd>/.git`.
  it('auto-disables from the packages/api cwd a real server starts with', () => {
    process.cwd = () => `${WORKTREE}/packages/api`;

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(false);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('leaves the main server enabled from its packages/api cwd', () => {
    process.cwd = () => `${ROOT_REPO}/packages/api`;

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBeUndefined();
  });

  it('explicit ENABLE_HEARTBEATS=true overrides worktree auto-disable', () => {
    process.cwd = () => WORKTREE;

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEATS: 'true' });

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('explicit ENABLE_REMINDERS=true overrides worktree auto-disable', () => {
    process.cwd = () => WORKTREE;

    const result = getHeartbeatProcessingConfig({ ENABLE_REMINDERS: 'true' });

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('explicit ENABLE_HEARTBEAT_SERVICE=true overrides worktree auto-disable', () => {
    process.cwd = () => WORKTREE;

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEAT_SERVICE: 'true' });

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('non-true values do NOT override worktree auto-disable', () => {
    process.cwd = () => WORKTREE;

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEATS: 'yes' });

    expect(result.enabled).toBe(false);
    expect(result.flags.isWorktree).toBe(true);
  });

  it('does not set isWorktree flag for root repo', () => {
    process.cwd = () => ROOT_REPO;

    const result = getHeartbeatProcessingConfig({});

    expect(result.enabled).toBe(true);
    expect(result.flags.isWorktree).toBeUndefined();
  });

  // ── The documented-but-unread name, on the server that actually needs it.
  // AGENTS.md's isolated-server recipe is ENABLE_HEARTBEAT_SERVICE=false. Before
  // this it disabled nothing, on a root repo or anywhere else.
  it('ENABLE_HEARTBEAT_SERVICE=false disables a root-repo server', () => {
    process.cwd = () => ROOT_REPO;

    const result = getHeartbeatProcessingConfig({ ENABLE_HEARTBEAT_SERVICE: 'false' });

    expect(result.enabled).toBe(false);
  });
});
