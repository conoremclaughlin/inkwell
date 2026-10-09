import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, mkdir, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyLaunchProfile, ToolPolicyState } from '@inklabs/shared/runtime';
import type { BackendHost } from '@inklabs/shared/providers';
import { createHostedInkEffects } from './hosted-ink-effects';
import type { HostedInkSessionInput, HostedInkSessionPorts } from './hosted-ink-session';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-effects-')));
  roots.push(root);
  const path = join(root, 'policy.json');
  const close = vi.fn(async () => {});
  const prepare = createHostedInkEffects({
    home: root,
    tempDir: root,
    inkFiles: root,
    policyPath: path,
    mcpUrl: 'http://127.0.0.1:49199/mcp',
    coding: async () => ({
      ports: { load: async () => new Map(), readDocument: async () => null },
      close,
    }),
    credentials: async (input) => ({ PRIVATE: input.sessionId }),
    activeSkills: async () => [],
    publish: vi.fn(),
  });
  const input = (sbSlug: string): HostedInkSessionInput => ({
    sessionId: `${sbSlug}-session`,
    turnEpoch: 'epoch',
    sbSlug,
    workingDirectory: root,
    message: 'hello',
    attachments: [],
    options: {
      maxTurns: 1,
      toolRouting: 'local',
      profile: 'safe',
      withholdProviderTools: false,
      away: true,
      messageLabel: 'fixture',
    },
  });
  const ports = (sbSlug: string) =>
    ({
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
      sessionLog: { path: join(root, `${sbSlug}.jsonl`) },
      provider: {
        context: {
          host: {
            sessionEnv: async () => ({ INK_ACCESS_TOKEN: 'scoped-token' }),
          } as unknown as BackendHost,
        },
      },
    }) as unknown as HostedInkSessionPorts;
  const a = await prepare(input('echo'), ports('echo'));
  const b = await prepare(input('myra'), ports('myra'));
  applyLaunchProfile(a.policy, 'safe');
  applyLaunchProfile(b.policy, 'safe');
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { requestId: 'approved-fixture' }
            : { status: 'granted', action: 'grant-agent' }
        )
      )
  );
  vi.stubGlobal('fetch', fetch);
  return { root, path, a, b, close, fetch };
}
describe('hosted session effects', () => {
  it('keeps credentials private and merges concurrent permanent grants without sharing policy state', async () => {
    const h = await setup();
    expect(h.a.toolHost.dispatch.resolveCredentials({ value: '$PRIVATE' })).toEqual({
      value: 'echo-session',
    });
    expect(h.b.toolHost.dispatch.resolveCredentials({ value: '$PRIVATE' })).toEqual({
      value: 'myra-session',
    });
    await Promise.all([
      h.a.approve('write', 'fixture', { path: 'a' }),
      h.b.approve('edit', 'fixture', { path: 'b' }),
    ]);
    const snapshot = JSON.parse(await readFile(h.path, 'utf8'));
    const echo = new ToolPolicyState('backend', { snapshot, context: { sbSlug: 'echo' } });
    const myra = new ToolPolicyState('backend', { snapshot, context: { sbSlug: 'myra' } });
    expect(echo.snapshot().scopes?.agent?.echo?.permanentGrants).toContain('write');
    expect(myra.snapshot().scopes?.agent?.myra?.permanentGrants).toContain('edit');
    expect(h.b.policy.snapshot().scopes?.agent?.echo).toBeUndefined();
    await h.a.close();
    expect(() => h.a.toolHost.dispatch.resolveCredentials({})).toThrow('closed');
    expect(h.b.toolHost.dispatch.resolveCredentials({ value: '$PRIVATE' })).toEqual({
      value: 'myra-session',
    });
    await h.b.close();
    expect(h.close).toHaveBeenCalledTimes(2);
  });
  it('hard denies never ask and an aborted approval cannot dispatch HTTP', async () => {
    const h = await setup();
    h.a.policy.denyTool('write');
    expect(await h.a.approve('write', 'fixture', {})).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    const stop = new AbortController();
    stop.abort();
    await expect(h.b.approve('edit', 'fixture', {}, stop.signal)).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
    await h.a.close();
    await h.b.close();
  });
  it('a permanent grant failing to persist does not authorize the effect', async () => {
    const h = await setup();
    await mkdir(h.path);
    await expect(h.a.approve('write', 'fixture', {})).rejects.toThrow();
    expect(h.a.policy.inspectInkTool('write', 'echo-session').allowed).toBe(false);
    await h.a.close();
    await h.b.close();
  });
});
