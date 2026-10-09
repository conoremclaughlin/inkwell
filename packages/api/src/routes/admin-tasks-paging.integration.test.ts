/**
 * GET /api/admin/tasks paging against the real database (task 0ed92d60).
 *
 * The cursor's filter is PostgREST syntax built from a timestamptz's text, so
 * only Postgres can show it lands exactly after the last row: inside a run of
 * equal timestamps, and between two that differ by one microsecond, which a
 * cursor rounded to milliseconds would skip.
 *
 * Run via: yarn test:integration:db:local src/routes/admin-tasks-paging.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { getDataComposer } from '../data/composer';
import { ensureEchoIntegrationFixture } from '../test/integration-fixtures';
import router from './admin';

type Handler = (req: Request, res: Response) => Promise<void>;
function getTasksHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === '/tasks' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /tasks not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface TasksBody {
  tasks: Array<{ id: string; title: string; status: string; priority: string; createdAt: string }>;
  meta: { fetched: number; total: number; truncated: boolean; nextBefore?: string | null };
  error?: string;
}

// Two runs of equal timestamps, the second one microsecond below the first.
const TIE = '2026-01-02T00:00:00.000002+00:00';
const TIE_LESS_ONE_MICRO = '2026-01-02T00:00:00.000001+00:00';
const DAY_BEFORE = '2026-01-01T00:00:00+00:00';
const OLDEST = '2025-12-31T00:00:00+00:00';

const FIXTURES = [
  { title: 'tie a', created_at: TIE, status: 'pending', priority: 'low' },
  { title: 'tie b', created_at: TIE, status: 'completed', priority: 'high' },
  { title: 'tie c', created_at: TIE, status: 'in_progress', priority: 'medium' },
  { title: 'micro a', created_at: TIE_LESS_ONE_MICRO, status: 'pending', priority: 'critical' },
  { title: 'micro b', created_at: TIE_LESS_ONE_MICRO, status: 'blocked', priority: 'low' },
  { title: 'day a', created_at: DAY_BEFORE, status: 'pending', priority: 'high' },
  { title: 'day b', created_at: DAY_BEFORE, status: 'in_progress', priority: 'low' },
  { title: 'archived blocker', created_at: OLDEST, status: 'archived', priority: 'medium' },
] as const;

describe('GET /api/admin/tasks paging over the real schema (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let groupId: string | undefined;
  /** Every fixture id, newest first by (created_at, id), as Postgres orders them. */
  let keysetOrder: string[] = [];
  const idByTitle = new Map<string, string>();

  async function get(query: Record<string, string>): Promise<{ status: number; body: TasksBody }> {
    const res: Record<string, unknown> = { _status: 200, _json: null };
    res.status = (code: number) => ((res._status = code), res);
    res.json = (payload: unknown) => ((res._json = payload), res);
    await getTasksHandler()(
      {
        params: {},
        query: { groupId: groupId!, ...query },
        headers: {},
        cookies: {},
        inkUserId: userId,
      } as unknown as Request,
      res as unknown as Response
    );
    return { status: res._status as number, body: res._json as TasksBody };
  }

  /** Follows nextBefore to the end, returning each page. */
  async function pages(query: Record<string, string>): Promise<TasksBody[]> {
    const seen: TasksBody[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const { status, body } = await get(before ? { ...query, before } : query);
      expect(status, JSON.stringify(body)).toBe(200);
      seen.push(body);
      if (!body.meta.nextBefore) return seen;
      before = body.meta.nextBefore;
    }
    throw new Error('paging never ended');
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;

    const { data: group, error: groupError } = await supabase
      .from('task_groups')
      .insert({ title: `tasks paging ${Date.now()}`, user_id: userId })
      .select('id')
      .single();
    if (groupError) throw new Error(`Failed to create group: ${groupError.message}`);
    groupId = group.id as string;

    const { data: rows, error: taskError } = await supabase
      .from('tasks')
      .insert(FIXTURES.map((t) => ({ ...t, user_id: userId, task_group_id: groupId })))
      .select('id, title');
    if (taskError) throw new Error(`Failed to create tasks: ${taskError.message}`);
    for (const row of rows as Array<{ id: string; title: string }>)
      idByTitle.set(row.title, row.id);

    // An open task waits on the archived one, for activeOnly's blocker rule.
    const { error: blockError } = await supabase
      .from('tasks')
      .update({ blocked_by: [idByTitle.get('archived blocker')] })
      .eq('id', idByTitle.get('day b'));
    if (blockError) throw new Error(`Failed to set blocked_by: ${blockError.message}`);

    const { data: ordered, error: orderError } = await supabase
      .from('tasks')
      .select('id')
      .eq('task_group_id', groupId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (orderError) throw new Error(`Failed to read order: ${orderError.message}`);
    keysetOrder = (ordered as Array<{ id: string }>).map((r) => r.id);
  });

  afterAll(async () => {
    if (groupId) {
      await supabase.from('tasks').delete().eq('task_group_id', groupId);
      await supabase.from('task_groups').delete().eq('id', groupId);
    }
  });

  it('visits every task exactly once, newest first, through both ties and the microsecond', async () => {
    const seen = await pages({ limit: '2' });
    expect(seen.map((p) => p.meta.fetched)).toEqual([2, 2, 2, 2]);
    expect(seen.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(keysetOrder);
    for (const page of seen) {
      expect(page.meta.total).toBe(FIXTURES.length);
      expect(page.meta.truncated).toBe(true);
    }
    expect(seen.at(-1)!.meta.nextBefore).toBeNull();
  });

  it('pages of three cross the same boundaries at different points', async () => {
    const seen = await pages({ limit: '3' });
    expect(seen.map((p) => p.meta.fetched)).toEqual([3, 3, 2]);
    expect(seen.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(keysetOrder);
  });

  it('keeps the filter on every page, and its total', async () => {
    const seen = await pages({ status: 'pending', limit: '1' });
    const pending = FIXTURES.filter((t) => t.status === 'pending').map((t) =>
      idByTitle.get(t.title)
    );
    expect(seen.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(
      keysetOrder.filter((id) => pending.includes(id))
    );
    expect(seen.map((p) => p.meta.total)).toEqual([3, 3, 3]);
  });

  it('brings activeOnly’s archived blocker with the page that references it, after its rows', async () => {
    const seen = await pages({ activeOnly: 'true', limit: '2' });
    const blocker = idByTitle.get('archived blocker');
    const active = FIXTURES.filter((t) => ['pending', 'in_progress', 'blocked'].includes(t.status));
    for (const page of seen) {
      expect(page.meta.total).toBe(active.length);
      const ids = page.tasks.map((t) => t.id);
      if (ids.includes(idByTitle.get('day b')!)) {
        expect(ids.at(-1)).toBe(blocker);
        expect(page.meta.fetched).toBe(ids.length - 1);
      } else {
        expect(ids).not.toContain(blocker);
      }
    }
  });

  it('answers without paging exactly as before: status, priority, then newest, and no cursor', async () => {
    const { status, body } = await get({});
    expect(status).toBe(200);
    expect(Object.keys(body.meta)).toEqual(['fetched', 'total', 'truncated']);
    expect(body.meta).toEqual({ fetched: 8, total: 8, truncated: false });
    expect(body.tasks.map((t) => t.title)).toEqual([
      'tie c', // in_progress, medium
      'day b', // in_progress, low
      'micro a', // pending, critical
      'day a', // pending, high
      'tie a', // pending, low
      'micro b', // blocked
      'tie b', // completed
      'archived blocker', // archived sorts last
    ]);
  });

  it('a single page that holds everything has no next page', async () => {
    const { body } = await get({ limit: '1000' });
    expect(body.meta).toEqual({ fetched: 8, total: 8, truncated: false, nextBefore: null });
    expect(body.tasks.map((t) => t.id)).toEqual(keysetOrder);
  });

  it('refuses a bad limit or cursor with a 400', async () => {
    expect((await get({ limit: '0' })).status).toBe(400);
    expect((await get({ before: 'not-a-cursor' })).status).toBe(400);
  });
});
