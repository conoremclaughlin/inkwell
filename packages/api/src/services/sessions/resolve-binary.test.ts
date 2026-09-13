import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter } from 'path';

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
