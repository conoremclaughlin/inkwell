/**
 * delete_account against a real database (ink://specs/account-deletion v6
 * §5): the census that keeps the fence true as tables are added, a full
 * removal of one account beside another, the refusals, and the race that the
 * locks close.
 *
 * Run via: yarn test:integration:db:local src/services/account-deletion/delete-account.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { getDataComposer } from '../../data/composer';
import { recordDelivery } from '../send-receipt';

const run = randomUUID().slice(0, 8);
let db: Client;

async function connect(): Promise<Client> {
  const url = process.env.INTEGRATION_DB_URL;
  if (!url) throw new Error('INTEGRATION_DB_URL is required: run through the managed harness');
  const { Client: PgClient } = await import('pg');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  return client;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, params);
  if (rows.length !== 1) throw new Error(`expected one row from: ${sql}`);
  return rows[0] as T;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await one<{ n: string }>(sql, params)).n);
}

interface Account {
  id: string;
  personal: string;
  inkling: string;
}

async function account(label: string): Promise<Account> {
  const { id } = await one<{ id: string }>(
    `INSERT INTO users (email, auth_uid) VALUES ($1, gen_random_uuid()) RETURNING id`,
    [`${label}-${run}@example.com`]
  );
  const { id: personal } = await one<{ id: string }>(
    `SELECT id FROM workspaces WHERE user_id = $1 AND type = 'personal'`,
    [id]
  );
  const { id: inkling } = await one<{ id: string }>(
    `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role, metadata)
     VALUES ($1, $2, $3, 'Pip', 'Inkling', '{"client":"inkling-mobile"}') RETURNING id`,
    [id, personal, `inkling-${label}-${run}`]
  );
  return { id, personal, inkling };
}

async function thread(workspaceId: string, creator: { userId?: string; sbId?: string }) {
  const { id } = await one<{ id: string }>(
    `INSERT INTO inbox_threads (thread_key, workspace_id, created_by_kind, created_by_user_id, created_by_sb_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      `thread:del-${run}-${randomUUID().slice(0, 6)}`,
      workspaceId,
      creator.sbId ? 'sb' : 'user',
      creator.userId ?? null,
      creator.sbId ?? null,
    ]
  );
  return id;
}

async function userMessage(threadId: string, userId: string, content: string): Promise<string> {
  const { id } = await one<{ id: string }>(
    `INSERT INTO inbox_thread_messages (thread_id, content, sender_kind, sender_user_id, metadata)
     VALUES ($1, $2, 'user', $3, $4) RETURNING id`,
    [threadId, content, userId, { pcp: { sender: { kind: 'user', userId } }, keep: 'yes' }]
  );
  return id;
}

async function requestAt(userId: string, step: string): Promise<void> {
  await db.query(
    `INSERT INTO account_deletion_requests (user_id, step, started_at)
     VALUES ($1, $2, CASE WHEN $2 = 'requested' THEN NULL ELSE now() END)
     ON CONFLICT (user_id) DO UPDATE SET step = EXCLUDED.step, started_at = EXCLUDED.started_at`,
    [userId, step]
  );
}

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db?.end();
});

describe('the census', () => {
  it('every uuid column that names an account has a key, apart from the known few', async () => {
    const { rows } = await db.query(`
      WITH cols AS (
        SELECT c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
          AND (c.column_name ~ '(user_id|sb_id|identity_id|_by)$')
      ), fk AS (
        SELECT conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
      )
      SELECT cols.table_name || '.' || cols.column_name AS col
      FROM cols LEFT JOIN fk ON fk.tbl = cols.table_name AND fk.col = cols.column_name
      WHERE fk.col IS NULL ORDER BY 1`);
    // Each of these is covered without a key: a history or breaker row whose
    // own user_id cascades, and the deletion request, keyless on purpose.
    expect(rows.map((r) => r.col)).toEqual([
      'account_deletion_requests.user_id',
      'agent_identity_history.sb_id',
      'memory_history.sb_id',
      'user_identity_history.identity_id',
      'wake_source_breakers.owner_sb_id',
    ]);
  });

  it('every key without a delete rule to an account is one delete_account handles', async () => {
    const { rows } = await db.query(`
      SELECT k.conrelid::regclass::text || '.' ||
             (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = k.conrelid AND attnum = ANY (k.conkey)) AS ref
      FROM pg_constraint k
      WHERE k.contype = 'f' AND k.confdeltype = 'a'
        AND k.confrelid IN ('public.users'::regclass, 'public.agent_identities'::regclass)
      ORDER BY 1`);
    expect(rows.map((r) => r.ref)).toEqual([
      'artifact_history.changed_by_user_id',
      'artifacts.user_id',
      'audit_log.user_id',
      'authorized_groups.authorized_by',
      'authorized_groups.revoked_by',
      'group_challenge_codes.created_by',
      'inbox_thread_messages.sender_sb_id',
      'inbox_thread_messages.sender_user_id',
      'inbox_thread_participants.workspace_id,sb_id',
      'inbox_threads.closed_by_sb_id',
      'inbox_threads.closed_by_user_id',
      'inbox_threads.created_by_sb_id',
      'inbox_threads.created_by_user_id',
      'kindle_lineage.child_user_id',
      'kindle_lineage.facilitator_user_id',
      'kindle_lineage.parent_user_id',
      'kindle_tokens.creator_user_id',
      'kindle_tokens.used_by_user_id',
      'publication_operation_events.actor_identity_id',
      'publication_operation_events.actor_user_id',
      'publication_operations.authorizer_identity_id',
      'publication_operations.authorizer_user_id',
      'publication_operations.executor_identity_id',
      'scheduled_reminders.sb_id',
      'skill_versions.published_by',
      'skills.author_user_id',
      'skills.deprecated_by',
      'skills.last_published_by',
      'task_comments.created_by_sb_id',
      'task_comments.user_id',
      'task_gate_events.actor_identity_id',
      'task_gate_events.actor_user_id',
      'task_gate_events.assignee_identity_id',
      'task_gate_events.assignee_user_id',
      'task_graph_revisions.actor_identity_id',
      'task_graph_revisions.actor_user_id',
      'task_group_comments.created_by_sb_id',
      'task_group_comments.user_id',
      'tasks.assignee_identity_id',
      'tasks.assignee_user_id',
      'thread_uploads.user_id',
      'trusted_users.added_by',
      'trusted_users.user_id',
      'user_permissions.granted_by',
      'user_permissions.user_id',
    ]);
  });
});

describe('delete_account', () => {
  let ada: Account;
  let bea: Account;
  let shared: string;
  let sharedThread: string;
  let adaInShared: string;
  let beaInShared: string;
  let adaThread: string;

  beforeAll(async () => {
    ada = await account('ada');
    bea = await account('bea');

    // Bea's space, which Ada belongs to and writes in.
    ({ id: shared } = await one<{ id: string }>(
      `INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Book club', $2, 'team') RETURNING id`,
      [bea.id, `book-club-${run}`]
    ));
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [shared, bea.id, ada.id]
    );
    sharedThread = await thread(shared, { userId: ada.id });
    await db.query(
      `INSERT INTO inbox_thread_participants (thread_id, workspace_id, user_id)
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [sharedThread, shared, ada.id, bea.id]
    );
    adaInShared = await userMessage(sharedThread, ada.id, 'Chapter three was the best one');
    beaInShared = await userMessage(sharedThread, bea.id, 'Agreed');

    // Ada's own space, with her inkling.
    adaThread = await thread(ada.personal, { sbId: ada.inkling });
    await db.query(
      `INSERT INTO inbox_thread_messages (thread_id, content, sender_kind, sender_sb_id, sender_agent_id)
       VALUES ($1, 'Hello, I am Pip', 'sb', $2, $3)`,
      [adaThread, ada.inkling, `inkling-ada-${run}`]
    );

    for (const who of [ada, bea]) {
      await db.query(`INSERT INTO memories (user_id, content) VALUES ($1, 'likes long walks')`, [
        who.id,
      ]);
      await db.query(`INSERT INTO sessions (user_id) VALUES ($1)`, [who.id]);
    }
    await db.query(
      `INSERT INTO audit_log (user_id, action, category) VALUES ($1, 'sign_in', 'auth')`,
      [ada.id]
    );
    // Ada's own self-serve awakening.
    await db.query(
      `INSERT INTO kindle_tokens (creator_user_id, used_by_user_id, status) VALUES ($1, $1, 'used')`,
      [ada.id]
    );
    await db.query(
      `INSERT INTO kindle_lineage (facilitator_user_id, child_user_id, child_agent_id)
       VALUES ($1, $1, $2)`,
      [ada.id, `kindle-${run}`]
    );
    await requestAt(ada.id, 'files_removed');
  });

  it("removes the account, keeps what it wrote in another person's space as Deleted account, and leaves the other account alone", async () => {
    const result = await one<{ counts: Record<string, number> }>(
      `SELECT delete_account($1) AS counts`,
      [ada.id]
    );
    expect(result.counts).toMatchObject({
      users: 1,
      identities: 1,
      messagesFromDeletedAccount: 1,
      threadsStartedByDeletedAccount: 1,
      kindleLineage: 1,
      kindleTokens: 1,
      auditRowsKept: 1,
    });

    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [ada.id])).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM agent_identities WHERE user_id = $1`, [ada.id])
    ).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM workspaces WHERE user_id = $1`, [ada.id])).toBe(
      0
    );
    expect(await count(`SELECT count(*) AS n FROM inbox_threads WHERE id = $1`, [adaThread])).toBe(
      0
    );
    expect(await count(`SELECT count(*) AS n FROM memories WHERE user_id = $1`, [ada.id])).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM memory_history WHERE user_id = $1`, [ada.id])
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM agent_identity_history WHERE user_id = $1`, [ada.id])
    ).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE user_id = $1`, [ada.id])).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM kindle_lineage WHERE child_user_id = $1`, [ada.id])
    ).toBe(0);

    const kept = await one<{
      sender_kind: string;
      sender_user_id: string | null;
      sender_agent_id: string | null;
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT sender_kind, sender_user_id, sender_agent_id, content, metadata FROM inbox_thread_messages WHERE id = $1`,
      [adaInShared]
    );
    expect(kept).toEqual({
      sender_kind: 'deleted_account',
      sender_user_id: null,
      sender_agent_id: null,
      content: 'Chapter three was the best one',
      metadata: { keep: 'yes' },
    });
    const started = await one<{ created_by_kind: string; created_by_user_id: string | null }>(
      `SELECT created_by_kind, created_by_user_id FROM inbox_threads WHERE id = $1`,
      [sharedThread]
    );
    expect(started).toEqual({ created_by_kind: 'deleted_account', created_by_user_id: null });

    // Bea and her space are untouched.
    const theirs = await one<{ sender_kind: string; sender_user_id: string }>(
      `SELECT sender_kind, sender_user_id FROM inbox_thread_messages WHERE id = $1`,
      [beaInShared]
    );
    expect(theirs).toEqual({ sender_kind: 'user', sender_user_id: bea.id });
    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [bea.id])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM memories WHERE user_id = $1`, [bea.id])).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM agent_identities WHERE user_id = $1`, [bea.id])
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM inbox_thread_participants WHERE thread_id = $1`, [
        sharedThread,
      ])
    ).toBe(1);

    // The audit row is kept, naming no one.
    expect(
      await count(
        `SELECT count(*) AS n FROM audit_log WHERE action = 'sign_in' AND user_id IS NULL AND category = 'auth'`
      )
    ).toBeGreaterThanOrEqual(1);

    expect(
      (
        await one<{ step: string }>(
          `SELECT step FROM account_deletion_requests WHERE user_id = $1`,
          [ada.id]
        )
      ).step
    ).toBe('rows_removed');
  });

  it('does nothing the second time', async () => {
    const again = await one<{ counts: Record<string, unknown> }>(
      `SELECT delete_account($1) AS counts`,
      [ada.id]
    );
    expect(again.counts).toEqual({ alreadyRemoved: true });
  });

  it('never writes a removed sender back when a delivery is recorded afterwards', async () => {
    const dataComposer = await getDataComposer();
    await recordDelivery(dataComposer.getClient(), adaInShared, { status: 'delivered' } as never);
    const after = await one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM inbox_thread_messages WHERE id = $1`,
      [adaInShared]
    );
    expect(after.metadata).toEqual({ keep: 'yes' });
  });

  it('refuses an insert naming the account once it is gone', async () => {
    await expect(userMessage(sharedThread, ada.id, 'late')).rejects.toMatchObject({
      code: '23503',
    });
  });
});

describe('delete_account refusals', () => {
  it('refuses before the files are removed', async () => {
    const cy = await account('cy');
    await requestAt(cy.id, 'drained');
    await expect(db.query(`SELECT delete_account($1)`, [cy.id])).rejects.toThrow(
      /files are not removed/
    );
    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [cy.id])).toBe(1);
  });

  it('refuses without a request', async () => {
    const dee = await account('dee');
    await expect(db.query(`SELECT delete_account($1)`, [dee.id])).rejects.toThrow(
      /no deletion request/
    );
  });

  it('refuses an account that owns a space with other members, touching nothing', async () => {
    const eve = await account('eve');
    const fay = await account('fay');
    const { id: space } = await one<{ id: string }>(
      `INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Trip', $2, 'team') RETURNING id`,
      [eve.id, `trip-${run}`]
    );
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [space, fay.id]
    );
    await requestAt(eve.id, 'files_removed');
    await expect(db.query(`SELECT delete_account($1)`, [eve.id])).rejects.toThrow(
      /space with other members/
    );
    expect(await count(`SELECT count(*) AS n FROM workspaces WHERE id = $1`, [space])).toBe(1);
  });

  it('refuses an account with an identity that is not an inkling', async () => {
    const gus = await account('gus');
    await db.query(
      `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role) VALUES ($1, $2, $3, 'Helper', 'SB')`,
      [gus.id, gus.personal, `helper-${run}`]
    );
    await requestAt(gus.id, 'files_removed');
    await expect(db.query(`SELECT delete_account($1)`, [gus.id])).rejects.toThrow(/not an inkling/);
  });

  it('refuses a kindle record that links the account with another', async () => {
    const hal = await account('hal');
    const ivy = await account('ivy');
    await db.query(
      `INSERT INTO kindle_lineage (facilitator_user_id, parent_user_id, child_user_id, child_agent_id)
       VALUES ($1, $1, $2, $3)`,
      [ivy.id, hal.id, `kindle-hal-${run}`]
    );
    await requestAt(hal.id, 'files_removed');
    await expect(db.query(`SELECT delete_account($1)`, [hal.id])).rejects.toThrow(/kindle record/);
  });
});

describe('delete_account and a racing insert', () => {
  it('holds an insert naming the account until it commits, and then the insert fails', async () => {
    const jo = await account('jo');
    const kit = await account('kit');
    const { id: space } = await one<{ id: string }>(
      `INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Choir', $2, 'team') RETURNING id`,
      [kit.id, `choir-${run}`]
    );
    const t = await thread(space, { userId: kit.id });
    await requestAt(jo.id, 'files_removed');

    const deleting = await connect();
    const racing = await connect();
    try {
      await deleting.query('BEGIN');
      await deleting.query(`SELECT delete_account($1)`, [jo.id]);
      let settled: 'ok' | 'failed' | undefined;
      let failure: { code?: string } | undefined;
      const insert = racing
        .query(
          `INSERT INTO inbox_thread_messages (thread_id, content, sender_kind, sender_user_id)
           VALUES ($1, 'late', 'user', $2)`,
          [t, jo.id]
        )
        .then(
          () => (settled = 'ok'),
          (error) => {
            settled = 'failed';
            failure = error;
          }
        );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBeUndefined();
      await deleting.query('COMMIT');
      await insert;
      expect(settled).toBe('failed');
      expect(failure?.code).toBe('23503');
    } finally {
      await deleting.end();
      await racing.end();
    }
  });
});

async function backendPid(c: Client): Promise<number> {
  return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}

/**
 * Resolves once backend `waiterPid` is waiting on a lock that `holderPid`
 * holds. Pids are read beforehand: a connection whose statement is blocked
 * answers nothing else until it finishes.
 */
