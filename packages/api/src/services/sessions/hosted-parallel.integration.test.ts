/**
 * Real HTTP/auth/DB + hosted loop, token-free provider children. Run ONLY under
 * the managed isolated DB harness. No real provider/keychain or global CLI.
 * The same fixture is the base for opt-in live-provider acceptance, separately.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { shouldRunOnIsolatedIntegrationDb } from '../../test/isolated-integration-target';
import type { DataComposer } from '../../data/composer';
import type { MCPServer } from '../../mcp/server';
import type { SessionService } from './session-service';
import type { HostedInkBinding } from './hosted-ink-binding';
import type { IRunner } from './types';

vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
  default: { config: () => ({ parsed: {} }) },
}));
const enabled = shouldRunOnIsolatedIntegrationDb();
// Opt-in negative controls: each must make the unchanged happy-path assertion
// red. They corrupt the real runner input, not the evidence after collection.
const mutant = process.env.INTEGRATION_PARALLEL_MUTANT;
if (mutant && !['swapped-session', 'swapped-token'].includes(mutant))
  throw new Error('Unknown hosted parallel mutation');
const slugs = ['echo', 'claude', 'codex'] as const;
type Row = {
  sbSlug: string;
  sbId: string;
  sessionId: string;
  studioId: string;
  cwd: string;
  marker: string;
  provider: 'claude' | 'codex';
};
type Json = Record<string, unknown>;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Json;
function checked<T extends { data: unknown; error: { message: string } | null }>({
  data,
  error,
}: T): T['data'] {
  if (error) throw new Error(error.message);
  return data;
}

describe.skipIf(!enabled)('hosted parallel turns over real HTTP and isolated DB', () => {
  const userId = randomUUID();
  const email = `parallel-${userId}@example.com`;
  const rows: Row[] = [];
  const calls: Array<{ name: string; args: Json; token: Json; context: Json }> = [];
  const ledgers = new Map<string, string>();
  const ownedPids = new Set<number>();
  const controllers = new Map<string, AbortController>();
  const codingInvocations: string[] = [];
  const executionTiers = new Map<string, string | undefined>();
  const allowlist = new Set<string>();
  let inkling: Row | undefined;
  const inklingThread = `thread:parallel-${userId}`;
  const inklingRuns: Array<ReturnType<SessionService['handleMessage']>> = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let root = '';
  let dc: DataComposer;
  let server: MCPServer;
  let service: SessionService | null = null;
  let authUid: string | undefined;
  let workspaceId: string;
  let browserToken = '';
  let serverUrl = '';
  let db: ReturnType<DataComposer['getClient']>;
  const originals = new Map<string, string | undefined>();
  const setenv = (key: string, value: string) => {
    if (!originals.has(key)) originals.set(key, process.env[key]);
    process.env[key] = value;
  };

  beforeAll(async () => {
    // The managed harness has already proved the exact DB endpoint. Nothing
    // else from an operator's shell may become this test server's authority.
    for (const key of Object.keys(process.env)) {
      if (
        [
          'PATH',
          'NODE_ENV',
          'SUPABASE_URL',
          'SUPABASE_SECRET_KEY',
          'SUPABASE_PUBLISHABLE_KEY',
        ].includes(key) ||
        key.startsWith('VITEST') ||
        key.startsWith('INTEGRATION_')
      )
        continue;
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
    root = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-parallel-')));
    for (const dir of ['home', 'tmp', 'studios', 'bin', 'files']) await mkdir(join(root, dir));
    for (const [key, value] of Object.entries({
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: '0',
      INK_PORT_BASE: '0',
      ENABLE_HEARTBEAT_SERVICE: 'false',
      ENABLE_TELEGRAM: 'false',
      ENABLE_WHATSAPP: 'false',
      ENABLE_DISCORD: 'false',
      ENABLE_SLACK: 'false',
      ENABLE_LOCAL_CRON: 'false',
      ENABLE_GRAPH_SWEEP: 'false',
      ALERT_STALENESS_SWEEP_SECONDS: '0',
      MEMORY_EMBEDDINGS_ENABLED: 'false',
      MEMORY_LLM_EXTRACTION_ENABLED: 'false',
      INK_EXECUTION_TIER: 'full',
      INK_EXECUTION_TIER_SBS: '',
      INK_EXECUTION_TIER_CLIENTS: '',
      INKLING_OWNER_TEST_USER_IDS: userId,
      JWT_SECRET: randomUUID(),
    }))
      setenv(key, value);
    const { getDataComposer } = await import('../../data/composer');
    dc = await getDataComposer();
    db = dc.getClient();
    const password = randomUUID() + 'aA1!';
    const auth = checked(await db.auth.admin.createUser({ email, password, email_confirm: true }));
    authUid = auth!.user!.id;
    checked(
      await db.from('users').insert({ id: userId, email, auth_uid: authUid, timezone: 'UTC' })
    );
    const workspace = checked(
      await db.from('workspaces').select('id').eq('user_id', userId).eq('type', 'personal').single()
    );
    workspaceId = workspace!.id;
    const login = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = checked(await login.auth.signInWithPassword({ email, password }));
    browserToken = signedIn!.session!.access_token;
    for (const sbSlug of [...slugs, 'sink']) {
      const sbId = randomUUID();
      const provider = sbSlug === 'codex' ? 'codex' : 'claude';
      checked(
        await db.from('agent_identities').insert({
          id: sbId,
          user_id: userId,
          workspace_id: workspaceId,
          agent_id: sbSlug,
          name: sbSlug,
          backend: 'ink',
          provider,
          role: 'Synthetic parallel runtime acceptance',
          soul: 'Synthetic fixture. Follow the acceptance prompt only.',
          metadata: { fixture: true, runtimeConfig: { maxTurns: 1, toolRouting: 'local' } },
        })
      );
      if (sbSlug === 'sink') continue;
      const cwd = join(root, 'studios', sbSlug);
      await mkdir(cwd);
      const studio = await dc.repositories.studios.create({
        userId,
        sbSlug,
        sbId,
        repoRoot: root,
        worktreePath: cwd,
        branch: 'fixture',
        slug: sbSlug,
      });
      const sessionId = randomUUID();
      checked(
        await db.from('sessions').insert({
          id: sessionId,
          user_id: userId,
          agent_id: sbSlug,
          sb_id: sbId,
          studio_id: studio.id,
          working_dir: cwd,
          backend: 'ink',
          lifecycle: 'idle',
          cli_attached: false,
        })
      );
      const row: Row = {
        sbSlug,
        sbId,
        sessionId,
        studioId: studio.id,
        cwd,
        marker: `ONLY_${sbSlug.toUpperCase()}_${randomUUID().replaceAll('-', '')}`,
        provider,
      };
      rows.push(row);
      await writeFile(
        join(cwd, 'parallel-fixture.json'),
        JSON.stringify({ ...row, nativeId: randomUUID() })
      );
      await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    }
    // The safe launch profile must still gate communications. Give only these
    // synthetic studios a standing inkmail grant in this fixture-owned store.
    const { ToolPolicyState } = await import('@inklabs/shared/runtime');
    const policy = new ToolPolicyState('backend');
    for (const row of rows)
      policy.persistentGrant('send_to_inbox', { scope: 'studio', id: row.studioId });
    // Positive tier control: only this synthetic studio may reach the inert bash sentinel.
    policy.persistentGrant('bash', { scope: 'studio', id: rows[2]!.studioId });
    await writeFile(join(root, 'policy.json'), JSON.stringify(policy.snapshot()));
    // Copy the token-free program into owned executable paths; never PATH-resolve
    // a provider on CI. The production adapters and spawn/parse code stay real.
    const program = await readFile(
      new URL('../../test/fixtures/hosted-parallel-provider.cjs', import.meta.url),
      'utf8'
    );
    for (const name of ['claude', 'codex'])
      await writeFile(join(root, 'bin', name), `#!${process.execPath}\n${program}`, {
        mode: 0o700,
      });
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = interval(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    const { MCPServer: Server } = await import('../../mcp/server');
    server = new Server(dc, { getSessionService: () => service });
    await server.start();
    serverUrl = `http://127.0.0.1:${server.getPort()}`;
    expect(server.getPort()).not.toBe(3001);
    const { createBoundHostedInkRunner } = await import('./hosted-ink-binding');
    const { createHostedInkEffects } = await import('./hosted-ink-effects');
    const { createSessionService } = await import('./session-service');
    const { configureLaunchRecording, supabaseLaunchStore, readBootId, reserveLaunch } =
      await import('./launched-processes');
    configureLaunchRecording({
      store: supabaseLaunchStore(db),
      serverInstance: `parallel-${userId}`,
      bootId: await readBootId(),
    });
    const recording: NonNullable<HostedInkBinding['reserveLaunch']> = async (...args) => {
      const reservation = await reserveLaunch(...args);
      return {
        ...reservation,
        spawned: (child) => {
          ownedPids.add(child.pid);
          reservation.spawned(child);
        },
      };
    };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      );
      if (![serverUrl, process.env.SUPABASE_URL].includes(target.origin))
        throw new Error('Fixture refused non-isolated HTTP destination');
      if (String(url) === `${serverUrl}/mcp` && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as {
          method?: string;
          params?: { name: string; arguments: Json };
        };
        if (body.method === 'tools/call' && body.params) {
          const headers = new Headers(init.headers);
          const token = headers.get('authorization')?.replace(/^Bearer /, '');
          const context = headers.get('x-ink-context');
          if (!token || !context) throw new Error('Missing hosted credential/context');
          const payload = JSON.parse(
            Buffer.from(token.split('.')[1]!, 'base64url').toString()
          ) as Json;
          calls.push({
            name: body.params.name,
            args: body.params.arguments,
            token: { sub: payload.sub, sessionId: payload.sessionId, sbSlug: payload.sbSlug },
            context: JSON.parse(Buffer.from(context, 'base64url').toString()) as Json,
          });
        }
      }
      return realFetch(url, init);
    });
    const runner = createBoundHostedInkRunner({
      baseEnv: { HOME: join(root, 'home'), PATH: process.env.PATH, TMPDIR: join(root, 'tmp') },
      paths: {
        inkFiles: join(root, 'files'),
        studiosRoot: join(root, 'studios'),
        tempDir: join(root, 'tmp'),
      },
      mcpUrl: `${serverUrl}/mcp`,
      resolveBinary: async (name) => {
        if (!['claude', 'codex'].includes(name)) throw new Error('Unexpected fixture executable');
        return join(root, 'bin', name);
      },
      claudeSupportsPartialMessages: async () => false,
      skillMcpServers: async () => [],
      warn() {},
      reserveLaunch: recording,
      prepareEffects: createHostedInkEffects({
        home: join(root, 'home'),
        tempDir: join(root, 'tmp'),
        inkFiles: join(root, 'files'),
        policyPath: join(root, 'policy.json'),
        mcpUrl: `${serverUrl}/mcp`,
        coding: async (input) => ({
          ports: {
            load: async () =>
              new Map([
                [
                  'bash',
                  {
                    name: 'bash',
                    description: 'Inert fixture sentinel',
                    parameters: {},
                    execute: async () => {
                      codingInvocations.push(input.sessionId);
                      throw new Error('No shell belongs in the provider twin');
                    },
                  },
                ],
              ]),
            readDocument: async () => null,
          },
          close: async () => {},
        }),
        credentials: async () => ({}),
        activeSkills: async () => [],
        publish() {},
      }),
      project() {},
      register: (id, path) => {
        ledgers.set(id, path);
      },
    });
    rows.forEach((row) => allowlist.add(row.sbId));
    service = createSessionService(db, {
      defaultWorkingDirectory: root,
      inklingsRoot: join(root, 'inklings'),
      mcpConfigPath: join(root, '.mcp.json'),
      inkMcpUrl: `${serverUrl}/mcp`,
      hostedInk: {
        // This is the host's real cancellation port, not a substitute loop.
        // The consumer row below also exercises its HTTP Stop admission.
        runner: {
          uploadMedia: runner.uploadMedia,
          run: async (...args: Parameters<IRunner['run']>) => {
            const [message, options] = args;
            const id = options.config.inkSessionId!;
            executionTiers.set(id, options.config.executionTier);
            const controller = new AbortController();
            controllers.set(id, controller);
            try {
              const config = { ...options.config };
              if (mutant && config.sbSlug === 'echo') {
                if (mutant === 'swapped-session') config.inkSessionId = rows[1]!.sessionId;
                else {
                  const { signInkAccessToken } = await import('../../auth/ink-tokens');
                  config.inkAccessToken = signInkAccessToken(
                    {
                      type: 'mcp_access',
                      sub: userId,
                      email,
                      scope: 'mcp:tools',
                      sbSlug: rows[1]!.sbSlug,
                      sbId: rows[1]!.sbId,
                      identityId: rows[1]!.sbId,
                      sessionId: rows[1]!.sessionId,
                    },
                    60
                  );
                }
              }
              return await runner.run(message, {
                ...options,
                config: {
                  ...config,
                  signal: options.config.signal
                    ? AbortSignal.any([options.config.signal, controller.signal])
                    : controller.signal,
                },
              });
            } finally {
              if (controllers.get(id) === controller) controllers.delete(id);
            }
          },
        },
        sbIds: allowlist,
      },
    });
  }, 60000);

  afterAll(async () => {
    try {
      for (const controller of controllers.values()) controller.abort();
      await vi.waitFor(() => expect(controllers.size).toBe(0), { timeout: 15000 });
      for (const timer of timers) clearInterval(timer);
      if (server) await server.shutdown();
      for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow();
      if (db) {
        await vi.waitFor(
          async () =>
            expect(
              checked(
                await db
                  .from('launched_processes')
                  .select('id')
                  .eq('server_instance', `parallel-${userId}`)
                  .not('pid', 'is', null)
                  .is('exited_at', null)
              )
            ).toEqual([]),
          { timeout: 5000 }
        );
        checked(
          await db.from('launched_processes').delete().eq('server_instance', `parallel-${userId}`)
        );
        if (inkling) {
          const { getAgentGateway } = await import('../../channels/agent-gateway');
          getAgentGateway().unregisterHandler(inkling.sbSlug);
          checked(await db.from('inbox_threads').delete().eq('workspace_id', workspaceId));
          checked(await db.from('kindle_lineage').delete().eq('child_user_id', userId));
          checked(await db.from('kindle_tokens').delete().eq('creator_user_id', userId));
          checked(await db.from('scheduled_reminders').delete().eq('user_id', userId));
        }
        // Delete identities before their owner: history triggers need that owner
        // to exist while recording the delete. The final user cascade removes history.
        checked(await db.from('agent_identities').delete().eq('user_id', userId));
        checked(await db.from('memories').delete().eq('user_id', userId));
        checked(await db.from('user_identity').delete().eq('user_id', userId));
        checked(await db.from('users').delete().eq('id', userId));
        if (authUid) checked(await db.auth.admin.deleteUser(authUid));
        for (const table of ['sessions', 'memories', 'agent_identities', 'workspaces'] as const)
          expect(checked(await db.from(table).select('id').eq('user_id', userId))).toEqual([]);
        expect(
          checked(await db.from('agent_inbox').select('id').eq('recipient_user_id', userId))
        ).toEqual([]);
      }
    } finally {
      vi.restoreAllMocks();
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (root) await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  const post = async (row: Row) => {
    const response = await fetch(`${serverUrl}/api/chat/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sbSlug: row.sbSlug,
        content: `Run the synthetic fixture for ${row.marker}.`,
      }),
      signal: AbortSignal.timeout(45000),
    });
    return { row, status: response.status, result: (await response.json()) as Json };
  };
  const adminPost = async (path: string, body: Json) => {
    const response = await fetch(`${serverUrl}/api/admin/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${browserToken}`,
        'Content-Type': 'application/json',
        'x-ink-workspace-id': workspaceId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const result = (await response.json()) as Json;
    expect({ status: response.status, result }).toMatchObject({ status: expect.any(Number) });
    if (!response.ok)
      throw new Error(`Fixture HTTP ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const launches = async (row: Row) =>
    Promise.all(
      (await readdir(row.cwd))
        .filter((file) => file.startsWith('launch-'))
        .map((file) => readJson(join(row.cwd, file)))
    );
  const release = (row: Row) => writeFile(join(row.cwd, 'release'), 'go');
  const prepareWave = async (failTool?: Row, tryBash?: Row) => {
    for (const row of rows) {
      for (const file of await readdir(row.cwd))
        if (file.startsWith('launch-') || ['counter', 'release'].includes(file))
          await rm(join(row.cwd, file));
      const fixture = await readJson(join(row.cwd, 'parallel-fixture.json'));
      await writeFile(
        join(row.cwd, 'parallel-fixture.json'),
        JSON.stringify({
          ...fixture,
          failTool: row === failTool,
          tryBash: row === tryBash,
        })
      );
    }
  };
  const barrier = () =>
    expect
      .poll(async () => (await Promise.all(rows.map(launches))).map((list) => list.length), {
        timeout: 15000,
      })
      .toEqual([1, 1, 1]);

  it('overlaps three distinct hosted sessions without mixing their scope, tools or mail', async () => {
    const running = rows.map(post);
    // Attach observers immediately: a failure before the barrier must not be an
    // unhandled rejection or be silently mistaken for a long-running child.
    const complete = Promise.all(running);
    void complete.catch(() => {});
    try {
      await barrier();
    } finally {
      await Promise.all(rows.map((row) => writeFile(join(row.cwd, 'release'), 'go')));
    }
    const results = await complete;
    for (const { row, status, result } of results) {
      expect({ status, result }).toMatchObject({
        status: 200,
        result: { success: true, sessionId: row.sessionId, response: row.marker },
      });
      const session = checked(
        await db
          .from('sessions')
          .select('agent_id, sb_id, studio_id, working_dir, lifecycle')
          .eq('id', row.sessionId)
          .single()
      );
      expect(session).toMatchObject({
        agent_id: row.sbSlug,
        sb_id: row.sbId,
        studio_id: row.studioId,
        working_dir: row.cwd,
        lifecycle: 'idle',
      });
      const own = calls.filter((call) => call.token.sessionId === row.sessionId);
      expect(own.map((call) => call.name)).toEqual(
        expect.arrayContaining(['bootstrap', 'remember', 'send_to_inbox'])
      );
      for (const call of own) {
        expect(call.token).toEqual({ sub: userId, sbSlug: row.sbSlug, sessionId: row.sessionId });
        expect(call.context).toMatchObject({
          sbSlug: row.sbSlug,
          sessionId: row.sessionId,
          studioId: row.studioId,
        });
      }
      const log = await readFile(ledgers.get(row.sessionId)!, 'utf8');
      expect(log).toContain(row.marker);
      for (const other of rows.filter((other) => other !== row)) {
        expect(log).not.toContain(other.marker);
        expect(JSON.stringify(own)).not.toContain(other.marker);
      }
      const mail = checked(
        await db
          .from('agent_inbox')
          .select('sender_agent_id, sender_sb_id, recipient_agent_id, content, metadata')
          .eq('recipient_user_id', userId)
          .eq('sender_agent_id', row.sbSlug)
      );
      expect(mail).toEqual([
        expect.objectContaining({
          sender_agent_id: row.sbSlug,
          sender_sb_id: row.sbId,
          recipient_agent_id: 'sink',
          content: row.marker,
          metadata: expect.objectContaining({
            pcp: expect.objectContaining({
              sender: expect.objectContaining({
                sbSlug: row.sbSlug,
                sessionId: row.sessionId,
                studioId: row.studioId,
              }),
            }),
          }),
        }),
      ]);
    }
    const firstLaunches = await Promise.all(
      rows.map(async (row) => {
        const files = (await readdir(row.cwd)).filter((f) => f.startsWith('launch-'));
        const launches = await Promise.all(files.map((file) => readJson(join(row.cwd, file))));
        for (const launch of launches) {
          expect(launch).toMatchObject({
            cwd: row.cwd,
            sbSlug: row.sbSlug,
            sessionId: row.sessionId,
            studioId: row.studioId,
            leakedServerCredential: false,
          });
          expect(launch.context).toMatchObject({
            sbSlug: row.sbSlug,
            sessionId: row.sessionId,
            studioId: row.studioId,
          });
        }
        return launches.sort((a, b) => Number(a.startedAt) - Number(b.startedAt))[0]!;
      })
    );
    expect(
      Math.min(...firstLaunches.map((x) => Number(x.endedAt))) -
        Math.max(...firstLaunches.map((x) => Number(x.startedAt)))
    ).toBeGreaterThan(0);
    expect(new Set(firstLaunches.map((x) => x.credentialFingerprint)).size).toBe(3);
    const sameProvider = firstLaunches.slice(0, 2);
    expect(
      sameProvider.every((x) => typeof x.mcpConfig === 'string' && x.mcpConfig.startsWith(root))
    ).toBe(true);
    expect(sameProvider[0]!.mcpConfig).not.toBe(sameProvider[1]!.mcpConfig);
  }, 90000);

  it('serializes a follow-up on its existing session while the sibling sessions overlap', async () => {
    await prepareWave();
    const first = rows.map(post);
    const complete = Promise.all(first);
    void complete.catch(() => {});
    let follow: ReturnType<typeof post> | undefined;
    try {
      await barrier();
      follow = post(rows[0]!);
      void follow.catch(() => {});
      // Prove the request reached the server queue, rather than merely sleeping
      // before inspecting a request that might not yet have arrived.
      const queues = service as unknown as { pendingQueues: Map<string, unknown[]> };
      await expect
        .poll(() => [...queues.pendingQueues.values()].reduce((n, q) => n + q.length, 0))
        .toBe(1);
      expect((await launches(rows[0]!)).length).toBe(1);
    } finally {
      await Promise.all(rows.map(release));
    }
    const results = [...(await complete), await follow!];
    for (const { row, result } of results)
      expect(result).toMatchObject({
        success: true,
        sessionId: row.sessionId,
        response: row.marker,
      });
    const childRuns = (await launches(rows[0]!)).sort(
      (a, b) => Number(a.startedAt) - Number(b.startedAt)
    );
    expect(childRuns).toHaveLength(4);
    for (let i = 1; i < childRuns.length; i++)
      expect(Number(childRuns[i]!.startedAt)).toBeGreaterThanOrEqual(
        Number(childRuns[i - 1]!.endedAt)
      );
    const row = checked(
      await db
        .from('sessions')
        .select('backend_session_id,lifecycle')
        .eq('id', rows[0]!.sessionId)
        .single()
    );
    expect(row).toEqual({ backend_session_id: rows[0]!.sessionId, lifecycle: 'idle' });
  }, 90000);

  it.each(['Stop', 'provider crash'] as const)(
    '%s is local to one hosted turn; siblings finish and the same row recovers',
    async (fault) => {
      await prepareWave();
      const victim = rows[0]!;
      const running = rows.map(post);
      const complete = Promise.all(running);
      void complete.catch(() => {});
      const { getActiveRun, listOwnedChildren } = await import('./active-runs');
      try {
        await barrier();
        const siblings = rows
          .slice(1)
          .map((r) => ({ sessionId: r.sessionId, epoch: getActiveRun(r.sessionId)?.turnEpoch }));
        const [child] = await launches(victim);
        expect(child).toBeDefined();
        if (fault === 'Stop') controllers.get(victim.sessionId)!.abort();
        else {
          const pid = Number(child!.pid);
          expect(ownedPids.has(pid)).toBe(true);
          process.kill(pid, 'SIGKILL');
        }
        const result = await running[0]!;
        expect(result.result).toMatchObject({ success: false, sessionId: victim.sessionId });
        expect(() => process.kill(Number(child!.pid), 0)).toThrow();
        expect(listOwnedChildren().filter((c) => c.sessionId === victim.sessionId)).toEqual([]);
        const failed = checked(
          await db.from('sessions').select('lifecycle').eq('id', victim.sessionId).single()
        );
        expect(failed!.lifecycle).toBe('failed');
        for (const sibling of siblings) {
          expect(getActiveRun(sibling.sessionId)?.turnEpoch).toBe(sibling.epoch);
          expect(sibling.epoch).toBeTruthy();
        }
      } finally {
        await Promise.all(rows.map(release));
      }
      const results = await complete;
      for (const { row, result } of results.slice(1))
        expect(result).toMatchObject({
          success: true,
          sessionId: row.sessionId,
          response: row.marker,
        });
      const recovered = await post(victim);
      expect(recovered.result).toMatchObject({
        success: true,
        sessionId: victim.sessionId,
        response: victim.marker,
      });
      expect(
        checked(
          await db
            .from('sessions')
            .select('backend_session_id,lifecycle')
            .eq('id', victim.sessionId)
            .single()
        )
      ).toEqual({ backend_session_id: victim.sessionId, lifecycle: 'idle' });
    },
    90000
  );

  it('a real tool error stays in its ledger while all three turns finish', async () => {
    await prepareWave(rows[0]);
    const offsets = await Promise.all(
      rows.map(async (row) => (await readFile(ledgers.get(row.sessionId)!, 'utf8')).length)
    );
    const complete = Promise.all(rows.map(post));
    void complete.catch(() => {});
    try {
      await barrier();
    } finally {
      await Promise.all(rows.map(release));
    }
    const results = await complete;
    for (const { row, result } of results)
      expect(result).toMatchObject({
        success: true,
        sessionId: row.sessionId,
        response: row.marker,
      });
    for (let i = 0; i < rows.length; i++) {
      const log = (await readFile(ledgers.get(rows[i]!.sessionId)!, 'utf8')).slice(offsets[i]);
      const entries = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Json);
      const failedCall = entries.filter(
        (e) =>
          e.type === 'local_tool_call' && e.tool === 'remember' && (e.args as Json)?.content === 17
      );
      if (i === 0) {
        expect(failedCall).toHaveLength(1);
        const failure = failedCall[0]!;
        expect(failure.status === 'error' || (failure.result as Json)?.isError === true).toBe(true);
      } else expect(failedCall).toEqual([]);
    }
  }, 90000);

  it('admits a consumer inkling alongside full-tier SBs without sharing their tool permissions', async () => {
    const awakened = await adminPost('inklings/awaken', { clientRequestId: randomUUID() });
    const identity = awakened.inkling as { id: string; sbSlug: string };
    const cwd = join(root, 'inklings', identity.id);
    await mkdir(cwd, { recursive: true });
    inkling = {
      sbId: identity.id,
      sbSlug: identity.sbSlug,
      cwd,
      studioId: 'main',
      sessionId: '',
      provider: 'claude',
      marker: `ONLY_INKLING_${randomUUID().replaceAll('-', '')}`,
    };
    const prior = checked(
      await db.from('agent_identities').select('metadata').eq('id', identity.id).single()
    );
    checked(
      await db
        .from('agent_identities')
        .update({
          backend: 'ink',
          provider: 'claude',
          metadata: {
            ...(prior!.metadata as Json),
            fixture: true,
            runtimeConfig: { maxTurns: 1, toolRouting: 'local' },
          },
        })
        .eq('id', identity.id)
    );
    allowlist.add(identity.id);
    const session = await service!.getOrCreateSession(userId, identity.sbSlug, {
      sbId: identity.id,
      threadKey: inklingThread,
    });
    inkling.sessionId = session.id;
    // Equalize standing permission so only the enforced tools profile explains
    // the refusal. Its non-promptable deny wins over this SB-scoped grant.
    const { ToolPolicyState } = await import('@inklabs/shared/runtime');
    const { inklingToolPolicyPath } = await import('../inklings/inkling-folder');
    const consumerPolicy = new ToolPolicyState('backend', {
      context: { sbSlug: inkling.sbSlug },
    });
    consumerPolicy.addPromptTool('bash');
    consumerPolicy.persistentGrant('bash', { scope: 'agent', id: inkling.sbSlug });
    expect(consumerPolicy.inspectInkTool('bash')).toEqual({
      allowed: true,
      reason: 'Tool explicitly allowed by scoped policy.',
    });
    const consumerPolicyPath = inklingToolPolicyPath(inkling.sbId, join(root, 'inklings'));
    await mkdir(join(root, 'inklings', '.tool-policy'), { recursive: true });
    await writeFile(consumerPolicyPath, JSON.stringify(consumerPolicy.snapshot()));
    await writeFile(
      join(cwd, 'parallel-fixture.json'),
      JSON.stringify({ ...inkling, nativeId: randomUUID(), threadKey: inklingThread })
    );
    const { getAgentGateway } = await import('../../channels/agent-gateway');
    const { assignThreadParticipant } = await import('./thread-assignment');
    // Explicit test routing adapter, not coverage of the production server.ts
    // dispatcher. Owner-message proof, auth, admission and execution stay real.
    getAgentGateway().registerHandler(identity.sbSlug, async (payload) => {
      expect(payload.toSbId).toBe(identity.id);
      const assignment = await assignThreadParticipant(db, {
        threadId: payload.threadId!,
        sbId: identity.id,
        candidateSessionId: session.id,
        explicitAnchor: false,
        source: 'parallel-acceptance',
      });
      expect(assignment.stampPersisted).toBe(true);
      expect(assignment.sessionId).toBe(session.id);
      if (payload.routeOnly) return;
      const turn = service!.handleMessage({
        userId,
        sbSlug: identity.sbSlug,
        channel: 'agent',
        conversationId: `trigger:${identity.sbSlug}:${inklingThread}`,
        sender: { id: payload.fromSlug, name: payload.fromSlug },
        content: inkling!.marker,
        metadata: {
          triggerType: 'agent',
          chatType: 'direct',
          threadKey: inklingThread,
          recipientSessionId: assignment.sessionId,
          triggerThreadMessageId: payload.threadMessageId,
        },
      });
      inklingRuns.push(turn);
      void turn.catch(() => {});
      await turn;
    });
    await prepareWave(undefined, rows[2]);
    const siblings = Promise.all(rows.map(post));
    void siblings.catch(() => {});
    try {
      await adminPost('threads', {
        key: inklingThread,
        recipients: [identity.sbSlug],
        content: inkling.marker,
        clientMessageId: randomUUID(),
      });
      await expect
        .poll(
          async () =>
            (await Promise.all([...rows, inkling!].map(launches))).map((list) => list.length),
          { timeout: 15000 }
        )
        .toEqual([1, 1, 1, 1]);
    } finally {
      await Promise.all([...rows, inkling].map(release));
    }
    for (const { row, result } of await siblings)
      expect(result).toMatchObject({
        success: true,
        sessionId: row.sessionId,
        response: row.marker,
      });
    expect(inklingRuns).toHaveLength(1);
    expect(await inklingRuns[0]).toMatchObject({ success: true, sessionId: session.id });
    expect(
      checked(
        await db
          .from('sessions')
          .select('studio_id,working_dir,backend')
          .eq('id', session.id)
          .single()
      )
    ).toEqual({ studio_id: null, working_dir: null, backend: 'ink' });
    const ownLaunches = await launches(inkling);
    expect(ownLaunches.length).toBeGreaterThan(0);
    for (const launch of ownLaunches)
      expect(launch).toMatchObject({
        nativeTools: '',
        cwd,
        sessionId: session.id,
        sbSlug: identity.sbSlug,
        leakedServerCredential: false,
      });
    const log = await readFile(ledgers.get(session.id)!, 'utf8');
    const entries = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Json);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'local_tool_call', tool: 'bash', status: 'blocked' }),
      ])
    );
    const refusal = entries.find((e) => e.type === 'local_tool_call' && e.tool === 'bash');
    expect(JSON.stringify(refusal)).toContain('Tool is explicitly denied by policy.');
    // The launch profile is per-run; it does not erase the stored scoped grant.
    expect(await readJson(consumerPolicyPath)).toEqual(consumerPolicy.snapshot());
    expect(codingInvocations).toEqual([rows[2]!.sessionId]);
    expect(executionTiers.get(session.id)).toBe('tools');
    for (const row of rows) expect(executionTiers.get(row.sessionId)).toBe('full');
    expect(
      calls.some((call) => call.name === 'remember' && call.token.sessionId === session.id)
    ).toBe(true);
    const mail = checked(
      await db
        .from('inbox_thread_messages')
        .select('sender_sb_id,content')
        .eq('sender_sb_id', identity.id)
    );
    expect(mail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sender_sb_id: identity.id, content: inkling.marker }),
      ])
    );
    for (const other of rows) expect(log).not.toContain(other.marker);
  }, 90000);

  // Stateful continuation: run with the preceding consumer-admission case, not in isolation.
  it('consumer HTTP Stop waits for its child exit without stopping siblings; an owner reply resumes the same row', async () => {
    expect(inkling).toBeDefined();
    const row = inkling!;
    await prepareWave();
    for (const file of await readdir(row.cwd))
      if (file.startsWith('launch-') || ['counter', 'release'].includes(file))
        await rm(join(row.cwd, file));
    const before = inklingRuns.length;
    const complete = Promise.all(rows.map(post));
    void complete.catch(() => {});
    try {
      await adminPost('threads/reply', {
        key: inklingThread,
        content: row.marker,
        clientMessageId: randomUUID(),
      });
      await expect
        .poll(
          async () => (await Promise.all([...rows, row].map(launches))).map((list) => list.length),
          { timeout: 15000 }
        )
        .toEqual([1, 1, 1, 1]);
      const { getActiveRun, listOwnedChildren } = await import('./active-runs');
      const epochs = rows.map((sibling) => getActiveRun(sibling.sessionId)?.turnEpoch);
      expect(await adminPost(`inklings/${row.sbId}/cancel`, {})).toEqual({ cancelled: true });
      expect(inklingRuns).toHaveLength(before + 1);
      expect(await inklingRuns[before]).toMatchObject({ success: false, sessionId: row.sessionId });
      for (const child of await launches(row))
        expect(() => process.kill(Number(child.pid), 0)).toThrow();
      expect(listOwnedChildren().filter((child) => child.sessionId === row.sessionId)).toEqual([]);
      expect(rows.map((sibling) => getActiveRun(sibling.sessionId)?.turnEpoch)).toEqual(epochs);
      expect(epochs.every(Boolean)).toBe(true);
    } finally {
      await Promise.all([...rows, row].map(release));
    }
    for (const { row: sibling, result } of await complete)
      expect(result).toMatchObject({
        success: true,
        sessionId: sibling.sessionId,
        response: sibling.marker,
      });
    await adminPost('threads/reply', {
      key: inklingThread,
      content: row.marker,
      clientMessageId: randomUUID(),
    });
    await expect.poll(() => inklingRuns.length).toBe(before + 2);
    expect(await inklingRuns[before + 1]).toMatchObject({
      success: true,
      sessionId: row.sessionId,
    });
  }, 90000);
});
