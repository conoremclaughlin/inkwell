/**
 * The studio checklist runs before EVERY spawn, whatever the runner (task
 * 2841c7a9).
 *
 * Until 2026-09-29 the pre-spawn completion lived in the Claude runner alone.
 * A Codex-backed SB's studio was therefore never repaired by the server —
 * Lumen's Inktrade home went five days without an identity file while its
 * hooks booked every session to the root studio. The call now sits in the
 * session service, in front of the runner dispatch, so the runner chosen is
 * irrelevant to whether the checklist is read.
 *
 * The harness is the one from `refused-resume-owner-state.test.ts`. The
 * completion module is mocked at the boundary session-service imports it
 * through; what is pinned here is that the service calls it, for a Codex
 * spawn and for a Claude one, before the runner runs, with the studio's
 * working directory and row, and that the owner it offers is the ROW's SB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionService } from './session-service.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import type { Session, ISessionRepository, IContextBuilder, IRunner } from './types.js';
import type { IActivityStream } from './session-service.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt') };
});

vi.mock('../graph-executor.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, releaseGraphClaimsForSession: vi.fn(async () => 0) };
});

/** Every call the service makes, in order with the runner's, so "before" is measured. */
const order = vi.hoisted(() => ({ events: [] as string[] }));
const completion = vi.hoisted(() => ({
  calls: [] as Array<{ worktreePath: string; options: Record<string, unknown> }>,
}));
vi.mock('../studio-complete.js', () => ({
  ensureStudioComplete: vi.fn(async (worktreePath: string, options: Record<string, unknown>) => {
    order.events.push('complete');
    completion.calls.push({ worktreePath, options });
    return { ok: true, complete: true, missing: [] };
  }),
}));

let worktree: string;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-456',
    sbSlug: 'lumen',
    studioId: 'studio-1',
    backendSessionId: null,
    type: 'primary',
    lifecycle: 'idle',
    status: 'active',
    cliAttached: false,
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 0,
    tokenCount: 0,
    backend: 'codex-cli',
    model: null,
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    turnEpoch: 'epoch-1',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Session;
}

function makeStatefulRepo(initial: Session) {
  const state = { row: initial };
  const merge = (updates: Record<string, unknown>) => {
    state.row = { ...state.row, ...updates } as Session;
    return state.row;
  };
  const repo = {
    findById: vi.fn(async () => state.row),
    findByUserAndAgent: vi.fn(async () => state.row),
    findByUser: vi.fn(async () => [state.row]),
    create: vi.fn(async () => state.row),
    update: vi.fn(async (_id: string, updates: Record<string, unknown>) => merge(updates)),
    updateIfTurnEpoch: vi.fn(
      async (_id: string, epoch: string, updates: Record<string, unknown>) => {
        if ((state.row as { turnEpoch?: string }).turnEpoch !== epoch) return null;
        return merge(updates);
      }
    ),
    updateTokenUsage: vi.fn(async () => undefined),
    markCompacted: vi.fn(async () => undefined),
    tryAcquireCompactionLock: vi.fn(async () => true),
    releaseCompactionLock: vi.fn(async () => undefined),
  };
  return { state, repo: repo as unknown as ISessionRepository };
}

const contextBuilder = (backend: string) =>
  ({
    buildContext: vi.fn(async () => ({
      agent: {
        sbSlug: 'lumen',
        name: 'Lumen',
        role: 'assistant',
        values: [],
        capabilities: [],
        relationships: {},
      },
      user: { id: 'user-456', timezone: 'UTC', contacts: {}, preferences: {} },
      temporal: {
        currentTime: '00:51',
        currentDate: '2026-09-29',
        dayOfWeek: 'Tuesday',
        timezone: 'UTC',
        greeting: 'Good evening',
      },
      recentMemories: [],
      activeProjects: [],
    })),
    buildMinimalContext: vi.fn(async () => ({})),
    getAgentBackend: vi.fn(async () => ({ backend, provider: null })),
  }) as unknown as IContextBuilder;

