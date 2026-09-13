import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Mock child_process with a callback-compatible execFile
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock fs/promises for pathExists
const mockAccess = vi.fn();
vi.mock('fs/promises', () => ({
  access: mockAccess,
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Dynamic import so mocks are in place before module loads
const { resolveBinaryPath, buildSpawnPath } = await import('./resolve-binary.js');

// Helper: make mockExecFile resolve with stdout
function mockWhichResult(stdout: string) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      if (typeof cb === 'function') {
        cb(null, { stdout, stderr: '' });
      }
    }
  );
}

function mockWhichError() {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      if (typeof cb === 'function') {
        cb(new Error('not found'));
      }
    }
  );
}

describe('resolveBinaryPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pathExists returns true for any path
    mockAccess.mockResolvedValue(undefined);
  });

  it('resolves a binary found via which', async () => {
    mockWhichResult('/usr/local/bin/test-binary\n');
    const name = 'test-binary-' + Date.now();
    const result = await resolveBinaryPath(name);
    expect(result).toBe('/usr/local/bin/test-binary');
    expect(mockExecFile).toHaveBeenCalledWith(
      'which',
      [name],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('falls back to zsh login shell when which fails', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        callCount++;
        if (typeof cb !== 'function') return;
        if (callCount === 1) {
          cb(new Error('not found'));
        } else {
          cb(null, {
            stdout: 'Now using node v22\n/opt/homebrew/bin/zsh-binary\n',
            stderr: '',
          });
        }
      }
    );

    const result = await resolveBinaryPath('zsh-binary-' + Date.now());
    expect(result).toBe('/opt/homebrew/bin/zsh-binary');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('returns bare binary name when both resolution methods fail', async () => {
    mockWhichError();
    const name = 'nonexistent-binary-' + Date.now();
    const result = await resolveBinaryPath(name);
    expect(result).toBe(name);
  });

  it('rejects resolved path that does not exist on disk', async () => {
    mockWhichResult('/usr/local/bin/ghost-binary\n');
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const name = 'ghost-binary-' + Date.now();
    const result = await resolveBinaryPath(name);
    // Both which and zsh paths fail pathExists, so bare name returned
    expect(result).toBe(name);
  });

  it('returns cached result on subsequent calls', async () => {
    const name = 'cached-binary-' + Date.now();
    mockWhichResult('/usr/bin/cached-binary\n');

    const first = await resolveBinaryPath(name);
    const second = await resolveBinaryPath(name);

    expect(first).toBe('/usr/bin/cached-binary');
    expect(second).toBe('/usr/bin/cached-binary');
    // execFile should only be called for the first resolution
    expect(mockExecFile.mock.calls.filter((c: string[][]) => c[1]?.includes(name))).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// First-party binary resolution — FALLBACK HARDENING
//
// WHAT THIS IS AND IS NOT, because the distinction was got wrong once.
//
// The primary path no longer comes through here at all. #611 landed
// `resolveInkCli()`, which ink-runner calls FIRST and which resolves this
// checkout's own packages/cli/dist/cli.js (or INK_CLI_PATH). That is the
// guarantee that the server runs its own build, and ink-runner-launch.test.ts
// is where it is demonstrated.
//
// `resolveBinaryPath('ink')` is now reached in exactly one situation: the
// null fallback at ink-runner.ts:377, when the checkout has no CLI build. It
// resolves a different artefact from #611 (node_modules/.bin/ink, not
// packages/cli/dist/cli.js), so it is neither dead nor duplicated — but it is
// hardening of a fallback, not a never-PATH guarantee, and these tests should
// not be read as claiming otherwise.
//
// WHY THE FALLBACK STILL DESERVES HARDENING. `which ink` resolved to a
// 2026-04-09 build in a sibling worktree predating --require-bootstrap;
// Commander rejected the flag and the spawn died in 633ms. Eleven worktrees
// on that machine each carry a node_modules/.bin/ink and eight were stale.
// The successful resolution is cached process-wide, so one bad answer pins
// every subsequent spawn until restart. Whichever agent spawns next wears it.
//
// (That incident is NOT what caused the Sep 9 outage — that was a genuinely
// logged-out backend — nor the Sep 11 recurrence, which was two API servers
// racing for reminders. See #609.)
//
// Each test re-imports the module so it starts with an empty cache — the
// cache is exactly what makes a single wrong answer durable.
// ═══════════════════════════════════════════════════════════════════
describe('resolveBinaryPath - first-party binaries', () => {
  async function freshModule() {
    vi.resetModules();
    return await import('./resolve-binary.js');
  }

  /** Treat only paths satisfying `predicate` as existing on disk. */
  function existsOnly(predicate: (p: string) => boolean) {
    mockAccess.mockImplementation((p: string) =>
      predicate(p) ? Promise.resolve(undefined) : Promise.reject(new Error('ENOENT'))
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  it("prefers this server's own .bin over a stale sibling on PATH", async () => {
    const { resolveBinaryPath } = await freshModule();
    // A stale sibling is on PATH and would win under the old behaviour.
    mockWhichResult('/somewhere/personal-context-protocol--wren/node_modules/.bin/ink\n');
    existsOnly((p) => p.endsWith('/node_modules/.bin/ink'));

    const result = await resolveBinaryPath('ink');

    expect(result).toMatch(/node_modules\/\.bin\/ink$/);
    expect(result).not.toContain('personal-context-protocol--wren/node_modules');
    // The decisive assertion: when a local build exists, the ambient PATH is
    // not consulted at all — so a stale sibling cannot be cached in.
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('picks the nearest ancestor workspace when several have a build', async () => {
    const { resolveBinaryPath } = await freshModule();
    mockWhichResult('/usr/local/bin/ink\n');

    // The module under test sits in this same directory, so its __dirname walk
    // starts here. Exactly two ancestors carry a build: packages/api and the
    // repo root. The nearer one must win.
    const here = dirname(fileURLToPath(import.meta.url));
    const apiPkgBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'ink');
    const repoRootBin = join(here, '..', '..', '..', '..', '..', 'node_modules', '.bin', 'ink');
    existsOnly((p) => p === apiPkgBin || p === repoRootBin);

    const result = await resolveBinaryPath('ink');

    expect(result).toBe(apiPkgBin);
    expect(result).not.toBe(repoRootBin);
  });

  it('falls back to PATH and warns when this checkout has no build of its own', async () => {
    const { resolveBinaryPath } = await freshModule();
    const { logger } = await import('../../utils/logger.js');
    mockWhichResult('/usr/local/bin/ink\n');
    // No workspace candidate exists; the PATH answer does.
    existsOnly((p) => p === '/usr/local/bin/ink');

    const result = await resolveBinaryPath('ink');

    expect(result).toBe('/usr/local/bin/ink');
    expect(mockExecFile).toHaveBeenCalled();
    // Silent fallback is how a stale sibling gets picked unnoticed.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('first-party'));
  });

  it('leaves third-party binaries on the PATH lookup', async () => {
    const { resolveBinaryPath } = await freshModule();
    mockWhichResult('/opt/homebrew/bin/claude\n');
    existsOnly((p) => p === '/opt/homebrew/bin/claude');

    const result = await resolveBinaryPath('claude');

    expect(result).toBe('/opt/homebrew/bin/claude');
    expect(mockExecFile).toHaveBeenCalledWith(
      'which',
      ['claude'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it.each(['claude', 'codex', 'gemini'])(
    'takes %s from PATH even when a local .bin of the same name exists',
    async (binary) => {
      // The four runners that call resolveBinaryPath for a third-party CLI
      // (claude-runner, codex-runner, gemini-runner, antigravity-runner) must
      // be untouched by this change. "First-party" is a list, and a list is
      // the kind of thing that grows by accident.
      //
      // The local .bin has to EXIST for this test to mean anything. A first
      // draft asserted the PATH result while letting no local candidate exist
      // — so adding 'claude' to FIRST_PARTY_BINARIES changed nothing, the
      // workspace walk found no candidate, and the test passed green through
      // exactly the mutation it was written to catch.
      const { resolveBinaryPath } = await freshModule();
      mockWhichResult(`/opt/homebrew/bin/${binary}\n`);
      existsOnly(
        (p) => p === `/opt/homebrew/bin/${binary}` || p.endsWith(`/node_modules/.bin/${binary}`)
      );

      const result = await resolveBinaryPath(binary);

      expect(result).toBe(`/opt/homebrew/bin/${binary}`);
      expect(result).not.toMatch(/node_modules/);
      expect(mockExecFile).toHaveBeenCalled();
    }
  );

  it('still reaches PATH when no local build exists, rather than failing closed', async () => {
    // The fallback has to REMAIN a fallback. A checkout with no build of its
    // own — a fresh clone, CI before install — must still find a usable ink
    // rather than refusing to spawn. Hardening this path must not close it.
    const { resolveBinaryPath } = await freshModule();
    mockWhichResult('/usr/local/bin/ink\n');
    existsOnly((p) => p === '/usr/local/bin/ink');

    expect(await resolveBinaryPath('ink')).toBe('/usr/local/bin/ink');
  });
});

describe('buildSpawnPath', () => {
  it('prepends binary directory to PATH', () => {
    const original = process.env.PATH;
    process.env.PATH = '/usr/bin:/usr/local/bin';
    const result = buildSpawnPath('/opt/homebrew/bin/claude');
    expect(result).toBe(`/opt/homebrew/bin${delimiter}/usr/bin:/usr/local/bin`);
    process.env.PATH = original;
  });

  it('does not duplicate existing directory', () => {
    const original = process.env.PATH;
    process.env.PATH = `/usr/bin${delimiter}/opt/homebrew/bin`;
    const result = buildSpawnPath('/opt/homebrew/bin/claude');
    expect(result).toBe(process.env.PATH);
    process.env.PATH = original;
  });

  it('returns current PATH for non-absolute (bare) binary names', () => {
    const original = process.env.PATH;
    process.env.PATH = '/usr/bin:/usr/local/bin';
    const result = buildSpawnPath('codex');
    expect(result).toBe('/usr/bin:/usr/local/bin');
    process.env.PATH = original;
  });

  it('returns just the binary directory when PATH is empty', () => {
    const original = process.env.PATH;
    process.env.PATH = '';
    const result = buildSpawnPath('/opt/homebrew/bin/claude');
    expect(result).toBe('/opt/homebrew/bin');
    process.env.PATH = original;
  });
});
