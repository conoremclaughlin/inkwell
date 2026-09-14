/**
 * Lumen's PR #605 round-2 probe, turned from a defect assertion into the
 * regression: the acting identity is the credential's, not the typed agentId.
 *
 * A signed Lumen request typed as `agentId: "wren"`, naming Lumen's OWN valid
 * session, passed session authorization (the session is Lumen's) and then ran
 * the real thread binding under wren's name: wren's participant row on the
 * thread was overwritten with Lumen's session, the lease named wren, and the
 * log line said agentId=wren next to Lumen's sbId. This file drives the real
 * findOrCreateThread / assignThreadParticipant path against the fake Supabase
 * so the stamp itself is what is asserted, not a mock's arguments.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { handleCreateStudio, handleAdoptStudio } from './studio-handlers';
import { runWithRequestContext } from '../../utils/request-context';
import { StudiosRepository } from '../../data/repositories/studios.repository';
import { makeFakeSupabase, type Row } from '../../services/sessions/fake-supabase';

vi.mock('../../services/studio-settings', () => ({ ensureStudioSettings: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OWN = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const STUDIO = '44444444-4444-4444-8444-444444444444';
const SB = '55555555-5555-4555-8555-555555555555';
const ORIGINAL = '66666666-6666-4666-8666-666666666666';
// The same-slug twin identity of the round-3 probe below; stampOf skips it.
const TWIN_ID = '77777777-7777-4777-8777-777777777777';
const roots: string[] = [];

/** Lumen's signed credential, running in Lumen's own session. */
const lumenContext = {
  userId: USER,
  agentId: 'lumen',
  sbId: SB,
  sessionId: OWN,
  agentTokenBound: true,
  tokenAgentId: 'lumen',
  tokenSbId: SB,
  tokenSessionId: OWN,
  timestamp: new Date(),
};