const activityStream = {
  logMessage: vi.fn(async () => ({ id: 'msg-1' })),
  logActivity: vi.fn(async () => ({ id: 'activity-1' })),
  tagActivityTaskGroup: vi.fn(async () => undefined),
} as unknown as IActivityStream;

function succeedingRunner(name: string): IRunner {
  return {
    run: vi.fn(async () => {
      order.events.push(`run:${name}`);
      return {
        success: true,
        backendSessionId: `${name}-thread`,
        responses: [],
        usage: { contextTokens: 10, inputTokens: 5, outputTokens: 5 },
        finalTextResponse: 'ok',
        toolCalls: [],
      };
    }),
  };
}

/** A service whose session sits in studio-1, a row owned by `owner` on a real directory. */
function makeService(session: Session, owner: string, row: Row = {}) {
  const { repo } = makeStatefulRepo(session);
  const tables: Record<string, Row[]> = {
    sessions: [{ id: session.id, user_id: 'user-456', studio_id: session.studioId }],
    studios: [
      {
        id: 'studio-1',
        user_id: 'user-456',
        agent_id: owner,
        worktree_path: worktree,
        status: 'active',
        lease: null,
        ...row,
      },
    ],
    agent_identities: [],
    inbox_threads: [],
    studio_lease_events: [],
    tasks: [],
  };
  const claude = succeedingRunner('claude');
  const codex = succeedingRunner('codex');
  const service = new SessionService(
    repo,
    contextBuilder(session.backend === 'codex-cli' ? 'codex' : 'claude'),
    claude,
    activityStream,
    {
      defaultWorkingDirectory: '/test',
      mcpConfigPath: '/test/.mcp.json',
      compactionThreshold: 150000,
    },
    codex,
    makeFakeSupabase(tables) as never
  );
  const send = () =>
    service.handleMessage({
      userId: 'user-456',
      sbSlug: 'lumen',
      channel: 'agent',
      conversationId: 'trigger:lumen:thread:studio-checklist',
      sender: { id: 'wren', name: 'Wren' },
      content: 'Review request',
      metadata: {},
    } as never);
  return { service, send, claude, codex };
}

describe('the studio checklist runs before every spawn, whatever the runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveRuns();
    resetPendingFinalizations();
    order.events.length = 0;
    completion.calls.length = 0;
    // The studio row names a REAL directory: resolveWorkingDirectory falls
    // back to the default for a path that does not exist.
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'studio-1-')));
  });
  afterEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a Codex spawn reads the checklist first, with the studio working directory and row', async () => {
    const { send, codex, claude } = makeService(makeSession(), 'lumen');
    const result = await send();
    expect(result.success).toBe(true);
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(claude.run).not.toHaveBeenCalled();
    expect(completion.calls).toHaveLength(1);
    expect(completion.calls[0].worktreePath).toBe(worktree);
    expect(completion.calls[0].options).toMatchObject({ sbSlug: 'lumen', studioId: 'studio-1' });
    expect(order.events).toEqual(['complete', 'run:codex']);
  });

  it('a Claude spawn reads it too: the seam is the service, not a runner', async () => {
    const { send, claude } = makeService(makeSession({ backend: 'claude-code' }), 'lumen');
    await send();
    expect(claude.run).toHaveBeenCalledTimes(1);
    expect(order.events).toEqual(['complete', 'run:claude']);
  });

  it("the owner offered for a missing identity file is the studio row's SB, not the session's", async () => {
    const { send } = makeService(makeSession(), 'aster');
    await send();
    const owner = completion.calls[0]?.options.owner as (() => Promise<string | null>) | undefined;
    expect(typeof owner).toBe('function');
    expect(await owner!()).toBe('aster');
  });

  it("the permission profile offered is the ROW's: a detached checkout is a reviewer, a branch studio a builder", async () => {
    const profileOf = async (row: Row) => {
      completion.calls.length = 0;
      const { send } = makeService(makeSession(), 'lumen', row);
      await send();
      const lookup = completion.calls[0]?.options.profile as (() => Promise<string>) | undefined;
      expect(typeof lookup).toBe('function');
      return lookup!();
    };
    expect(await profileOf({ branch: 'detached:origin/pr/7' })).toBe('reviewer');
    expect(
      await profileOf({
        branch: 'lumen/eph/pr-7',
        metadata: { checkout: { mode: 'detached', ref: 'origin/pr/7', commit: 'abc' } },
      })
    ).toBe('reviewer');
    expect(await profileOf({ branch: 'lumen/feat/x', metadata: {} })).toBe('builder');
  });

  it('a session with no studio row is offered no profile: no permissions, never a guessed builder', async () => {
    const { send } = makeService(makeSession({ studioId: null }), 'lumen');
    await send();
    const lookup = completion.calls[0].options.profile as () => Promise<string | undefined>;
    expect(await lookup()).toBeUndefined();
  });

  it('a session with no studio row offers no owner and no studio id', async () => {
    const { send } = makeService(makeSession({ studioId: null }), 'lumen');
    await send();
    expect(completion.calls).toHaveLength(1);
    expect(completion.calls[0].worktreePath).toBe('/test');
    expect(completion.calls[0].options).not.toHaveProperty('studioId');
    const owner = completion.calls[0].options.owner as () => Promise<string | null>;
    expect(await owner()).toBeNull();
  });
});

