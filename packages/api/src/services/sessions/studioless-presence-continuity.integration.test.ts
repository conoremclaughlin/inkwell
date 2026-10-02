/**
 * A pinned presence thread keeps one session, against a real database
 * (task bd4657a0).
 *
 * The unit suite (studioless-presence-continuity.test.ts) runs the same path
 * over a fake client. This file proves what a fake cannot: that the database
 * pins the thread to the project and types it presence + reuse-only, that
 * the real repository maps working_dir and the recorded placement back off
 * the row, and that the real participant stamp, assignment CAS and turn
 * fencing hold across routeOnly, wake and spawn for two messages.
 *
 * The suite owns its identity (ensureSuiteIdentity, never `echo`), its
 * project, thread, studio and the sessions it creates, and removes exactly
 * those in afterAll. The runner is a stub that records the cwd it was given
 * and the transcript it resumed; nothing is spawned.
 *
 * Runs under the DB integration project (isolated stack):
 *   yarn test:integration:db:local studioless-presence-continuity
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import ts from 'typescript';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import { SessionService, RoutingRefusedError } from './session-service';
import { SessionRepository } from './session-repository';
import { assignThreadParticipant } from './thread-assignment';
import { decideDelivery } from './trigger-delivery.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import { ThreadKeyService } from '../thread-key/thread-key.service.js';
import type { IContextBuilder, IRunner } from './types';
import type { IActivityStream } from './session-service';

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'identity-prompt') };
});

vi.mock('../graph-executor.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, releaseGraphClaimsForSession: vi.fn(async () => 0) };
});

// The pre-spawn studio checklist would run `ink init` in the default
// directory for a studioless session.
vi.mock('../studio-complete.js', () => ({
  ensureStudioComplete: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */

function extractTriggerHandler(): string {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let arrow = '';
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'agentGateway.setDefaultHandler' &&
      node.arguments.length === 1
    ) {
      arrow = node.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!arrow) throw new Error('agentGateway.setDefaultHandler(<arrow>) not found in server.ts');
  return arrow;
}

