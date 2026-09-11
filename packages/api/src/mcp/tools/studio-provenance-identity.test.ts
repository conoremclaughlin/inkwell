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
    inbox_threads: [
      {
        id: 'thread',
        user_id: USER,
        thread_key: 'pr:probe',
        key_type: 'pr',
        status: 'open',
        created_by_agent_id: 'wren',
      },
    ],
    // wren already has a home on this thread; lumen is on it with no home yet.
    inbox_thread_participants: [
      { thread_id: 'thread', agent_id: 'wren', session_id: FOREIGN },
      { thread_id: 'thread', agent_id: 'lumen', session_id: null },
    ],
    thread_key_types: [
      {
        id: 'pr-type',
        user_id: null,
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
  const stampOf = (agentId: string) =>
    tables.inbox_thread_participants.find((r) => r.agent_id === agentId)?.session_id;
  return { repoRoot, dc, create, update, linkSession, logActivity, tables, stampOf };
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
