/**
 * spec:sender-token-binding v3 §4 Phase 0 (task 7f4ceda4).
 *
 * The ink chat child used to receive `{ ...process.env, ...sessionEnv }`: the
 * server's whole environment, JWT signing key and Supabase service key
 * included (P4, measured by Myra from inside a runner). The child now inherits
 * exact names only. This asserts the FINAL env handed to spawn, override order
 * included: the parent's secrets are absent, the session variables and the
 * server-minted credentials are present, and the basics survive.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const resolveInkCliMock = vi.fn();

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-binary', () => ({
  resolveBinaryPath: vi.fn(async () => '/fake/bin/ink'),
  buildSpawnPath: vi.fn((bin: string) => `${bin}:dir:/usr/bin`),
}));
vi.mock('../ink-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ink-cli')>()),
  resolveInkCli: (...a: unknown[]) => resolveInkCliMock(...a),
}));
// The real env builders from @inklabs/shared (resolved from its dist build);
// only the file-writing helpers are stubbed.
vi.mock('@inklabs/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inklabs/shared')>()),
  injectSessionHeaders: vi.fn(() => null),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner } from './ink-runner';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

async function launchOnce(config: Record<string, unknown>): Promise<Record<string, string>> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const run = new InkRunner().run('hello', { config: config as never });
  for (let i = 0; i < 20 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(spawnMock).toHaveBeenCalledOnce();
  child.emit('close', 0);
  await run;
  const [, , options] = spawnMock.mock.calls[0] as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  return options.env;
}

beforeEach(() => {
  resolveInkCliMock.mockReset();
  resolveInkCliMock.mockReturnValue({
    path: '/srv/checkout/packages/cli/dist/cli.js',
    source: 'checkout',
    script: true,
  });
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('InkRunner child environment (Phase 0)', () => {
  it('never hands the child a server secret, and hands it the session credentials explicitly', async () => {
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic-service-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'synthetic-bot');
    vi.stubEnv('INK_ACCESS_TOKEN', 'parent-session-token');
    vi.stubEnv('HOME', '/home/synthetic');

    const env = await launchOnce({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-env-1',
      inkAccessToken: 'child-session-token',
      inkDelegationSecret: 'synthetic-derived-secret',
    });

    expect('JWT_SECRET' in env).toBe(false);
    expect('SUPABASE_SECRET_KEY' in env).toBe(false);
    expect('TELEGRAM_BOT_TOKEN' in env).toBe(false);
    // The child's own credentials, from the config, never the parent's env.
    expect(env.INK_ACCESS_TOKEN).toBe('child-session-token');
    expect(env.INK_DELEGATION_SECRET).toBe('synthetic-derived-secret');
    expect(env.INK_SESSION_ID).toBe('sess-env-1');
    expect(env.SB_SLUG).toBe('myra');
    expect(env.AGENT_ID).toBe('myra');
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOME).toBe('/home/synthetic');
    expect(env.PATH).toBe(`${process.execPath}:dir:/usr/bin`);
    expect('CLAUDECODE' in env).toBe(false);
  });

  it('a child with no delegation secret in its config gets none, even when the parent holds one', async () => {
    vi.stubEnv('INK_DELEGATION_SECRET', 'parent-delegation-secret');
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    const env = await launchOnce({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-env-2',
    });
    expect('INK_DELEGATION_SECRET' in env).toBe(false);
    expect('JWT_SECRET' in env).toBe(false);
  });

  it("hands the chat the run's own epoch, so its turn signal names the run's turn", async () => {
    const env = await launchOnce({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-env-3',
      turnEpoch: 'run-epoch-3',
    });
    expect(env.INK_RUN_TURN_EPOCH).toBe('run-epoch-3');
  });

  it("never passes on an epoch from the server's own env", async () => {
    vi.stubEnv('INK_RUN_TURN_EPOCH', 'someone-elses-epoch');
    const env = await launchOnce({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-env-4',
    });
    expect('INK_RUN_TURN_EPOCH' in env).toBe(false);
  });
});

describe('a turn on the tools tier runs on its own tool policy (task 0321ccf1)', () => {
  async function launch(config: Record<string, unknown>) {
    const env = await launchOnce(config);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const flagged = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    return {
      env,
      profile: flagged('--profile'),
      required: flagged('--require-profile'),
      away: args.includes('--away'),
      noProviderTools: args.includes('--no-provider-tools'),
    };
  }
  const POLICY = '/home/synthetic/.ink/inklings/.tool-policy/0a1b2c3d.json';

  it('names the tools profile and its own policy file, over any the server holds, for any SB', async () => {
    vi.stubEnv('INK_TOOL_POLICY_PATH', '/home/synthetic/.ink/security/tool-policy.json');
    for (const sbSlug of ['kindle-0a1b2c3d', 'myra']) {
      spawnMock.mockClear();
      const launched = await launch({
        workingDirectory: '/tmp',
        sbSlug,
        executionTier: 'tools',
        toolPolicyPath: POLICY,
      });
      // Required, not merely named: a CLI that doesn't know the profile
      // refuses it, where --profile would warn and carry on (Lumen, #773).
      expect(launched.required, sbSlug).toBe('tools');
      expect(launched.profile, sbSlug).toBeNull();
      expect(launched.away, sbSlug).toBe(true);
      expect(launched.env.INK_TOOL_POLICY_PATH, sbSlug).toBe(POLICY);
      // Named too, though the profile implies it: a CLI that takes the
      // profile but not the option refuses it, rather than opening the
      // provider's native Read for a document.
      expect(launched.noProviderTools, sbSlug).toBe(true);
    }
  });

  it('runs the full tier, or no tier named, on the safe profile and the policy it already had', async () => {
    for (const tier of [{ executionTier: 'full', toolPolicyPath: POLICY }, {}]) {
      spawnMock.mockClear();
      const launched = await launch({ workingDirectory: '/tmp', sbSlug: 'myra', ...tier });
      expect(launched.profile).toBe('safe');
      expect(launched.required).toBeNull();
      expect(launched.noProviderTools).toBe(false);
      expect('INK_TOOL_POLICY_PATH' in launched.env).toBe(false);
    }
  });

  it('starts nothing on the tools tier without a policy of its own', async () => {
    const result = await new InkRunner().run('hello', {
      config: { workingDirectory: '/tmp', sbSlug: 'myra', executionTier: 'tools' } as never,
    });
    expect(result.success).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