describe('a Claude launch in a studio is given its profile from the row (design v5, phase A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveRuns();
    resetPendingFinalizations();
    order.events.length = 0;
    completion.calls.length = 0;
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'studio-1-')));
  });
  afterEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
    rmSync(worktree, { recursive: true, force: true });
  });

  const launchConfig = (runner: { run: ReturnType<typeof vi.fn> }) =>
    (runner.run.mock.calls[0]?.[1] as { config: Record<string, unknown> } | undefined)?.config;

  it("the row's profile, owner and main checkout reach the Claude runner", async () => {
    const { send, claude } = makeService(makeSession({ backend: 'claude-code' }), 'lumen', {
      branch: 'detached:origin/pr/7',
      repo_root: '/repo',
    });
    await send();
    expect(launchConfig(claude as never)?.launchPermissions).toEqual({
      profile: 'reviewer',
      owner: 'lumen',
      mainRoot: '/repo',
    });
  });

  it('the root (home) studio is not given one: root profiles are phase B, and the launch goes ahead', async () => {
    // resolveMainStudio gives a root-repo session a real studio row whose
    // worktree is the repo root (review 44db8c0c, P2 1).
    const { send, claude } = makeService(makeSession({ backend: 'claude-code' }), 'lumen', {
      branch: 'main',
      repo_root: worktree,
    });
    const result = await send();
    expect(result.success).toBe(true);
    expect(claude.run).toHaveBeenCalledTimes(1);
    expect(launchConfig(claude as never)).not.toHaveProperty('launchPermissions');
  });

  it('a Codex launch is not given one: --settings is a Claude Code flag', async () => {
    const { send, codex } = makeService(makeSession(), 'lumen', { branch: 'lumen/feat/x' });
    await send();
    expect(launchConfig(codex as never)).not.toHaveProperty('launchPermissions');
  });

  it('a studio whose row is gone fails the Claude launch before the runner runs', async () => {
    const { send, claude } = makeService(
      makeSession({ backend: 'claude-code', studioId: 'studio-gone' }),
      'lumen'
    );
    const result = await send();
    expect(result.success).toBe(false);
    expect(String((result as { error?: unknown }).error)).toMatch(/Launch refused/);
    expect(claude.run).not.toHaveBeenCalled();
  });
});
