/** Run only through yarn test:integration:db:local. No runtime or model calls. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import router from './admin';
import { Client } from 'pg';

// Suite-owned synthetic users, so scope assertions never rely on someone's account.
const owner = randomUUID();
const other = randomUUID();
const marker = `fixture-${randomUUID()}`;
let db: SupabaseClient;
let workspace: string;
let secondWorkspace: string;
let taskIds: string[] = [];
const needle = 'Needle garden';
const punctuation = 'a,(b)."c"\\d*%_+?[]{}^$|';
interface Body {
  tasks?: Array<{ id: string; title: string }>;
  artifacts?: Array<{ id: string; title: string }>;
  meta: { fetched: number; total: number; truncated: boolean; nextBefore?: string | null };
}
async function get(path: string, query: Record<string, string>): Promise<Body> {
  const stack = router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: { get?: boolean };
        stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
      };
    }>;
  };
  const handler = stack.stack
    .find((layer) => layer.route?.path === path && layer.route.methods.get)!
    .route!.stack.at(-1)!.handle;
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
  };
  await handler(
    { query, inkUserId: owner, inkWorkspaceId: workspace } as unknown as Request,
    res as unknown as Response
  );
  expect(status, JSON.stringify(body)).toBe(200);
  return body as Body;
}
async function insert(table: string, rows: Record<string, unknown>[]) {
  const { data, error } = await db.from(table).insert(rows, { defaultToNull: false }).select('id');
  if (error) throw new Error(`Synthetic ${table} insert failed: ${error.message}`);
  return data!.map((row) => row.id as string);
}
beforeAll(async () => {
  // Both targets are derived and checked by the managed shell harness before setup.
  expect(process.env.INTEGRATION_MANAGED_API_PORT).toBeTruthy();
  expect(process.env.SUPABASE_URL).toBe(
    `http://127.0.0.1:${process.env.INTEGRATION_MANAGED_API_PORT}`
  );
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await insert('users', [{ id: owner }, { id: other }]);
  const workspaces = await db
    .from('workspaces')
    .select('id, user_id')
    .in('user_id', [owner, other])
    .eq('type', 'personal');
  if (workspaces.error) throw workspaces.error;
  workspace = workspaces.data!.find((row) => row.user_id === owner)!.id;
  [secondWorkspace] = await insert('workspaces', [
    { user_id: owner, name: 'Synthetic second workspace', slug: marker, type: 'team' },
  ]);

  const filler = Array.from({ length: 1001 }, (_, i) => ({
    user_id: owner,
    title: `${marker} ordinary ${i}`,
    created_at: '2026-02-01T00:00:00Z',
  }));
  // Insert without RETURNING: PostgREST caps returned rows, not insert size.
  const filled = await db.from('tasks').insert(filler);
  if (filled.error) throw filled.error;
  taskIds = await insert('tasks', [
    {
      user_id: owner,
      title: `${marker} ${needle}`,
      description: 'Paper trail',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      user_id: owner,
      title: `${marker} garden second`,
      description: 'paper plan',
      created_at: '2026-01-01T00:00:00Z',
    },
    { user_id: owner, title: `${marker} punctuation`, description: punctuation },
    { user_id: owner, title: `${marker} 東京`, description: 'café' },
    { user_id: other, title: `${marker} garden`, description: 'paper plan' },
  ]);
  await insert(
    'artifacts',
    [
      {
        user_id: owner,
        workspace_id: workspace,
        title: `${marker} garden`,
        content: 'Paper trail',
      },
      {
        user_id: owner,
        workspace_id: workspace,
        title: `${marker} punctuation`,
        content: punctuation,
      },
      {
        user_id: owner,
        workspace_id: secondWorkspace,
        title: `${marker} garden`,
        content: 'Paper trail',
      },
      {
        user_id: other,
        workspace_id: workspace,
        title: `${marker} garden`,
        content: 'Paper trail',
      },
    ].map((row, i) => ({
      ...row,
      uri: `ink://fixture-search/${marker}/${i}`,
      artifact_type: 'document',
    }))
  );
}, 30000);
afterAll(async () => {
  if (!db) return;
  // Deletes are restricted to this suite's random users, including partial setup.
  for (const table of ['artifacts', 'tasks', 'workspaces']) {
    const { error } = await db.from(table).delete().in('user_id', [owner, other]);
    if (error) throw error;
  }
  const { error } = await db.from('users').delete().in('id', [owner, other]);
  if (error) throw error;
});
describe('list search over real PostgREST and Postgres', () => {
  it('finds a match older than the unsearched 1000-row cap', async () => {
    const unsearched = await get('/tasks', {});
    expect(unsearched.meta.truncated).toBe(true);
    expect(unsearched.tasks!.some((row) => row.id === taskIds[0])).toBe(false);
    const searched = await get('/tasks', { search: `${marker} needle paper` });
    expect(searched.tasks!.map((row) => row.id)).toEqual([taskIds[0]]);
    expect(searched.meta).toMatchObject({ total: 1, fetched: 1, truncated: false });
  });
  it('ANDs search and the keyset cursor while preserving the filter total', async () => {
    const first = await get('/tasks', { search: `${marker} garden paper`, limit: '1' });
    expect(first.meta.total).toBe(2);
    expect(first.meta.nextBefore).toBeTruthy();
    const second = await get('/tasks', {
      search: `${marker} garden paper`,
      limit: '1',
      before: first.meta.nextBefore!,
    });
    expect(second.meta.total).toBe(2);
    expect(second.meta.nextBefore).toBeNull();
    expect(new Set([...first.tasks!, ...second.tasks!].map((row) => row.id))).toEqual(
      new Set(taskIds.slice(0, 2))
    );
  });
  it('scopes document-content matches to both the user and active workspace', async () => {
    const body = await get('/artifacts', { search: `${marker} garden PAPER` });
    expect(body.artifacts).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });
  it.each(['/tasks', '/artifacts'])(
    'keeps all reserved punctuation literal on %s',
    async (path) => {
      const body = await get(path, { search: `${marker} ${punctuation}` });
      expect((body.tasks ?? body.artifacts)!.map((row) => row.title)).toEqual([
        `${marker} punctuation`,
      ]);
      expect((await get(path, { search: `${marker} *` })).meta.total).toBe(1);
      expect((await get(path, { search: `${marker} .*no-such-text` })).meta.total).toBe(0);
    }
  );
  it('matches non-Latin text without English stemming', async () => {
    expect(
      (await get('/tasks', { search: `${marker} 東京 café` })).tasks!.map((row) => row.id)
    ).toEqual([taskIds[3]]);
  });
});

// Optional cost probe, not a production benchmark. No source text is copied.
// INK_SEARCH_INDEX_PROBE=1 yarn test:integration:db:local <this file>
it.skipIf(process.env.INK_SEARCH_INDEX_PROBE !== '1')(
  'reports index storage for a synthetic large-document revision probe',
  async () => {
    const url = new URL(process.env.INTEGRATION_DB_URL!);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(process.env.INTEGRATION_MANAGED_DB_PORT);
    const pg = new Client({ connectionString: process.env.INTEGRATION_DB_URL });
    await pg.connect();
    try {
      const snapshot = async () =>
        (
          await pg.query(
            `SELECT indexrelname AS name, pg_relation_size(indexrelid)::int AS bytes FROM pg_stat_user_indexes WHERE schemaname = 'public' AND indexrelname IN ('idx_artifacts_content_trgm', 'idx_tasks_title_trgm', 'idx_tasks_description_trgm') ORDER BY indexrelname`
          )
        ).rows;
      const before = await snapshot();
      expect(before).toHaveLength(3);
      const content = (document: number, revision: number) =>
        Array.from(
          { length: 256 },
          (_, section) =>
            `Section ${section}: component ${document} revision ${revision}. The synthetic adapter validates the request, records the response, and preserves ordering. Example reference ${createHash('sha256').update(`${document}:${revision}:${section}`).digest('hex').slice(0, 20)}.`
        ).join('\n');
      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: randomUUID(),
        user_id: owner,
        workspace_id: workspace,
        uri: `ink://fixture-cost/${marker}/${i}`,
        title: `Synthetic component specification ${i}`,
        artifact_type: 'spec',
        content: content(i, 0),
      }));
      const sourceBytes = rows.reduce((total, row) => total + Buffer.byteLength(row.content), 0);
      let started = performance.now();
      await insert('artifacts', rows);
      const insertMs = Math.round(performance.now() - started);
      const afterInsert = await snapshot();
      const revisionMs: number[] = [];
      for (let revision = 1; revision <= 3; revision++) {
        started = performance.now();
        const { error } = await db
          .from('artifacts')
          .upsert(rows.map((row, i) => ({ ...row, content: content(i, revision) })));
        if (error) throw error;
        revisionMs.push(Math.round(performance.now() - started));
      }
      const afterRevisions = await snapshot();
      process.stdout.write(
        'SYNTHETIC_INDEX_COST ' +
          JSON.stringify({
            documents: 100,
            sectionsPerDocument: 256,
            sourceBytes,
            revisions: 3,
            corpus:
              'Repeated synthetic technical prose with distinct generated references; no truncation, no production data',
            scope:
              'Whole indexes on the isolated fixture database; elapsed writes include client/REST/DB, not isolated index overhead',
            before,
            afterInsert,
            afterRevisions,
            insertMs,
            revisionMs,
          }) +
          '\n'
      );
    } finally {
      await pg.end();
    }
  },
  60000
);