async function blockedBy(waiterPid: number, holderPid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.query<{ blocked: boolean }>(
      'SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked',
      [waiterPid, holderPid]
    );
    if (rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${waiterPid} never waited on ${holderPid}`);
}

function settle(query: Promise<unknown>) {
  const state: { settled?: 'ok' | 'failed'; code?: string; done: Promise<void> } = {
    done: Promise.resolve(),
  };
  state.done = query.then(
    () => {
      state.settled = 'ok';
    },
    (error: { code?: string }) => {
      state.settled = 'failed';
      state.code = error.code;
    }
  );
  return state;
}

describe('delete_account and a join to a space it removes', () => {
  it("holds a membership insert into the account's own space from before its member check, and then the join fails (Lumen, #783)", async () => {
    const lee = await account('lee');
    const max = await account('max');
    const { id: space } = await one<{ id: string }>(
      `INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Garden', $2, 'team') RETURNING id`,
      [lee.id, `garden-${run}`]
    );
    await db.query(
      `INSERT INTO audit_log (user_id, action, category) VALUES ($1, 'sign_in', 'auth')`,
      [lee.id]
    );
    await requestAt(lee.id, 'files_removed');

    const holding = await connect();
    const deleting = await connect();
    const joining = await connect();
    const [deletingPid, holdingPid, joiningPid] = [
      await backendPid(deleting),
      await backendPid(holding),
      await backendPid(joining),
    ];
    try {
      // Holding the account's audit row stops delete_account after its
      // checks, at the audit update, with its locks taken.
      await holding.query('BEGIN');
      await holding.query(`SELECT 1 FROM audit_log WHERE user_id = $1 FOR UPDATE`, [lee.id]);
      const deletion = settle(deleting.query(`SELECT delete_account($1)`, [lee.id]));
      await blockedBy(deletingPid, holdingPid);

      // Someone joins the space now, after the member check found no one.
      const join = settle(
        joining.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
          [space, max.id]
        )
      );
      // The join waits on the deletion's lock on the space, not on the audit row.
      await blockedBy(joiningPid, deletingPid);
      expect(join.settled).toBeUndefined();

      await holding.query('COMMIT');
      await deletion.done;
      await join.done;
      expect(deletion.settled).toBe('ok');
      expect(join.settled).toBe('failed');
      // The join never landed, so no member of a shared space was removed with it.
      expect(join.code).toBe('23503');
      expect(await count(`SELECT count(*) AS n FROM workspaces WHERE id = $1`, [space])).toBe(0);
    } finally {
      await holding.end();
      await deleting.end();
      await joining.end();
    }
  });
});