function setup() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'studio-identity-')));
  roots.push(base);
  const repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  const now = new Date().toISOString();
  const own = {
    id: OWN,
    userId: USER,
    agentId: 'lumen',
    sbId: SB,
    contactId: null,
    studioId: ORIGINAL,
    threadKey: 'thread:original',
    endedAt: null,
    status: 'active',
  };
  const foreign = { ...own, id: FOREIGN, sbId: 'other-sb', agentId: 'wren' };
  const lease = {
    sessionId: OWN,
    agentId: 'lumen',
    sbId: SB,
    threadKey: 'thread:original',
    threadKeys: ['thread:original'],
    acquiredAt: now,
    heartbeatAt: now,
  };
  const tables: Record<string, Row[]> = {
    studios: [
      {
        id: ORIGINAL,
        user_id: USER,
        agent_id: 'lumen',
        sb_id: SB,
        status: 'active',
        worktree_path: repoRoot,
        repo_root: repoRoot,
        lease,
      },
    ],
    sessions: [
      {
        id: OWN,
        user_id: USER,
        agent_id: 'lumen',
        sb_id: SB,
        studio_id: ORIGINAL,
        ended_at: null,
        cli_turn_at: now,
      },
    ],
    agent_identities: [
      { id: SB, user_id: USER, agent_id: 'lumen', workspace_id: 'ws' },
      { id: 'other-sb', user_id: USER, agent_id: 'wren', workspace_id: 'ws' },
    ],
    workspace_members: [{ workspace_id: 'ws', user_id: USER, role: 'member' }],
    inbox_threads: [
      {
        id: 'thread',
        workspace_id: 'ws',
        thread_key: 'pr:probe',
        key_type: 'pr',
        status: 'open',
        created_by_kind: 'sb',
        created_by_sb_id: 'other-sb',
      },
    ],
    // wren already has a home on this thread; lumen is on it with no home yet.
    // Participant rows are keyed by identity (spec inkmail-thread-scope §3).
    inbox_thread_participants: [
      { thread_id: 'thread', workspace_id: 'ws', sb_id: 'other-sb', session_id: FOREIGN },
      { thread_id: 'thread', workspace_id: 'ws', sb_id: SB, session_id: null },
    ],
    thread_key_types: [
      {
        id: 'pr-type',
        workspace_id: null,
        type: 'pr',
        write_intent: 'write',
        studio_policy: 'provision',
        created_at: now,
        updated_at: now,
      },
    ],
  };
  const supabase = makeFakeSupabase(tables);
  let studio: Record<string, unknown> = {
    id: STUDIO,
    userId: USER,
    agentId: 'lumen',
    branch: 'lumen/feat/test',
    worktreePath: repoRoot,
    routePatterns: [],
    status: 'active',
  };
  const create = vi.fn(async (input: Record<string, unknown>) => {
    studio = { ...studio, ...input };
    mkdirSync(input.worktreePath as string);
    tables.studios.push({
      id: STUDIO,
      user_id: USER,
      agent_id: input.agentId,
      sb_id: input.agentId === 'lumen' ? SB : 'other-sb',
      status: 'active',
      session_id: input.sessionId,
      worktree_path: input.worktreePath,
      repo_root: repoRoot,
      route_patterns: [],
      lease: null,
    });
    return studio;
  });
  const update = vi.fn(async (_id: string, input: Record<string, unknown>) => {
    studio = { ...studio, ...input };
    Object.assign(tables.studios.find((r) => r.id === STUDIO) ?? {}, {
      route_patterns: input.routePatterns,
      thread_key: input.threadKey,
    });
    return studio;
  });
  const logActivity = vi.fn(async () => ({}));
  const getSession = vi.fn(async (id: string) => (id === OWN ? own : foreign));
  const linkSession = vi.fn(async (_id: string, sessionId: string) => ({ ...studio, sessionId }));
  const dc = {
    getClient: () => supabase,
    repositories: {
      users: { findById: vi.fn(async () => ({ id: USER })) },
      memory: { getSession, findOwnedActiveSessions: vi.fn(async () => [own]) },
      studios: { create, update, findById: vi.fn(async () => studio), linkSession },
      activityStream: { logActivity },
    },
  };
  const sbOf = (agentId: string) =>
    tables.agent_identities.find((r) => r.agent_id === agentId && r.id !== TWIN_ID)?.id;
  const stampOf = (agentId: string) =>
    tables.inbox_thread_participants.find((r) => r.sb_id === sbOf(agentId))?.session_id;
  return { repoRoot, dc, create, update, linkSession, logActivity, tables, stampOf, supabase };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the acting identity is the credential's, not the typed agentId (Lumen, PR #605 r2)", () => {
  it.each(['create', 'adopt'] as const)(
    "%s typed as wren on Lumen's credential is refused, and wren's thread home is untouched",
    async (operation) => {
      const f = setup();
      const result = await runWithRequestContext(lumenContext, () =>
        operation === 'create'
          ? handleCreateStudio(
              {
                agentId: 'wren',
                repoRoot: f.repoRoot,
                slug: 'probe',
                skipGitOperations: true,
                sessionId: OWN,
                threadKey: 'pr:probe',
              },
              f.dc as never
            )
          : handleAdoptStudio(
              { agentId: 'wren', studioId: STUDIO, sessionId: OWN, threadKey: 'pr:probe' },
              f.dc as never
            )
      );
      const payload = JSON.parse(result.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain('agentId wren is not the authenticated identity (lumen)');
      expect(f.stampOf('wren')).toBe(FOREIGN);
      expect(f.stampOf('lumen')).toBeNull();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.linkSession).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.logActivity).not.toHaveBeenCalled();
    }
  );

  it("acting as itself, Lumen's home lands on Lumen's row, wren's row is untouched, and the log names one identity", async () => {
    const f = setup();
    const result = await runWithRequestContext(lumenContext, () =>
      handleCreateStudio(
        {
          agentId: 'lumen',
          repoRoot: f.repoRoot,
          slug: 'probe',
          skipGitOperations: true,
          sessionId: OWN,
          threadKey: 'pr:probe',
        },
        f.dc as never
      )
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      success: true,
      routing: { home: { sessionId: OWN, persisted: true } },
      lease: { acquired: true, threadKey: 'pr:probe' },
    });
    expect(f.stampOf('lumen')).toBe(OWN);
    expect(f.stampOf('wren')).toBe(FOREIGN);
    expect(f.logActivity).toHaveBeenCalledTimes(1);
    expect(f.logActivity.mock.calls[0][0]).toMatchObject({
      agentId: 'lumen',
      sbId: SB,
      sessionId: OWN,
    });
  });
});

