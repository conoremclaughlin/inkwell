import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));
import {
  buildCleanEnv,
  spawnBackend,
  resolveSpawnTarget,
  LineBuffer,
  SPAWN_ENV_INHERITED_NAMES,
  SESSION_ENV_HANDOFF_NAMES,
  RUN_TURN_EPOCH_ENV,
  sessionEnvHandoff,
} from './spawn-backend.js';

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

// spec:sender-token-binding v3 §4 Phase 0 (task 7f4ceda4). A spawned SB used to
// receive the server's ENTIRE environment minus one variable, so every child
// held the JWT signing key and the Supabase service key (P4, measured by Myra
// from inside a runner). The child now starts from nothing and inherits exact
// names only. Every value below is synthetic; the fixture is a shape, not a
// copy of any deployment.
describe('buildCleanEnv: the child inherits exact names only (Phase 0)', () => {
  const parent: Record<string, string> = {
    // Process basics a runtime needs.
    HOME: '/home/synthetic',
    PATH: '/synthetic/bin',
    USER: 'synthetic-user',
    SHELL: '/bin/zsh',
    TMPDIR: '/tmp/synthetic',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SSH_AUTH_SOCK: '/tmp/synthetic-agent.sock',
    // Toolchain paths.
    NVM_DIR: '/home/synthetic/.nvm',
    HOMEBREW_PREFIX: '/opt/homebrew',
    DOCKER_HOST: 'unix:///synthetic/docker.sock',
    // Inkwell knobs a child reads.
    INK_SERVER_URL: 'http://localhost:4001',
    INK_STUDIOS_ROOT: '/home/synthetic/.ink/studios',
    // Each runtime's own authentication, named individually.
    ANTHROPIC_API_KEY: 'synthetic-anthropic',
    OPENAI_API_KEY: 'synthetic-openai',
    GEMINI_API_KEY: 'synthetic-gemini',
    GOOGLE_API_KEY: 'synthetic-google-api',
    // A GitHub credential the SBs' own tooling uses (.mcp.json interpolates it).
    GITHUB_TOKEN: 'synthetic-github',
    // Server secrets and server-only configuration: must never cross.
    JWT_SECRET: 'synthetic-jwt-secret',
    SUPABASE_SECRET_KEY: 'synthetic-service-key',
    SUPABASE_PUBLISHABLE_KEY: 'synthetic-anon-key',
    SUPABASE_URL: 'http://localhost:54321',
    GOOGLE_CLIENT_SECRET: 'synthetic-oauth-secret',
    GOOGLE_CLIENT_ID: 'synthetic-oauth-id',
    TELEGRAM_BOT_TOKEN: 'synthetic-bot',
    TELEGRAM_BENSON_BOT_TOKEN: 'synthetic-bot-2',
    SB_TEST_PASSWORD: 'synthetic-password',
    SB_TEST_EMAIL: 'user@example.com',
    SENTRY_DSN: 'https://synthetic@sentry.example/1',
    MCP_REQUIRE_OAUTH: 'false',
    ENABLE_TELEGRAM: 'true',
    // A credential the PARENT happens to hold: a child gets its own, explicitly.
    INK_ACCESS_TOKEN: 'parent-session-token',
    INK_DELEGATION_SECRET: 'parent-delegation-secret',
    // Node knobs that can inject code or carry a registry credential.
    NODE_OPTIONS: '--require /synthetic/hook.js',
    NODE_AUTH_TOKEN: 'synthetic-npm-token',
    // Unlisted members of otherwise-inherited families: exact names, no prefixes.
    NVM_SYNTHETIC_UNLISTED: 'x',
    INK_SYNTHETIC_UNLISTED: 'x',
    GOOGLE_SYNTHETIC_UNLISTED: 'x',
    // The nested-session marker.
    CLAUDECODE: '1',
  };

  it('passes the basics, toolchain, Inkwell knobs and each runtime credential through by name', () => {
    const env = buildCleanEnv(undefined, parent);
    for (const name of [
      'HOME',
      'PATH',
      'USER',
      'SHELL',
      'TMPDIR',
      'LANG',
      'TERM',
      'SSH_AUTH_SOCK',
      'NVM_DIR',
      'HOMEBREW_PREFIX',
      'DOCKER_HOST',
      'INK_SERVER_URL',
      'INK_STUDIOS_ROOT',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GITHUB_TOKEN',
    ]) {
      expect(env[name], name).toBe(parent[name]);
    }
  });

  it('never passes a server secret, server-only configuration, or the parent credentials', () => {
    const env = buildCleanEnv(undefined, parent);
    for (const name of [
      'JWT_SECRET',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_URL',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CLIENT_ID',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_BENSON_BOT_TOKEN',
      'SB_TEST_PASSWORD',
      'SB_TEST_EMAIL',
      'SENTRY_DSN',
      'MCP_REQUIRE_OAUTH',
      'ENABLE_TELEGRAM',
      'INK_ACCESS_TOKEN',
      'INK_DELEGATION_SECRET',
      'NODE_OPTIONS',
      'NODE_AUTH_TOKEN',
      'CLAUDECODE',
    ]) {
      expect(name in env, name).toBe(false);
    }
  });

  it('matches exact names, never a prefix', () => {
    const env = buildCleanEnv(undefined, parent);
    expect('NVM_SYNTHETIC_UNLISTED' in env).toBe(false);
    expect('INK_SYNTHETIC_UNLISTED' in env).toBe(false);
    expect('GOOGLE_SYNTHETIC_UNLISTED' in env).toBe(false);
  });

  it('the explicit env is applied last: it wins over the parent and may add unlisted names', () => {
    const env = buildCleanEnv(
      { HOME: '/studio/home', INK_ACCESS_TOKEN: 'child-session-token', SB_SLUG: 'wren' },
      parent
    );
    expect(env.HOME).toBe('/studio/home');
    expect(env.INK_ACCESS_TOKEN).toBe('child-session-token');
    expect(env.SB_SLUG).toBe('wren');
    expect('JWT_SECRET' in env).toBe(false);
  });

  it('reads process.env when no parent is given, applying the same allowlist', () => {
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    vi.stubEnv('LANG', 'C.UTF-8');
    try {
      const env = buildCleanEnv({ SB_SLUG: 'lumen' });
      expect('JWT_SECRET' in env).toBe(false);
      expect(env.LANG).toBe('C.UTF-8');
      expect(env.SB_SLUG).toBe('lumen');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('inherits the operator tool-policy path, which the ink chat child reads (Lumen, #694 r1)', () => {
    const env = buildCleanEnv(undefined, {
      ...parent,
      INK_TOOL_POLICY_PATH: '/synthetic/policy.json',
    });
    expect(env.INK_TOOL_POLICY_PATH).toBe('/synthetic/policy.json');
  });

  it('exports the inherited names so a spawner test can assert the final env against them', () => {
    expect(Array.isArray(SPAWN_ENV_INHERITED_NAMES)).toBe(true);
    expect(SPAWN_ENV_INHERITED_NAMES).toContain('HOME');
    expect(SPAWN_ENV_INHERITED_NAMES).toContain('GITHUB_TOKEN');
    expect(SPAWN_ENV_INHERITED_NAMES).not.toContain('JWT_SECRET');
    expect(SPAWN_ENV_INHERITED_NAMES).not.toContain('INK_ACCESS_TOKEN');
    // No name is a pattern (macOS's __CF_USER_TEXT_ENCODING starts with underscores).
    expect(SPAWN_ENV_INHERITED_NAMES.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))).toBe(true);
    expect(new Set(SPAWN_ENV_INHERITED_NAMES).size).toBe(SPAWN_ENV_INHERITED_NAMES.length);
  });

  it("never passes a server run's epoch below the chat it was set on", () => {
    // Set explicitly on the chat the server spawns, and on nothing else: a
    // provider child carrying it would name a turn it does not own.
    expect(SPAWN_ENV_INHERITED_NAMES).not.toContain(RUN_TURN_EPOCH_ENV);
    expect(SESSION_ENV_HANDOFF_NAMES).not.toContain(RUN_TURN_EPOCH_ENV);
    expect(sessionEnvHandoff({ [RUN_TURN_EPOCH_ENV]: 'run-epoch' })).toEqual({});
    expect(buildCleanEnv(undefined, { [RUN_TURN_EPOCH_ENV]: 'run-epoch' })).toEqual({});
  });
});

// The ink chat child spawns its provider backend for a turn through
// spawnBackend. That grandchild serves the SAME session, so the child hands
// it its own credentials and identity explicitly (Lumen, #694 r1: with the
// blanket inheritance gone, the provider lost its INK_ACCESS_TOKEN and its
// session ids at the final spawn).
describe('sessionEnvHandoff: a session process hands its own session state to its child', () => {
  const childEnv: Record<string, string> = {
    INK_ACCESS_TOKEN: 'child-session-token',
    INK_DELEGATION_SECRET: 'synthetic-derived-secret',
    INK_SESSION_ID: 'sess-1',
    INK_STUDIO_ID: 'studio-1',
    INK_CONTEXT: 'synthetic-context-token',
    INK_RUNTIME_LINK_ID: 'link-1',
    INK_CONSTITUTION_INJECTED: '1',
    SB_SLUG: 'wren',
    AGENT_ID: 'wren',
    // Never part of a handoff: the server's secrets are not in this process
    // to begin with after Phase 0, and would not cross even if they were.
    JWT_SECRET: 'synthetic-jwt-secret',
    SUPABASE_SECRET_KEY: 'synthetic-service-key',
    HOME: '/home/synthetic',
  };

  it('hands over exactly the session credentials and identity, by name', () => {
    const handoff = sessionEnvHandoff(childEnv);
    expect(handoff).toEqual({
      INK_ACCESS_TOKEN: 'child-session-token',
      INK_DELEGATION_SECRET: 'synthetic-derived-secret',
      INK_SESSION_ID: 'sess-1',
      INK_STUDIO_ID: 'studio-1',
      INK_CONTEXT: 'synthetic-context-token',
      INK_RUNTIME_LINK_ID: 'link-1',
      INK_CONSTITUTION_INJECTED: '1',
      SB_SLUG: 'wren',
      AGENT_ID: 'wren',
    });
  });

  it('buildCleanEnv does not inherit any of them on its own; the handoff must be explicit', () => {
    const inherited = buildCleanEnv(undefined, childEnv);
    for (const name of SESSION_ENV_HANDOFF_NAMES) {
      expect(name in inherited, name).toBe(false);
    }
    const final = buildCleanEnv(
      { ...sessionEnvHandoff(childEnv), INK_SESSION_ID: 'from-prepare' },
      childEnv
    );
    expect(final.INK_ACCESS_TOKEN).toBe('child-session-token');
    expect(final.INK_SESSION_ID).toBe('from-prepare');
    expect('JWT_SECRET' in final).toBe(false);
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
