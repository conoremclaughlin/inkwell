import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBoundHostedInkRunner, type HostedInkBinding } from './hosted-ink-binding';
import { registerActiveRun, resetActiveRuns, submitRunSteering } from './active-runs';
import { signRunnerAccessToken, verifyInkAccessToken } from '../../auth/ink-tokens';
import type { ClaudeRunnerConfig } from './types';
import type { HostedInkSessionPorts } from './hosted-ink-session';
vi.mock('../../config/env', async () => ({
  env: (await import('../../test/fake-env')).fakeEnv,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const roots: string[] = [];
beforeEach(() => resetActiveRuns());
afterEach(async () => {
  resetActiveRuns();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-binding-')));
  roots.push(cwd);
  const sessionId = 'binding-session';
  const userId = 'fixture-user';
  const turnEpoch = 'fixture-epoch';
  registerActiveRun({
    sessionId,
    userId,
    sbSlug: 'echo',
    backend: 'ink',
    startedAt: Date.now(),
    turnEpoch,
  });
  const config: ClaudeRunnerConfig = {
    workingDirectory: cwd,
    mcpConfigPath: join(cwd, '.mcp.json'),
    inkSessionId: sessionId,
    turnEpoch,
    sbSlug: 'echo',
    inkAccessToken: signRunnerAccessToken(
      { userId, email: 'fixture@example.invalid', sbSlug: 'echo', sessionId },
      120
    ),
    timeoutMs: 60_000,
    maxTurns: 1,
  };
  const prepare = vi.fn(async (_input: unknown, _ports: HostedInkSessionPorts) => {
    throw new Error('fixture preparation stops here');
  });
  const host: HostedInkBinding = {
    baseEnv: {
      PATH: process.env.PATH,
      HOME: cwd,
      SUPABASE_SECRET_KEY: 'never-in-a-child',
      JWT_SECRET: 'never-in-a-child',
      INK_ACCESS_TOKEN: 'wrong-owner-token',
    },
    paths: { inkFiles: join(cwd, 'files'), studiosRoot: join(cwd, 'studios'), tempDir: cwd },
    mcpUrl: 'http://127.0.0.1:49271/mcp',
    resolveBinary: vi.fn(async () => {
      throw new Error('No provider permitted in this fixture');
    }),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    warn: vi.fn(),
    prepareEffects: prepare,
    project: vi.fn(),
    register: vi.fn(),
  };
  return { cwd, sessionId, config, prepare, host };
}
describe('server binding, admitted identity and explicit resources', () => {
  it('uses only the admitted credential/context, with expiry ceiling and a clean provider env', async () => {
    const h = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ result: { content: [{ type: 'text', text: '{"success":true}' }] } })
        )
    );
    vi.stubGlobal('fetch', fetch);
    h.prepare.mockImplementation(async (_input, ports) => {
      expect(
        await ports.inkwell.callTool('bootstrap', { sbSlug: 'echo' }, { signal: ports.signal })
      ).toEqual({ success: true });
      const host = ports.provider.context!.host;
      expect(await host.baseEnv()).toEqual({
        PATH: process.env.PATH,
        HOME: h.cwd,
        INK_SERVER_URL: 'http://127.0.0.1:49271',
        INK_MCP_URL: 'http://127.0.0.1:49271/mcp',
      });
      const env = await host.sessionEnv({ hardTimeoutMs: 30_000 });
      expect(env.INK_RUNNER_AUTH_REQUIRED).toBe('1');
      const minted = verifyInkAccessToken(env.INK_ACCESS_TOKEN!, 'mcp_access')!;
      expect(minted.sessionId).toBe(h.sessionId);
      expect(minted.sub).toBe('fixture-user');
      expect(minted.exp).toBeLessThanOrEqual(verifyInkAccessToken(h.config.inkAccessToken!)!.exp!);
      expect(() =>
        ports.provider.startTurn({
          inkSessionId: h.sessionId,
          workingDirectory: '/different',
          sbSlug: 'echo',
          studioId: undefined,
          cliAttached: false,
        })
      ).toThrow('changed the admitted');
      throw new Error('fixture preparation stops here');
    });
    const outcome = await createBoundHostedInkRunner(h.host).run('hello', { config: h.config });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('changed the admitted session context');
    expect(outcome.refusedBeforeSpawn).toBe(true);
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.host.resolveBinary).not.toHaveBeenCalled();
    const headers = fetch.mock.calls[0][1]!.headers as Record<string, string>;
    expect(JSON.parse(Buffer.from(headers['x-ink-context'], 'base64url').toString())).toMatchObject(
      { sessionId: h.sessionId, sbSlug: 'echo', cliAttached: false }
    );
    expect(verifyInkAccessToken(headers.Authorization.slice(7))?.sessionId).toBe(h.sessionId);
  });
  it.each([
    'missing',
    'malformed',
    'other-session',
    'other-owner',
    'expired',
    'wrong-server',
    'permissions',
    'browser-token',
    'admin-token',
    'space-turn-token',
  ] as const)('refuses %s before effects or provider execution', async (kind) => {
    const h = await setup();
    if (kind === 'missing') h.config.inkAccessToken = undefined;
    if (kind === 'malformed') h.config.inkAccessToken = 'not-a-credential';
    if (kind === 'other-session')
      h.config.inkAccessToken = signRunnerAccessToken(
        {
          userId: 'fixture-user',
          email: 'fixture@example.invalid',
          sbSlug: 'echo',
          sessionId: 'other',
        },
        120
      );
    if (kind === 'other-owner')
      h.config.inkAccessToken = signRunnerAccessToken(
        {
          userId: 'other-user',
          email: 'fixture@example.invalid',
          sbSlug: 'echo',
          sessionId: h.sessionId,
        },
        120
      );
    if (kind === 'expired')
      h.config.inkAccessToken = signRunnerAccessToken(
        {
          userId: 'fixture-user',
          email: 'fixture@example.invalid',
          sbSlug: 'echo',
          sessionId: h.sessionId,
        },
        -1
      );
    if (kind === 'browser-token' || kind === 'admin-token')
      h.config.inkAccessToken = jwt.sign(
        {
          type: kind === 'browser-token' ? 'browser_client' : 'pcp_admin',
          sub: 'fixture-user',
          sessionId: h.sessionId,
          sbSlug: 'echo',
          scope: 'mcp:tools',
          grantId: 'fixture-grant',
        },
        env.JWT_SECRET,
        { expiresIn: 120 }
      );
    // A shared conversation's turn token for this very session. The hosted
    // binding re-mints the runner's credential for its MCP client, and must
    // not turn a space-turn token into a broad one: it refuses it instead
    // (ink://specs/inkling-multi-person-groups, Phase 1).
    if (kind === 'space-turn-token')
      h.config.inkAccessToken = jwt.sign(
        {
          type: 'mcp_access',
          sub: 'fixture-user',
          email: 'fixture@example.invalid',
          scope: 'mcp:space-turn',
          sbSlug: 'echo',
          sessionId: h.sessionId,
          workspaceId: 'fixture-workspace',
          threadId: 'fixture-thread',
          threadKey: 'inkling:thread:fixture-group',
        },
        env.JWT_SECRET,
        { expiresIn: 120 }
      );
    if (kind === 'wrong-server') h.config.inkMcpUrl = 'http://localhost:3001/mcp';
    if (kind === 'permissions') h.config.permissionOverlay = { deny: ['Bash(*)'] };
    const outcome = await createBoundHostedInkRunner(h.host).run('hello', { config: h.config });
    expect(outcome).toMatchObject({ success: false, refusedBeforeSpawn: true });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.host.resolveBinary).not.toHaveBeenCalled();
  });
});

