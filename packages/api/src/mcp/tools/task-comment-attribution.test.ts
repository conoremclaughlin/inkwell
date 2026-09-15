/**
 * Task comment attribution — the slug -> sb_id half.
 *
 * This path had its own copy of the slug lookup, which differed from the shared
 * resolver in ways that silently dropped attribution. These tests drive the
 * handler, so they fail if that copy ever comes back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env', async () => ({
  env: {
    ...(await import('../../test/fake-env')).fakeEnv,
    ENFORCE_IDENTITY_PINNING: 'false',
  },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveUser: vi.fn(async () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } })),
}));

import { handleAddTaskComment } from './task-handlers';
import { runWithRequestContext } from '../../utils/request-context';
import { makeFakeSupabase, type Row } from '../../services/sessions/fake-supabase';

const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SB_IN_A = '1111aaaa-1111-4111-8111-111111111111';
const SB_IN_B = '2222bbbb-2222-4222-8222-222222222222';
const SB_LEGACY = '3333cccc-3333-4333-8333-333333333333';

function setup(identities: Row[]) {
  const tables: Record<string, Row[]> = {
    agent_identities: identities,
    task_comments: [],
  };
  const supabase = makeFakeSupabase(tables);
  const dc = {
    getClient: () => supabase,
    repositories: { tasks: { findById: vi.fn(async () => ({ id: TASK, user_id: USER })) } },
  };
  return { tables, dc };
}

const addComment = (dc: unknown, workspaceId?: string) =>
  runWithRequestContext({ userId: USER, ...(workspaceId ? { workspaceId } : {}) }, () =>
    handleAddTaskComment(
      { taskId: TASK, content: 'looks good', sbSlug: 'wren' } as never,
      dc as never
    )
  );

const writtenComment = (tables: Record<string, Row[]>) => tables.task_comments[0];

beforeEach(() => vi.clearAllMocks());

describe('add_task_comment attribution', () => {
  it('attributes an identity that has not been backfilled with a workspace yet', async () => {
    const f = setup([{ id: SB_LEGACY, user_id: USER, agent_id: 'wren', workspace_id: null }]);

    const result = await addComment(f.dc, WS_A);

    expect(JSON.parse(result.content[0].text).success).toBe(true);
    // The copy this replaced filtered on workspace_id = WS_A, found nothing,
    // and wrote the comment with a null sb_id — attribution lost, silently.
    expect(writtenComment(f.tables).created_by_sb_id).toBe(SB_LEGACY);
    expect(writtenComment(f.tables).created_by_sb_id).not.toBeNull();
  });

  it('picks the identity in the request workspace when a slug is shared', async () => {
    const shared = [
      { id: SB_IN_A, user_id: USER, agent_id: 'wren', workspace_id: WS_A },
      { id: SB_IN_B, user_id: USER, agent_id: 'wren', workspace_id: WS_B },
    ];

    const inA = setup(shared);
    await addComment(inA.dc, WS_A);
    expect(writtenComment(inA.tables).created_by_sb_id).toBe(SB_IN_A);

    const inB = setup(shared);
    await addComment(inB.dc, WS_B);
    expect(writtenComment(inB.tables).created_by_sb_id).toBe(SB_IN_B);
  });

  it('writes the comment with no sb_id rather than guessing when the slug is ambiguous', async () => {
    const f = setup([
      { id: SB_IN_A, user_id: USER, agent_id: 'wren', workspace_id: WS_A },
      { id: SB_IN_B, user_id: USER, agent_id: 'wren', workspace_id: WS_B },
    ]);

    // No workspace in context: nothing narrows the slug to one SB.
    const result = await addComment(f.dc);

    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const comment = writtenComment(f.tables);
    expect(comment.created_by_sb_id).toBeNull();
    expect(comment.created_by_sb_id).not.toBe(SB_IN_A);
    expect(comment.created_by_sb_id).not.toBe(SB_IN_B);
    // The slug is still recorded — the comment is attributed as far as it honestly can be.
    expect(comment.created_by_agent_id).toBe('wren');
  });

  it('resolves normally when there is exactly one identity', async () => {
    const f = setup([{ id: SB_IN_A, user_id: USER, agent_id: 'wren', workspace_id: WS_A }]);

    await addComment(f.dc, WS_A);

    expect(writtenComment(f.tables).created_by_sb_id).toBe(SB_IN_A);
  });
});
