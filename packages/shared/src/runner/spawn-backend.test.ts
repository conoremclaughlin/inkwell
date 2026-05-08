import { describe, expect, it } from 'vitest';
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

describe('spawnBackend', () => {
  it('captures stdout and stderr from a simple command', async () => {
    const { result } = spawnBackend({
      binary: 'echo',
      args: ['hello world'],
    });
    const res = await result;
    expect(res.stdout).toBe('hello world');
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThan(0);
  });

  it('captures stderr output', async () => {
    const { result } = spawnBackend({
      binary: 'sh',
      args: ['-c', 'echo error >&2'],
    });
    const res = await result;
    expect(res.stderr).toBe('error');
    expect(res.exitCode).toBe(0);
  });

  it('reports non-zero exit code', async () => {
    const { result } = spawnBackend({
      binary: 'sh',
      args: ['-c', 'exit 42'],
    });
    const res = await result;
    expect(res.exitCode).toBe(42);
    expect(res.timedOut).toBe(false);
  });

  it('times out with hard ceiling', async () => {
    const { result } = spawnBackend({
      binary: 'sleep',
      args: ['10'],
      timeoutMs: 100,
    });
    const res = await result;
    expect(res.timedOut).toBe(true);
    expect(res.timeoutType).toBe('hard');
    expect(res.exitCode).toBe(124);
  });

  it('calls onStdout callback for each chunk', async () => {
    const chunks: string[] = [];
    const { result } = spawnBackend({
      binary: 'sh',
      args: ['-c', 'echo line1; echo line2'],
      onStdout: (chunk) => chunks.push(chunk),
    });
    await result;
    const combined = chunks.join('');
    expect(combined).toContain('line1');
    expect(combined).toContain('line2');
  });

  it('strips CLAUDECODE from spawned process env', async () => {
    process.env.CLAUDECODE = '1';
    const { result } = spawnBackend({
      binary: 'sh',
      args: ['-c', 'echo $CLAUDECODE'],
    });
    const res = await result;
    expect(res.stdout).toBe('');
    delete process.env.CLAUDECODE;
  });

  it('merges extra env vars into spawned process', async () => {
    const { result } = spawnBackend({
      binary: 'sh',
      args: ['-c', 'echo $MY_TEST_VAR'],
      env: { MY_TEST_VAR: 'wren-test' },
    });
    const res = await result;
    expect(res.stdout).toBe('wren-test');
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