it('binds steering to the admitted generation and releases it when execution retires', async () => {
  const h = await setup();
  h.prepare.mockImplementation(async (_input, ports) => {
    expect(ports.steering).toBeDefined();
    ports.steering!.bind(async (request) => ({ messageId: request.messageId, status: 'pending' }));
    expect(
      await submitRunSteering(h.sessionId, 'fixture-epoch', {
        messageId: 'fixture-correction',
        text: 'New information.',
      })
    ).toEqual({ messageId: 'fixture-correction', status: 'pending' });
    throw new Error('fixture stops before tools or providers');
  });
  const outcome = await createBoundHostedInkRunner(h.host).run('work', { config: h.config });
  expect(outcome.success).toBe(false);
  expect(h.host.resolveBinary).not.toHaveBeenCalled();
  expect(
    await submitRunSteering(h.sessionId, 'fixture-epoch', {
      messageId: 'after-retirement',
      text: 'Must not dispatch.',
    })
  ).toMatchObject({ status: 'refused' });
});

it('withholds steering from the admitted tools tier regardless of later caller changes', async () => {
  const h = await setup();
  h.config.executionTier = 'tools';
  h.config.toolPolicyPath = join(h.cwd, 'tools-only-policy.json');
  const fetch = vi.fn(async () => {
    throw new Error('No network in this fixture');
  });
  vi.stubGlobal('fetch', fetch);
  let steeringAvailable: boolean | undefined;
  h.prepare.mockImplementation(async (_input, ports) => {
    // The runner has already frozen its launch input. An external object or
    // mutable identity changing afterwards must not grow this run's authority.
    h.config.executionTier = 'full';
    steeringAvailable = ports.steering !== undefined;
    expect(
      await submitRunSteering(h.sessionId, 'fixture-epoch', {
        messageId: 'tools-only-correction',
        text: 'Do not admit this input.',
      })
    ).toEqual({
      messageId: 'tools-only-correction',
      status: 'refused',
      reason: 'no_current_hosted_owner',
    });
    throw new Error('fixture stops before tools or providers');
  });
  const outcome = await createBoundHostedInkRunner(h.host).run('work', { config: h.config });
  expect(steeringAvailable).toBe(false);
  expect(outcome.success).toBe(false);
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(h.host.resolveBinary).not.toHaveBeenCalled();
});

