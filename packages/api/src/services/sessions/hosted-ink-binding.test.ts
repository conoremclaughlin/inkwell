import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBoundHostedInkRunner, type HostedInkBinding } from './hosted-ink-binding';
import { registerActiveRun, resetActiveRuns } from './active-runs';
import { signRunnerAccessToken, verifyInkAccessToken } from '../../auth/ink-tokens';
import type { ClaudeRunnerConfig } from './types';
import type { HostedInkSessionPorts } from './hosted-ink-session';
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
    'other-session',
    'other-owner',
    'expired',
    'wrong-server',
    'permissions',
    'browser-token',
    'admin-token',
  ] as const)('refuses %s before effects or provider execution', async (kind) => {
    const h = await setup();
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
    if (kind === 'wrong-server') h.config.inkMcpUrl = 'http://localhost:3001/mcp';
    if (kind === 'permissions') h.config.permissionOverlay = { deny: ['Bash(*)'] };
    const outcome = await createBoundHostedInkRunner(h.host).run('hello', { config: h.config });
    expect(outcome).toMatchObject({ success: false, refusedBeforeSpawn: true });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.host.resolveBinary).not.toHaveBeenCalled();
  });
});
