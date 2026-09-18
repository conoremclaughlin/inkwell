import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));
import { buildCleanEnv, spawnBackend, resolveSpawnTarget, LineBuffer } from './spawn-backend.js';

describe('buildCleanEnv', () => {
  it('strips CLAUDECODE from process.env', () => {
    const original = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    const env = buildCleanEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    // Restore
    if (original !== undefined) {
      process.env.CLAUDECODE = original;
    } else {
      delete process.env.CLAUDECODE;
    }
  });

  it('merges extra env vars', () => {
    const env = buildCleanEnv({ MY_VAR: 'hello', AGENT_ID: 'wren' });
    expect(env.MY_VAR).toBe('hello');
    expect(env.AGENT_ID).toBe('wren');
  });

  it('extra env overrides process.env', () => {
    const env = buildCleanEnv({ HOME: '/custom/home' });
    expect(env.HOME).toBe('/custom/home');
  });
});

describe('spawnBackend (mocked process boundary)', () => {
  let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    spawnMock.mockReset().mockReturnValue(child);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('captures output and keeps prompt bytes in argv without a shell', async () => {
    const prompt = 'synthetic prompt with "quotes" and $(echo literal)';
    const chunks: string[] = [];
    const { result } = spawnBackend({
      binary: 'codex',
      args: ['exec', '--', prompt],
      onStdout: (text) => chunks.push(text),
    });
    child.stdout.emit('data', 'hello\n');
    child.stderr.emit('data', 'diagnostic\n');
    child.emit('close', 0);
    expect(await result).toMatchObject({
      stdout: 'hello',
      stderr: 'diagnostic',
      exitCode: 0,
      timedOut: false,
    });
    expect(chunks).toEqual(['hello\n']);
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['exec', '--', prompt],
      expect.objectContaining({ shell: false })
    );
  });

  it('reports nonzero exits and spawn errors', async () => {
    const first = spawnBackend({ binary: 'codex', args: [] });
    child.emit('close', 42);
    expect(await first.result).toMatchObject({ exitCode: 42, timedOut: false });
    const second = spawnBackend({ binary: 'codex', args: [] });
    child.emit('error', new Error('synthetic spawn failure'));
    expect(await second.result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('synthetic spawn failure'),
    });
  });

  it.each(['hard', 'idle'] as const)(
    'reports a %s timeout without starting or killing a real process',
    async (kind) => {
      vi.useFakeTimers();
      const { result } = spawnBackend({
        binary: 'codex',
        args: [],
        timeoutMs: kind === 'hard' ? 100 : 1000,
        idleTimeoutMs: kind === 'idle' ? 100 : undefined,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ timedOut: true, timeoutType: kind, exitCode: 124 });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      vi.clearAllTimers();
    }
  );

  it('cleans process environment and merges explicit variables', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const { result } = spawnBackend({ binary: 'codex', args: [], env: { SYNTHETIC_TEST: 'yes' } });
    const options = spawnMock.mock.calls[0][2];
    expect(options.env.CLAUDECODE).toBeUndefined();
    expect(options.env.SYNTHETIC_TEST).toBe('yes');
    child.emit('close', 0);
    await result;
  });

  it('pipes explicit stdin and enables docker interactive input', async () => {
    const { result } = spawnBackend({
      binary: 'claude',
      args: ['--print'],
      stdinData: 'synthetic prompt',
      container: { containerName: 'synthetic-container' },
    });
    expect(child.stdin.read().toString()).toBe('synthetic prompt');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'exec',
      '-i',
      '--',
      'synthetic-container',
      'claude',
      '--print',
    ]);
    child.emit('close', 0);
    await result;
  });
});