it('never widens a mixed-scope space-turn token: what it re-mints verifies as nothing', async () => {
  // "mcp:tools mcp:space-turn" passes the binding's mcp:tools check, and the
  // binding copies the scope as it is. Its re-minted claims omit the
  // conversation, so the provider must read the minted token as invalid,
  // never as a broad one (ink://specs/inkling-multi-person-groups, Phase 1).
  // Pins today's behaviour; the binding itself is unchanged.
  const h = await setup();
  h.config.inkAccessToken = jwt.sign(
    {
      type: 'mcp_access',
      sub: 'fixture-user',
      email: 'fixture@example.invalid',
      scope: 'mcp:tools mcp:space-turn',
      sbSlug: 'echo',
      sessionId: h.sessionId,
      workspaceId: 'fixture-workspace',
      threadId: 'fixture-thread',
      threadKey: 'inkling:thread:fixture-group',
    },
    env.JWT_SECRET,
    { expiresIn: 120 }
  );
  const minted: string[] = [];
  h.prepare.mockImplementation(async (_input, ports) => {
    const childEnv = await ports.provider.context!.host.sessionEnv({ hardTimeoutMs: 30_000 });
    minted.push(childEnv.INK_ACCESS_TOKEN!);
    throw new Error('fixture preparation stops here');
  });

  const outcome = await createBoundHostedInkRunner(h.host).run('hello', { config: h.config });

  expect(outcome.success).toBe(false);
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.host.resolveBinary).not.toHaveBeenCalled();
  expect(minted).toHaveLength(1);
  const raw = verifyInkAccessToken(minted[0], 'mcp_access')!;
  // The scope travelled unchanged, and the conversation did not.
  expect(raw.scope).toBe('mcp:tools mcp:space-turn');
  expect(raw.threadKey).toBeUndefined();
  const { InkAuthProvider } = await import('../../mcp/auth/ink-auth-provider');
  expect(new InkAuthProvider().verifyAccessTokenSignature(`Bearer ${minted[0]}`)).toBeNull();
});