/**
 * Lumen's round-3 probe, inverted. Two identities wear the slug "lumen"; the
 * twin is newer, so resolving the slug answers the twin. The credential names
 * SB. Everything a studio operation writes must name SB, and ground owned by
 * the twin is not the caller's to adopt. Real StudiosRepository and real lease
 * acquire over the fake Supabase — nothing between the handler and the rows
 * is mocked.
 */
describe('the canonical identity the credential carries is the one written (Lumen, PR #605 r3)', () => {
  const TWIN = TWIN_ID;

  function withRealStudios(f: ReturnType<typeof setup>) {
    const older = f.tables.agent_identities.find((r) => r.id === SB);
    if (older) older.updated_at = '2026-09-01T00:00:00Z';
    f.tables.agent_identities.push({
      id: TWIN,
      user_id: USER,
      agent_id: 'lumen',
      workspace_id: 'other-workspace',
      updated_at: '2026-09-02T00:00:00Z',
    });
    // The fake table has no generated defaults; supply them at the boundary.
    const rawFrom = f.supabase.from.bind(f.supabase);
    f.supabase.from = ((table: string) => {
      const builder = rawFrom(table);
      if (table !== 'studios') return builder;
      return {
        ...builder,
        insert: (row: Row) =>
          builder.insert({
            ...row,
            id: STUDIO,
            status: 'active',
            lease: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
      };
    }) as typeof f.supabase.from;
    f.dc.repositories.studios = new StudiosRepository(f.supabase as never) as never;
    const worktreePath = path.join(path.dirname(f.repoRoot), 'repo--probe');
    mkdirSync(worktreePath);
    return worktreePath;
  }

  it("create writes the credential's id on the row and the lease, not the newer same-slug identity", async () => {
    const f = setup();
    withRealStudios(f);
    const result = await runWithRequestContext(lumenContext, () =>
      handleCreateStudio(
        {
          agentId: 'lumen',
          repoRoot: f.repoRoot,
          slug: 'probe',
          skipGitOperations: true,
          sessionId: OWN,
          threadKey: 'pr:probe',
        },
        f.dc as never
      )
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      lease: { acquired: true },
    });
    const row = f.tables.studios.find((r) => r.id === STUDIO);
    expect(row?.sb_id).toBe(SB);
    expect(row?.session_id).toBe(OWN);
    expect(row?.lease).toMatchObject({ sbId: SB, sessionId: OWN, agentId: 'lumen' });
    expect(f.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'lumen', sbId: SB, sessionId: OWN })
    );
  });

  it('adopt refuses ground owned by the same-slug twin before linking, leasing, or logging', async () => {
    const f = setup();
    const worktreePath = withRealStudios(f);
    f.tables.studios.push({
      id: STUDIO,
      user_id: USER,
      agent_id: 'lumen',
      sb_id: TWIN,
      session_id: null,
      worktree_path: worktreePath,
      repo_root: f.repoRoot,
      branch: 'lumen/feat/probe',
      status: 'active',
      route_patterns: [],
      lease: null,
    });
    const result = await runWithRequestContext(lumenContext, () =>
      handleAdoptStudio(
        { agentId: 'lumen', studioId: STUDIO, sessionId: OWN, threadKey: 'pr:probe' },
        f.dc as never
      )
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain(`belongs to identity ${TWIN} (lumen), not to lumen (${SB})`);
    const row = f.tables.studios.find((r) => r.id === STUDIO);
    expect(row?.session_id).toBeNull();
    expect(row?.lease).toBeNull();
    expect(row?.route_patterns).toEqual([]);
    expect(f.stampOf('lumen')).toBeNull();
    expect(f.logActivity).not.toHaveBeenCalled();
  });
});