const compiledHandler = ts.transpileModule(`const handler = ${extractTriggerHandler()};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const makeTriggerHandler = (deps: Record<string, unknown>): any =>
  new Function(
    'deps',
    `const {
       logger, dataComposer, sessionService, getUserFromContext, logInkmail,
       loadThreadDescriptor, formatThreadDescriptorLines, assignThreadParticipant,
       stampRoutingHold, clearRoutingHold, storedTriggerMedia, decideDelivery,
       RoutingRefusedError, routeResponses, triggerRetryScheduler, resolveThreadTriggerScope
     } = deps;
     ${compiledHandler}
     return handler;`
  )(deps);

describe('a pinned presence thread keeps one session (integration, task bd4657a0)', () => {
  // A slug is `^[a-z0-9][a-z0-9-]*$`, at most 32 chars, unique per workspace.
  const run = Date.now().toString(36);
  const slug = `sl${run}`;
  const threadKey = `${slug}:thread:app-build`;
  const agent = `studioless-${run}`;

  let dataComposer: DataComposer;
  let supabase: any;
  let userId: string;
  let workspaceId: string;
  let sbId: string;
  let projectId: string;
  let threadId: string;
  let otherStudioId: string;
  let projectRepo: string;
  let otherRepo: string;
  let defaultDir: string;

  const runs: Array<{ cwd: string; resumed: string | null; returned: string }> = [];
  let transcripts = 0;
  const runner: IRunner = {
    run: vi.fn(async (_message: string, options: any) => {
      const returned = options.backendSessionId ?? `transcript-${run}-${++transcripts}`;
      runs.push({
        cwd: options.config.workingDirectory,
        resumed: options.backendSessionId ?? null,
        returned,
      });
      return {
        success: true,
        backendSessionId: returned,
        responses: [],
        usage: { contextTokens: 10, inputTokens: 5, outputTokens: 5 },
        finalTextResponse: 'ok',
        toolCalls: [],
      };
    }),
  };

  const contextBuilder = {
    buildContext: vi.fn(async () => ({
      agent: { sbSlug: agent, name: agent, role: 'assistant', values: [], capabilities: [] },
      user: { id: 'user', timezone: 'UTC', contacts: {}, preferences: {} },
      temporal: {
        currentTime: '02:30',
        currentDate: '2026-10-02',
        dayOfWeek: 'Friday',
        timezone: 'UTC',
        greeting: 'Good night',
      },
      recentMemories: [],
      activeProjects: [],
    })),
    buildMinimalContext: vi.fn(async () => ({})),
    getAgentBackend: vi.fn(async () => ({ backend: 'claude', provider: null })),
  } as unknown as IContextBuilder;

  const activityStream = {
    logMessage: vi.fn(async () => ({ id: 'msg' })),
    logActivity: vi.fn(async () => ({ id: 'activity' })),
    tagActivityTaskGroup: vi.fn(async () => undefined),
  } as unknown as IActivityStream;

  let handleMessage: ReturnType<typeof vi.fn>;
  let handler: any;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    sbId = await ensureSuiteIdentity(dataComposer, fixture, agent);

    projectRepo = await mkdtemp(path.join(tmpdir(), 'studioless-project-'));
    otherRepo = await mkdtemp(path.join(tmpdir(), 'studioless-other-'));
    defaultDir = await mkdtemp(path.join(tmpdir(), 'studioless-default-'));

    const { data: project, error: projectErr } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        workspace_id: workspaceId,
        name: `Studioless ${slug}`,
        slug,
        repo_root: projectRepo,
      })
      .select('id')
      .single();
    if (projectErr) throw new Error(`project insert failed: ${projectErr.message}`);
    projectId = project.id;

    // Created after the slug is registered, so the database pins it. Nothing
    // here passes key_project or key_type: the trigger is the authority.
    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: sbId,
        title: 'studioless presence continuity probe',
      })
      .select('id, key_project, key_type')
      .single();
    if (threadErr) throw new Error(`thread insert failed: ${threadErr.message}`);
    threadId = thread.id;
    expect(thread.key_project).toBe(slug);
    expect(thread.key_type).toBe('thread');

    const { error: partErr } = await supabase.from('inbox_thread_participants').insert({
      thread_id: threadId,
      workspace_id: workspaceId,
      sb_id: sbId,
      joined_at: '2026-10-01T00:00:00Z',
    });
    if (partErr) throw new Error(`participant insert failed: ${partErr.message}`);

    // The identity's only studio lives in another repo, as Lumen's did.
    const { data: other, error: otherErr } = await supabase
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: agent,
        sb_id: sbId,
        repo_root: otherRepo,
        worktree_path: `${otherRepo}--${agent}`,
        branch: `${agent}/studio`,
        base_branch: 'main',
        status: 'active',
        ephemeral: false,
        metadata: { integrationFixture: 'studioless-presence-continuity' },
      })
      .select('id')
      .single();
    if (otherErr) throw new Error(`studio insert failed: ${otherErr.message}`);
    otherStudioId = other.id;

    const service = new SessionService(
      new SessionRepository(supabase),
      contextBuilder,
      runner,
      activityStream,
      { defaultWorkingDirectory: defaultDir, mcpConfigPath: '' },
      runner,
      supabase
    );
    handleMessage = vi.fn(service.handleMessage.bind(service));
    handler = makeTriggerHandler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataComposer: { getClient: () => supabase },
      sessionService: {
        getOrCreateSession: service.getOrCreateSession.bind(service),
        getSession: service.getSession.bind(service),
        endSession: service.endSession.bind(service),
        sessionAllowedForThread: service.sessionAllowedForThread.bind(service),
        handleMessage,
      },
      getUserFromContext: () => ({ userId }),
      resolveThreadTriggerScope: vi.fn(async () => ({
        userId,
        recipientSbId: sbId,
        threadWorkspaceId: workspaceId,
      })),
      logInkmail: vi.fn(async () => undefined),
      loadThreadDescriptor: vi.fn(async () => null),
      formatThreadDescriptorLines: vi.fn(() => [] as string[]),
      assignThreadParticipant,
      stampRoutingHold: vi.fn(async () => undefined),
      clearRoutingHold: vi.fn(async () => undefined),
      storedTriggerMedia: vi.fn(async () => []),
      decideDelivery,
      RoutingRefusedError,
      routeResponses: vi.fn(async () => undefined),
      triggerRetryScheduler: { cancelFor: vi.fn() },
    });
  });

  afterAll(async () => {
    // Suite-owned cleanup only: exactly the rows this suite created.
    if (sbId) await supabase.from('sessions').delete().eq('sb_id', sbId);
    if (threadId) {
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    if (otherStudioId) await supabase.from('studios').delete().eq('id', otherStudioId);
    if (projectId) await supabase.from('projects').delete().eq('id', projectId);
    if (sbId) await supabase.from('agent_identities').delete().eq('id', sbId);
    for (const dir of [projectRepo, otherRepo, defaultDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  const stamp = async (): Promise<string | null> => {
    const { data } = await supabase
      .from('inbox_thread_participants')
      .select('session_id')
      .eq('thread_id', threadId)
      .eq('sb_id', sbId)
      .single();
    return data?.session_id ?? null;
  };

  const rows = async (): Promise<any[]> => {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, studio_id, working_dir, backend_session_id, ended_at, metadata')
      .eq('sb_id', sbId)
      .eq('thread_key', threadKey)
      .order('started_at', { ascending: true });
    if (error) throw new Error(`sessions read failed: ${error.message}`);
    return data ?? [];
  };

  const dispatch = (extra: Record<string, unknown>) =>
    handler({
      toSlug: agent,
      toSbId: sbId,
      fromSlug: 'wren',
      triggerType: 'message',
      priority: 'normal',
      summary: 'probe',
      threadId,
      threadKey,
      ...extra,
    }).then(
      () => null,
      (e: unknown) => e
    );

  /** One send_to_inbox: routeOnly assignment, then the wake, on the inferred stamp. */
  async function send(): Promise<string> {
    const inferred = (await stamp()) ?? undefined;
    expect(await dispatch({ routeOnly: true, recipientSessionId: inferred })).toBeNull();
    expect(await dispatch({ recipientSessionId: inferred })).toBeNull();
    const result = await handleMessage.mock.results.at(-1)!.value;
    expect(result.success).toBe(true);
    return result.sessionId as string;
  }

  it('the database types the thread presence + reuse-only', async () => {
    const behavior = await new ThreadKeyService(supabase).typeBehavior(workspaceId, 'thread');
    expect(behavior).toMatchObject({ writeIntent: 'presence', studioPolicy: 'reuse-only' });
  });

  it('two messages: one row, the same stamp, and the second turn resumes the first transcript', async () => {
    const first = await send();
    let all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first);
    expect(all[0].studio_id).toBeNull();
    expect(all[0].metadata.routing_decision.placement).toEqual({
      kind: 'studioless-presence',
      project: slug,
      repoRoot: projectRepo,
    });
    expect(await stamp()).toBe(first);
    expect(runs.at(-1)!.cwd).toBe(defaultDir);
    expect(all[0].backend_session_id).toBe(runs.at(-1)!.returned);
    const transcript = runs.at(-1)!.returned;

    const second = await send();
    all = await rows();
    expect(all).toHaveLength(1);
    expect(second).toBe(first);
    expect(await stamp()).toBe(first);
    expect(runs.at(-1)).toEqual({ cwd: defaultDir, resumed: transcript, returned: transcript });
  });

  it('a hook-reported default directory keeps continuity; a wrong-repo one does not', async () => {
    const [current] = await rows();

    // What a Claude hook writes for a spawned studioless session.
    await supabase.from('sessions').update({ working_dir: defaultDir }).eq('id', current.id);
    expect(await send()).toBe(current.id);
    expect(await rows()).toHaveLength(1);

    // A terminal resumed it in another repo: it is no longer evidence.
    await supabase
      .from('sessions')
      .update({ working_dir: path.join(otherRepo, 'packages') })
      .eq('id', current.id);
    const successor = await send();
    expect(successor).not.toBe(current.id);
    expect(await stamp()).toBe(successor);
    const all = await rows();
    expect(all.filter((r) => r.ended_at === null)).toHaveLength(2);
    expect(runs.at(-1)!.resumed).toBeNull();

    // The successor continues on the next message.
    const transcript = runs.at(-1)!.returned;
    expect(await send()).toBe(successor);
    expect(runs.at(-1)!.resumed).toBe(transcript);
    expect(await rows()).toHaveLength(2);
  });

  it('a working_dir inside the project repo is evidence on its own', async () => {
    // A row with no recorded placement, which reports running inside the
    // project's repo, made the newest and stamped.
    const { data: inserted, error } = await supabase
      .from('sessions')
      .insert({
        user_id: userId,
        agent_id: agent,
        sb_id: sbId,
        thread_key: threadKey,
        backend: 'claude-code',
        lifecycle: 'idle',
        status: 'active',
        backend_session_id: `project-transcript-${run}`,
        working_dir: path.join(projectRepo, 'app'),
        metadata: {},
      })
      .select('id')
      .single();
    if (error) throw new Error(`session insert failed: ${error.message}`);
    // Through the one sanctioned stamp writer, as an explicit retarget.
    const moved = await assignThreadParticipant(supabase, {
      threadId,
      sbId,
      candidateSessionId: inserted.id,
      explicitAnchor: true,
      source: 'studioless-presence-continuity.integration',
    });
    expect(moved).toMatchObject({ sessionId: inserted.id, stampPersisted: true });

    const before = (await rows()).length;
    expect(await send()).toBe(inserted.id);
    expect(runs.at(-1)!.resumed).toBe(`project-transcript-${run}`);
    expect(await rows()).toHaveLength(before);
  });
});