describe('resolveSpawnTarget', () => {
  it('passes through binary and args for host execution', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: ['--print', '--verbose'],
      cwd: '/tmp/studio',
      env: { AGENT_ID: 'wren' },
    });
    expect(target.binary).toBe('claude');
    expect(target.args).toEqual(['--print', '--verbose']);
    expect(target.cwd).toBe('/tmp/studio');
    expect(target.env.AGENT_ID).toBe('wren');
  });

  it('wraps binary in docker exec for container execution', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: ['--print', '--verbose'],
      container: { containerName: 'ink-sandbox-wren-abc123' },
    });
    expect(target.binary).toBe('docker');
    expect(target.args[0]).toBe('exec');
    expect(target.args).toContain('ink-sandbox-wren-abc123');
    expect(target.args).toContain('claude');
    expect(target.args).toContain('--print');
    expect(target.args).toContain('--verbose');
  });

  it('passes cwd as --workdir to docker exec', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      cwd: '/studio',
      container: { containerName: 'test-container' },
    });
    const workdirIdx = target.args.indexOf('--workdir');
    expect(workdirIdx).toBeGreaterThan(-1);
    expect(target.args[workdirIdx + 1]).toBe('/studio');
    // Host cwd should be undefined (cwd is inside the container)
    expect(target.cwd).toBeUndefined();
  });

  it('passes env vars as -e flags to docker exec', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      env: { AGENT_ID: 'wren', INK_SANDBOX: 'docker' },
      container: { containerName: 'test-container' },
    });
    expect(target.args).toContain('-e');
    expect(target.args).toContain('AGENT_ID=wren');
    expect(target.args).toContain('INK_SANDBOX=docker');
  });

  it('adds -i flag when pipeStdin is true for container', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      pipeStdin: true,
      container: { containerName: 'test-container' },
    });
    expect(target.args).toContain('-i');
  });

  it('does not add -i flag when pipeStdin is false for container', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      pipeStdin: false,
      container: { containerName: 'test-container' },
    });
    const execIdx = target.args.indexOf('exec');
    const containerIdx = target.args.indexOf('test-container');
    // No -i between exec and container name
    const sliceBetween = target.args.slice(execIdx + 1, containerIdx);
    expect(sliceBetween).not.toContain('-i');
  });

  it('uses custom docker binary when specified', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      container: { containerName: 'test', dockerBinary: 'podman' },
    });
    expect(target.binary).toBe('podman');
  });

  it('converts host binary path to basename for container execution', () => {
    const target = resolveSpawnTarget({
      binary: '/home/synthetic/.local/bin/claude',
      args: ['--print'],
      container: { containerName: 'test-container' },
    });
    expect(target.binary).toBe('docker');
    const containerIdx = target.args.indexOf('test-container');
    expect(target.args[containerIdx + 1]).toBe('claude');
  });

  it('maps host cwd to container workDir (default /studio)', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      cwd: '/home/synthetic/ws/pcp/personal-context-protocol--wren',
      container: { containerName: 'test-container' },
    });
    const workdirIdx = target.args.indexOf('--workdir');
    expect(target.args[workdirIdx + 1]).toBe('/studio');
    expect(target.cwd).toBeUndefined();
  });

  it('respects custom container workDir', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: [],
      cwd: '/home/synthetic/ws/project',
      container: { containerName: 'test-container', workDir: '/workspace' },
    });
    const workdirIdx = target.args.indexOf('--workdir');
    expect(target.args[workdirIdx + 1]).toBe('/workspace');
  });

  it('preserves argument order: docker exec [flags] container binary args', () => {
    const target = resolveSpawnTarget({
      binary: 'claude',
      args: ['--print', '-m', 'sonnet'],
      cwd: '/studio',
      env: { KEY: 'val' },
      pipeStdin: true,
      container: { containerName: 'my-sandbox' },
    });
    // Structure: docker exec -i --workdir /studio -e KEY=val my-sandbox claude --print -m sonnet
    const containerIdx = target.args.indexOf('my-sandbox');
    expect(containerIdx).toBeGreaterThan(0);
    expect(target.args[containerIdx + 1]).toBe('claude');
    expect(target.args[containerIdx + 2]).toBe('--print');
    expect(target.args[containerIdx + 3]).toBe('-m');
    expect(target.args[containerIdx + 4]).toBe('sonnet');
  });
});

describe('LineBuffer', () => {
  it('splits complete lines', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('line1\nline2\nline3\n');
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('buffers partial lines across chunks', () => {
    const buf = new LineBuffer();
    expect(buf.feed('hel')).toEqual([]);
    expect(buf.feed('lo\nwor')).toEqual(['hello']);
    expect(buf.feed('ld\n')).toEqual(['world']);
  });

  it('flushes remaining content', () => {
    const buf = new LineBuffer();
    buf.feed('partial');
    expect(buf.flush()).toBe('partial');
    expect(buf.flush()).toBeNull();
  });

  it('handles empty input', () => {
    const buf = new LineBuffer();
    expect(buf.feed('')).toEqual([]);
    expect(buf.flush()).toBeNull();
  });

  it('handles multiple newlines', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('a\n\nb\n');
    expect(lines).toEqual(['a', '', 'b']);
  });
});