describe("a conversation's participants all belong to its space", () => {
  it("refuses an inkling of another space as a participant, so a space's turns are its own inklings' (Lumen, #783)", async () => {
    const nia = await account('nia');
    const oz = await account('oz');
    const { id: space } = await one<{ id: string }>(
      `INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Studio', $2, 'team') RETURNING id`,
      [nia.id, `studio-${run}`]
    );
    const t = await thread(space, { userId: nia.id });
    const participate = (workspaceId: string, sbId: string) =>
      db.query(
        `INSERT INTO inbox_thread_participants (thread_id, workspace_id, sb_id) VALUES ($1, $2, $3)`,
        [t, workspaceId, sbId]
      );

    // Oz's inkling lives in Oz's personal space: not a participant here,
    // whichever space the row names.
    await expect(participate(space, oz.inkling)).rejects.toMatchObject({ code: '23503' });
    await expect(participate(oz.personal, oz.inkling)).rejects.toMatchObject({ code: '23503' });

    // An inkling of this space is.
    const { id: local } = await one<{ id: string }>(
      `INSERT INTO agent_identities (user_id, workspace_id, agent_id, name, role, metadata)
       VALUES ($1, $2, $3, 'Wick', 'Inkling', '{"client":"inkling-mobile"}') RETURNING id`,
      [nia.id, space, `inkling-studio-${run}`]
    );
    await participate(space, local);
    expect(
      await count(
        `SELECT count(*) AS n FROM inbox_thread_participants WHERE thread_id = $1 AND sb_id IS NOT NULL`,
        [t]
      )
    ).toBe(1);
  });
});
