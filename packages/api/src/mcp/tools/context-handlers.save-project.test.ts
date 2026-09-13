/**
 * save_project since the cutover (spec inkmail-thread-scope §1b): a project
 * lives in the caller's workspace, and the slug reservation is checked
 * against that workspace's thread-key types — not the owner's. Runs the
 * real handler and the real ProjectsRepository over the table-backed fake;
 * only the user resolver and the request context are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSupabase } from '../../services/sessions/fake-supabase';
import { ProjectsRepository } from '../../data/repositories/projects.repository';
import { handleSaveProject } from './context-handlers';

const ctx = vi.hoisted(() => ({ sbId: undefined as string | undefined }));

vi.mock('../../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn().mockResolvedValue({ user: { id: 'user-a' }, resolvedBy: 'userId' }),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/request-context', async (original) => ({
  ...(await original<typeof import('../../utils/request-context')>()),
  getRequestContext: vi.fn(() => ({ userId: 'user-a', sessionId: 'session-a', sbId: ctx.sbId })),
  getSessionContext: vi.fn().mockReturnValue(undefined),
  getPinnedAgentId: vi.fn().mockReturnValue(undefined),
}));

function composer() {
  const db = makeFakeSupabase({
    workspaces: [
      { id: 'ws-a', user_id: 'user-a', type: 'personal', slug: 'personal', archived_at: null },
      { id: 'ws-b', user_id: 'user-a', type: 'team', slug: 'team', archived_at: null },
    ],
    agent_identities: [{ id: 'sb-b', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-b' }],
    thread_key_types: [
      { type: 'pr', workspace_id: null },
      { type: 'ticket', workspace_id: 'ws-b' },
    ],
    projects: [],
  });
  // The fake stores an insert as given; the database would mint the id the
  // update path looks up, so mint one here.
  let nextId = 1;
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const q = from(table);
    if (table !== 'projects') return q;
    const insert = q.insert.bind(q);
    return {
      ...q,
      insert: (row: Record<string, unknown>) => insert({ id: `p${nextId++}`, ...row }),
    };
  }) as never;
  return {
    db,
    dataComposer: {
      getClient: () => db,
      repositories: { projects: new ProjectsRepository(db as never) },
    } as never,
  };
}

const rows = async (db: ReturnType<typeof makeFakeSupabase>) =>
  (await db.from('projects').select('*')).data;

beforeEach(() => {
  vi.clearAllMocks();
  ctx.sbId = undefined;
});

describe('handleSaveProject — the workspace is the namespace', () => {
  it("a person's save lands in their personal workspace", async () => {
    const { db, dataComposer } = composer();
    await handleSaveProject({ name: 'Inkwell', slug: 'inkwell' }, dataComposer);
    expect(await rows(db)).toMatchObject([
      { user_id: 'user-a', workspace_id: 'ws-a', name: 'Inkwell', slug: 'inkwell' },
    ]);
  });

  it("an SB's save lands in the SB's workspace, not the owner's personal one", async () => {
    ctx.sbId = 'sb-b';
    const { db, dataComposer } = composer();
    await handleSaveProject({ name: 'Inkwell', slug: 'inkwell' }, dataComposer);
    expect(await rows(db)).toMatchObject([{ workspace_id: 'ws-b', name: 'Inkwell' }]);
  });

  it('the same name in the same workspace updates; in another workspace it is another project', async () => {
    const { db, dataComposer } = composer();
    await handleSaveProject({ name: 'Inkwell', description: 'v1' }, dataComposer);
    await handleSaveProject({ name: 'Inkwell', description: 'v2' }, dataComposer);
    expect(await rows(db)).toMatchObject([{ workspace_id: 'ws-a', description: 'v2' }]);

    ctx.sbId = 'sb-b';
    await handleSaveProject({ name: 'Inkwell', description: 'team copy' }, dataComposer);
    expect((await rows(db)).map((p) => [p.workspace_id, p.description])).toEqual([
      ['ws-a', 'v2'],
      ['ws-b', 'team copy'],
    ]);
  });

  it("a slug is refused against a template type and against this workspace's override", async () => {
    const { dataComposer } = composer();
    await expect(handleSaveProject({ name: 'P', slug: 'pr' }, dataComposer)).rejects.toThrow(
      /collides with the thread-key type "pr"/
    );
    ctx.sbId = 'sb-b';
    await expect(handleSaveProject({ name: 'T', slug: 'ticket' }, dataComposer)).rejects.toThrow(
      /collides with the thread-key type "ticket"/
    );
  });

  it("another workspace's override does not reserve the slug here", async () => {
    // 'ticket' is ws-b's override; a personal-workspace project may use it.
    const { db, dataComposer } = composer();
    await handleSaveProject({ name: 'T', slug: 'ticket' }, dataComposer);
    expect(await rows(db)).toMatchObject([{ workspace_id: 'ws-a', slug: 'ticket' }]);
  });
});
