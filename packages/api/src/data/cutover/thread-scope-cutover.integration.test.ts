/**
 * The cutover rehearsal — spec inkmail-thread-scope §4, §4a.
 *
 * Runs ONLY at the pre-cutover schema: the harness withholds the cutover
 * migration (INTEGRATION_MIGRATIONS_UNTIL=20260913090000), and each test
 * here seeds a synthetic fixture, loads a manifest, executes the withheld
 * migration file itself — verbatim, from the repository — inside a
 * transaction, and rolls back. Once through to a successful conversion, and
 * once per preflight with the failure deliberately provoked, so every abort
 * diagnostic has been read before it can matter (§4, "rehearsal is
 * mandatory"). The four named fixtures are (a)–(d) from the spec.
 *
 * Nothing here touches production data or the shared database: the harness
 * is an isolated local Supabase, and every fixture lives and dies inside
 * one rolled-back transaction.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const CUTOVER_STAMP = '20260913090000';
const CUTOVER_FILE = `${CUTOVER_STAMP}_inkmail_thread_scope_cutover.sql`;
const DB_URL = process.env.INTEGRATION_DB_URL;
const REHEARSAL = process.env.INTEGRATION_MIGRATIONS_UNTIL === CUTOVER_STAMP && !!DB_URL;
const MIGRATIONS_DIR =
  process.env.INTEGRATION_MIGRATIONS_DIR ??
  path.resolve(process.cwd(), '../../supabase/migrations');

type Row = Record<string, unknown>;

/** A fixture world: two people, two workspaces, a few SBs. */
interface World {
  owner: string; // legacy thread owner; personal workspace w1
  other: string; // a second person; personal workspace w2
  w1: string;
  w2: string;
  wren: string; // owner's SB in w1
  lumen: string; // owner's SB in w1
  aster: string; // other's SB in w2
}

describe.skipIf(!REHEARSAL)(
  'inkmail thread-scope cutover rehearsal (integration, pre-cutover schema)',
  () => {
    let pg: Client;
    let cutoverSql: string;

    beforeAll(async () => {
      cutoverSql = await readFile(path.join(MIGRATIONS_DIR, CUTOVER_FILE), 'utf8');
      pg = new Client({ connectionString: DB_URL });
      await pg.connect();
    });

    afterAll(async () => {
      await pg?.end();
    });

    async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
      const { rows } = await pg.query(sql, params);
      return rows[0] as T;
    }
    async function many<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { rows } = await pg.query(sql, params);
      return rows as T[];
    }

    async function user(label: string): Promise<string> {
      const r = await one<{ id: string }>(
        `INSERT INTO public.users (email, username) VALUES ($1, $2) RETURNING id`,
        [`${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cutover.test`, label]
      );
      return r.id;
    }
    async function workspace(
      ownerId: string,
      slug: string,
      type: 'personal' | 'team'
    ): Promise<string> {
      const r = await one<{ id: string }>(
        `INSERT INTO public.workspaces (user_id, name, slug, type) VALUES ($1, $2, $3, $4) RETURNING id`,
        [ownerId, slug, slug, type]
      );
      await pg.query(
        `INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [r.id, ownerId]
      );
      return r.id;
    }
    async function member(workspaceId: string, userId: string, role = 'member') {
      await pg.query(
        `INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, userId, role]
      );
    }
    async function identity(
      userId: string,
      workspaceId: string | null,
      slug: string
    ): Promise<string> {
      const r = await one<{ id: string }>(
        `INSERT INTO public.agent_identities (user_id, workspace_id, agent_id, name, role)
       VALUES ($1, $2, $3, $3, 'fixture') RETURNING id`,
        [userId, workspaceId, slug]
      );
      return r.id;
    }
    async function world(): Promise<World> {
      const owner = await user('owner');
      const other = await user('other');
      const w1 = await workspace(owner, 'personal', 'personal');
      const w2 = await workspace(other, 'personal', 'personal');
      const wren = await identity(owner, w1, 'wren');
      const lumen = await identity(owner, w1, 'lumen');
      const aster = await identity(other, w2, 'aster');
      return { owner, other, w1, w2, wren, lumen, aster };
    }

    interface ThreadOpts {
      key?: string;
      createdBy?: string;
      closedBy?: string | null; // set → closed
      participants?: string[];
    }
    async function thread(ownerId: string, opts: ThreadOpts = {}): Promise<string> {
      const closed = opts.closedBy !== undefined && opts.closedBy !== null;
      const r = await one<{ id: string }>(
        `INSERT INTO public.inbox_threads (thread_key, user_id, created_by_agent_id, status, closed_at, closed_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          opts.key ?? `pr:${Math.floor(Math.random() * 1e6)}`,
          ownerId,
          opts.createdBy ?? 'wren',
          closed ? 'closed' : 'open',
          closed ? '2026-09-01T00:00:00Z' : null,
          closed ? opts.closedBy : null,
        ]
      );
      for (const p of opts.participants ?? ['wren', 'lumen']) {
        await pg.query(
          `INSERT INTO public.inbox_thread_participants (thread_id, agent_id, joined_at) VALUES ($1, $2, '2026-08-01T00:00:00Z')`,
          [r.id, p]
        );
      }
      return r.id;
    }
    async function message(
      threadId: string,
      sender: string,
      opts: { type?: string; priority?: string; metadata?: Row; at?: string; content?: string } = {}
    ): Promise<string> {
      const r = await one<{ id: string }>(
        `INSERT INTO public.inbox_thread_messages (thread_id, sender_agent_id, content, message_type, priority, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          threadId,
          sender,
          opts.content ?? `from ${sender}`,
          opts.type ?? 'message',
          opts.priority ?? 'normal',
          JSON.stringify(opts.metadata ?? {}),
          opts.at ?? '2026-08-02T00:00:00Z',
        ]
      );
      return r.id;
    }
    async function readPointer(threadId: string, slug: string, at: string) {
      await pg.query(
        `INSERT INTO public.inbox_thread_read_status (thread_id, agent_id, last_read_at) VALUES ($1, $2, $3)`,
        [threadId, slug, at]
      );
    }

    // ── manifest loaders ──
    async function attestThread(threadId: string, workspaceId: string) {
      await pg.query(
        `INSERT INTO public.inkmail_cutover_thread_attestations (thread_id, workspace_id, attested_by) VALUES ($1, $2, 'rehearsal')`,
        [threadId, workspaceId]
      );
    }
    interface Principal {
      kind: 'sb' | 'user' | 'system';
      sbAgentId?: string;
      sbId?: string;
      userId?: string;
    }
    async function attest(
      scope: 'message' | 'participant' | 'read_status' | 'creator' | 'closer',
      threadId: string,
      legacyId: string,
      principal: Principal,
      rowId: string | null = null
    ) {
      await pg.query(
        `INSERT INTO public.inkmail_cutover_principal_attestations
         (scope, thread_id, legacy_id, row_id, kind, sb_id, sb_agent_id, user_id, attested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rehearsal')`,
        [
          scope,
          threadId,
          legacyId,
          rowId,
          principal.kind,
          principal.sbId ?? null,
          principal.sbAgentId ?? null,
          principal.userId ?? null,
        ]
      );
    }
    /** Attest every legacy row of a thread as the SB its slug names (batches), plus the creator/closer. */
    async function attestAllAsSlugs(threadId: string, opts: { closer?: boolean } = {}) {
      const t = await one<{ created_by_agent_id: string; closed_by_agent_id: string | null }>(
        `SELECT created_by_agent_id, closed_by_agent_id FROM public.inbox_threads WHERE id = $1`,
        [threadId]
      );
      await attest('creator', threadId, t.created_by_agent_id, {
        kind: 'sb',
        sbAgentId: t.created_by_agent_id,
      });
      if (opts.closer !== false && t.closed_by_agent_id) {
        await attest('closer', threadId, t.closed_by_agent_id, {
          kind: 'sb',
          sbAgentId: t.closed_by_agent_id,
        });
      }
      for (const p of await many<{ agent_id: string }>(
        `SELECT agent_id FROM public.inbox_thread_participants WHERE thread_id = $1`,
        [threadId]
      )) {
        await attest('participant', threadId, p.agent_id, { kind: 'sb', sbAgentId: p.agent_id });
      }
      for (const rs of await many<{ agent_id: string }>(
        `SELECT agent_id FROM public.inbox_thread_read_status WHERE thread_id = $1`,
        [threadId]
      )) {
        await attest('read_status', threadId, rs.agent_id, { kind: 'sb', sbAgentId: rs.agent_id });
      }
      for (const m of await many<{ sender_agent_id: string }>(
        `SELECT DISTINCT sender_agent_id FROM public.inbox_thread_messages WHERE thread_id = $1
       AND sender_agent_id NOT IN ('system', 'unknown')`,
        [threadId]
      )) {
        await attest('message', threadId, m.sender_agent_id, {
          kind: 'sb',
          sbAgentId: m.sender_agent_id,
        });
      }
    }

    async function runCutover(): Promise<{ ok: true } | { ok: false; message: string }> {
      try {
        await pg.query(cutoverSql);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }
    async function begin() {
      await pg.query('BEGIN');
    }
    async function rollback() {
      await pg.query('ROLLBACK');
    }
    async function hasColumn(table: string, column: string): Promise<boolean> {
      const r = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      return r.n === '1';
    }
    function expectAbort(result: Awaited<ReturnType<typeof runCutover>>, ...fragments: string[]) {
      expect(result.ok).toBe(false);
      const message = (result as { message: string }).message;
      expect(message).toContain('preflight found');
      expect(message).toContain('nothing was changed');
      for (const f of fragments) expect(message).toContain(f);
    }

    it('converts a fully attested fixture: workspace, principals, namespace, constraints, provisioning', async () => {
      await begin();
      try {
        const w = await world();
        // A project + alias in the owner's namespace, so the pin move has something to move.
        const project = await one<{ id: string }>(
          `INSERT INTO public.projects (user_id, name, slug) VALUES ($1, 'Inkwell', 'inkwell') RETURNING id`,
          [w.owner]
        );
        await pg.query(
          `INSERT INTO public.project_slug_aliases (user_id, alias, project_id) VALUES ($1, 'pcp', $2)`,
          [w.owner, project.id]
        );
        await pg.query(
          `INSERT INTO public.thread_key_types (user_id, type, write_intent, studio_policy) VALUES ($1, 'zz-override', 'write', 'provision')`,
          [w.owner]
        );

        const open = await thread(w.owner, { key: 'pcp:pr:1' });
        const closed = await thread(w.owner, { key: 'pr:2', closedBy: 'lumen' });
        const mWren = await message(open, 'wren', { at: '2026-08-02T00:00:00Z' });
        const mHuman = await message(open, 'unknown', {
          metadata: { sentBy: 'user', channel: 'admin-api' },
          at: '2026-08-03T00:00:00Z',
        });
        const mSystem = await message(open, 'system', {
          type: 'notification',
          priority: 'high',
          content: 'Trigger failed',
          metadata: { type: 'trigger_failure' },
          at: '2026-08-04T00:00:00Z',
        });
        const mLumen = await message(open, 'lumen', { at: '2026-08-05T00:00:00Z' });
        await readPointer(open, 'wren', '2026-08-03T12:00:00Z'); // wren has not seen lumen's message
        await message(closed, 'wren', { at: '2026-08-02T00:00:00Z' });
        await message(closed, 'system', {
          type: 'system',
          content: 'Thread closed by lumen',
          metadata: { type: 'thread_closed', closedBy: 'lumen' },
        });

        await attestThread(open, w.w1);
        await attestThread(closed, w.w1);
        await attestAllAsSlugs(open);
        await attestAllAsSlugs(closed);
        await attest('message', open, 'unknown', { kind: 'user', userId: w.owner });
        await attest('message', open, 'system', { kind: 'system' });
        await attest('message', closed, 'system', { kind: 'system' });

        const result = await runCutover();
        expect(result).toEqual({ ok: true });

        // Threads: workspace, creator, closer; legacy columns gone.
        expect(
          await one(
            `SELECT workspace_id, created_by_kind, created_by_sb_id, closed_by_kind FROM public.inbox_threads WHERE id = $1`,
            [open]
          )
        ).toEqual({
          workspace_id: w.w1,
          created_by_kind: 'sb',
          created_by_sb_id: w.wren,
          closed_by_kind: null,
        });
        expect(
          await one(
            `SELECT closed_by_kind, closed_by_sb_id, closed_by_user_id FROM public.inbox_threads WHERE id = $1`,
            [closed]
          )
        ).toEqual({ closed_by_kind: 'sb', closed_by_sb_id: w.lumen, closed_by_user_id: null });
        for (const col of ['user_id', 'created_by_agent_id', 'closed_by_agent_id']) {
          expect(await hasColumn('inbox_threads', col)).toBe(false);
        }

        // Messages: SB by id with display slug; person by user id, no slug; system with nothing.
        const senders = await many(
          `SELECT id, sender_kind, sender_sb_id, sender_user_id, sender_agent_id FROM public.inbox_thread_messages WHERE thread_id = $1`,
          [open]
        );
        const by = (id: string) => senders.find((s) => s.id === id);
        expect(by(mWren)).toMatchObject({
          sender_kind: 'sb',
          sender_sb_id: w.wren,
          sender_user_id: null,
          sender_agent_id: 'wren',
        });
        expect(by(mLumen)).toMatchObject({
          sender_kind: 'sb',
          sender_sb_id: w.lumen,
          sender_agent_id: 'lumen',
        });
        expect(by(mHuman)).toMatchObject({
          sender_kind: 'user',
          sender_user_id: w.owner,
          sender_sb_id: null,
          sender_agent_id: null,
        });
        expect(by(mSystem)).toMatchObject({
          sender_kind: 'system',
          sender_sb_id: null,
          sender_user_id: null,
          sender_agent_id: null,
        });

        // Participants and read pointers carry principals; slugs gone.
        expect(
          await many(
            `SELECT sb_id, user_id, workspace_id, principal_key FROM public.inbox_thread_participants WHERE thread_id = $1 ORDER BY principal_key`,
            [open]
          )
        ).toEqual(
          [w.wren, w.lumen]
            .map((id) => ({
              sb_id: id,
              user_id: null,
              workspace_id: w.w1,
              principal_key: `sb:${id}`,
            }))
            .sort((a, b) => a.principal_key.localeCompare(b.principal_key))
        );
        expect(await hasColumn('inbox_thread_participants', 'agent_id')).toBe(false);
        expect(
          await one(
            `SELECT sb_id, principal_key FROM public.inbox_thread_read_status WHERE thread_id = $1`,
            [open]
          )
        ).toEqual({ sb_id: w.wren, principal_key: `sb:${w.wren}` });
        expect(await hasColumn('inbox_thread_read_status', 'agent_id')).toBe(false);

        // Namespace move: the project sits in the owner's personal workspace and
        // the pin resolves there; the per-user type override became a
        // per-workspace one; user_id is gone from thread_key_types.
        expect(
          await one(`SELECT workspace_id FROM public.projects WHERE id = $1`, [project.id])
        ).toEqual({ workspace_id: w.w1 });
        expect(
          await one(`SELECT workspace_id FROM public.project_slug_aliases WHERE project_id = $1`, [
            project.id,
          ])
        ).toEqual({ workspace_id: w.w1 });
        expect(
          await one(
            `SELECT o_project, o_type, o_id FROM public.compute_thread_key_pin($1, 'pcp:pr:9')`,
            [w.w1]
          )
        ).toEqual({ o_project: 'inkwell', o_type: 'pr', o_id: '9' });
        expect(
          await one(`SELECT o_project FROM public.compute_thread_key_pin($1, 'pcp:pr:9')`, [w.w2])
        ).toEqual({ o_project: null });
        expect(
          await one(
            `SELECT key_project, key_type, key_id FROM public.inbox_threads WHERE id = $1`,
            [open]
          )
        ).toEqual({ key_project: 'inkwell', key_type: 'pr', key_id: '1' });
        expect(
          await one(`SELECT workspace_id FROM public.thread_key_types WHERE type = 'zz-override'`)
        ).toEqual({ workspace_id: w.w1 });
        expect(await hasColumn('thread_key_types', 'user_id')).toBe(false);

        // Delivery: the candidates function is per SB principal now, and wren
        // still has lumen's unseen message.
        const candidates = await many<{ thread_id: string }>(
          `SELECT thread_id FROM public.get_unread_thread_candidates($1, NULL, 50)`,
          [w.wren]
        );
        expect(candidates.map((c) => c.thread_id)).toContain(open);
        expect(
          await many(`SELECT thread_id FROM public.get_unread_thread_candidates($1, NULL, 50)`, [
            w.lumen,
          ])
        ).toEqual(expect.arrayContaining([{ thread_id: closed }]));
        // The pointer, for a person this time.
        await pg.query(`SELECT public.advance_thread_read_pointer($1, NULL, $2, $3)`, [
          open,
          w.owner,
          mLumen,
        ]);
        expect(
          await one(
            `SELECT user_id, principal_key FROM public.inbox_thread_read_status WHERE thread_id = $1 AND user_id = $2`,
            [open, w.owner]
          )
        ).toEqual({ user_id: w.owner, principal_key: `user:${w.owner}` });

        // Reopen writes principals and a system-kind event.
        expect(
          await one(`SELECT public.reopen_inbox_thread($1, $2, NULL) AS ok`, [closed, w.lumen])
        ).toEqual({ ok: true });
        expect(
          await one(
            `SELECT status, closed_at, closed_by_kind FROM public.inbox_threads WHERE id = $1`,
            [closed]
          )
        ).toEqual({ status: 'open', closed_at: null, closed_by_kind: null });
        expect(
          await one(
            `SELECT sender_kind, sender_sb_id, metadata FROM public.inbox_thread_messages WHERE thread_id = $1 AND metadata ->> 'type' = 'thread_reopened'`,
            [closed]
          )
        ).toEqual({
          sender_kind: 'system',
          sender_sb_id: null,
          metadata: { type: 'thread_reopened', reopenedBySbId: w.lumen },
        });

        // Provisioning lives in the database now.
        const fresh = await user('fresh');
        expect(
          await one(
            `SELECT count(*)::int AS n FROM public.workspaces w JOIN public.workspace_members m ON m.workspace_id = w.id AND m.user_id = w.user_id AND m.role = 'owner' WHERE w.user_id = $1 AND w.type = 'personal'`,
            [fresh]
          )
        ).toEqual({ n: 1 });

        // The manifests are gone with the helpers.
        expect(await hasColumn('inkmail_cutover_thread_attestations', 'thread_id')).toBe(false);
        expect(await hasColumn('inkmail_cutover_principal_attestations', 'thread_id')).toBe(false);

        // And the constraints hold: a human participant cannot carry a session,
        // a system message cannot name a sender, a thread cannot be created
        // without a workspace.
        await pg.query('SAVEPOINT s1');
        await expect(
          pg.query(
            `INSERT INTO public.inbox_thread_messages (thread_id, sender_kind, sender_sb_id, content, message_type) VALUES ($1, 'system', $2, 'x', 'system')`,
            [open, w.wren]
          )
        ).rejects.toThrow(/inbox_thread_messages_sender_principal/);
        await pg.query('ROLLBACK TO SAVEPOINT s1');
        await pg.query('SAVEPOINT s2');
        await expect(
          pg.query(
            `INSERT INTO public.inbox_threads (thread_key, created_by_kind, created_by_sb_id) VALUES ('pr:77', 'sb', $1)`,
            [w.wren]
          )
        ).rejects.toThrow(/workspace_id/);
        await pg.query('ROLLBACK TO SAVEPOINT s2');
        // An SB from another workspace cannot join a thread here (composite FK).
        await pg.query('SAVEPOINT s3');
        await expect(
          pg.query(
            `INSERT INTO public.inbox_thread_participants (thread_id, workspace_id, sb_id) VALUES ($1, $2, $3)`,
            [open, w.w1, w.aster]
          )
        ).rejects.toThrow(/inbox_thread_participants_sb_workspace_fkey/);
        await pg.query('ROLLBACK TO SAVEPOINT s3');
      } finally {
        await rollback();
      }
    });

    it('(a) an owner in two eligible workspaces is never attributed: the unattested thread aborts with its id and no suggestion', async () => {
      await begin();
      let threadId = '';
      try {
        const w = await world();
        await member(w.w2, w.owner); // owner belongs to w1 AND w2
        await identity(w.other, w.w2, 'wren'); // and the same slug exists in both
        threadId = await thread(w.owner, { key: 'pr:10' });
        await message(threadId, 'wren');
        await attestAllAsSlugs(threadId); // principals attested, the thread itself is not
        const result = await runCutover();
        expectAbort(result, 'thread_unattested', threadId, 'owner_workspaces=2');
        // A suggestion would be a guess; there is none for a two-workspace owner.
        const line = (result as { message: string }).message
          .split('\n')
          .find((l) => l.includes('thread_unattested'))!;
        expect(line).toContain('suggestion=:');
      } finally {
        await rollback();
      }
      // The pre-cutover schema is intact after the abort.
      expect(await hasColumn('inbox_threads', 'user_id')).toBe(true);
      expect(await hasColumn('inbox_thread_participants', 'agent_id')).toBe(true);
      expect(
        await one(`SELECT count(*)::int AS n FROM public.inbox_threads WHERE id = $1`, [threadId])
      ).toEqual({ n: 0 });
    });

    it('(b) rows the generic send path could have written are suggested, never attributed: human marker, complete notice shape, SB name in both fields', async () => {
      await begin();
      try {
        const w = await world();
        const t = await thread(w.owner, { key: 'pr:11' });
        const human = await message(t, 'unknown', {
          metadata: { sentBy: 'user', channel: 'admin-api' },
        });
        const notice = await message(t, 'system', {
          type: 'notification',
          priority: 'high',
          content: 'Trigger failed for lumen: spawn error',
          metadata: { type: 'trigger_failure', targetAgentId: 'lumen' },
        });
        const stamped = await message(t, 'wren', {
          metadata: { pcp: { sender: { agentId: 'wren' } } },
        });
        await attestThread(t, w.w1);
        // Everything but the three messages is attested.
        await attest('creator', t, 'wren', { kind: 'sb', sbAgentId: 'wren' });
        await attest('participant', t, 'wren', { kind: 'sb', sbAgentId: 'wren' });
        await attest('participant', t, 'lumen', { kind: 'sb', sbAgentId: 'lumen' });

        const result = await runCutover();
        expectAbort(result, 'principal_unattested', human, notice, stamped);
        const message_ = (result as { message: string }).message;
        const lineFor = (id: string) => message_.split('\n').find((l) => l.includes(`row=${id}`))!;
        // The suggestion column names the class the markers suggest — and the
        // migration aborted anyway, because a suggestion is not an attestation.
        expect(lineFor(human)).toContain(`suggestion=user:${w.owner}`);
        expect(lineFor(notice)).toContain('suggestion=system');
        expect(lineFor(stamped)).toContain(`suggestion=sb:${w.wren}`);
      } finally {
        await rollback();
      }
    });

    it('(c) an open thread with no closer migrates with every closer column null; a closer attested for it aborts', async () => {
      await begin();
      try {
        const w = await world();
        const t = await thread(w.owner, { key: 'pr:12' });
        await message(t, 'wren');
        await attestThread(t, w.w1);
        await attestAllAsSlugs(t);
        // Second thread, same fixture, with a closer attested although it is open.
        const t2 = await thread(w.owner, { key: 'pr:13' });
        await attestThread(t2, w.w1);
        await attestAllAsSlugs(t2);
        await attest('closer', t2, 'lumen', { kind: 'sb', sbAgentId: 'lumen' });

        expectAbort(await runCutover(), 'closer_attested_on_open_thread', t2);
        await rollback();

        await begin();
        const w2 = await world();
        const t3 = await thread(w2.owner, { key: 'pr:14' });
        await message(t3, 'wren');
        await attestThread(t3, w2.w1);
        await attestAllAsSlugs(t3);
        expect(await runCutover()).toEqual({ ok: true });
        expect(
          await one(
            `SELECT closed_at, closed_by_kind, closed_by_sb_id, closed_by_user_id FROM public.inbox_threads WHERE id = $1`,
            [t3]
          )
        ).toEqual({
          closed_at: null,
          closed_by_kind: null,
          closed_by_sb_id: null,
          closed_by_user_id: null,
        });
      } finally {
        await rollback();
      }
    });

    it("(d) a counterfeit SB message in a thread that holds that SB's genuine session still needs attestation", async () => {
      await begin();
      try {
        const w = await world();
        const t = await thread(w.owner, { key: 'pr:15' });
        const session = await one<{ id: string }>(
          `INSERT INTO public.sessions (user_id) VALUES ($1) RETURNING id`,
          [w.owner]
        );
        // lumen genuinely holds a session on this thread…
        await pg.query(
          `UPDATE public.inbox_thread_participants SET session_id = $1 WHERE thread_id = $2 AND agent_id = 'lumen'`,
          [session.id, t]
        );
        // …and a message in lumen's name is stored through the generic path.
        const counterfeit = await message(t, 'lumen', { content: 'looks like lumen' });
        await message(t, 'wren');
        await attestThread(t, w.w1);
        await attest('creator', t, 'wren', { kind: 'sb', sbAgentId: 'wren' });
        await attest('participant', t, 'wren', { kind: 'sb', sbAgentId: 'wren' });
        await attest('participant', t, 'lumen', { kind: 'sb', sbAgentId: 'lumen' });
        await attest('message', t, 'wren', { kind: 'sb', sbAgentId: 'wren' });
        // No attestation for the lumen message: the session stamp proves
        // participation, not authorship of that row.
        const result = await runCutover();
        expectAbort(result, 'principal_unattested', counterfeit);
        const line = (result as { message: string }).message
          .split('\n')
          .find((l) => l.includes(`row=${counterfeit}`))!;
        expect(line).toContain(`suggestion=sb:${w.lumen}`);
      } finally {
        await rollback();
      }
    });

    it('duplicate (workspace, thread_key) groups abort with a diagnostic, before any constraint', async () => {
      await begin();
      try {
        const w = await world();
        await member(w.w1, w.other);
        const a = await thread(w.owner, { key: 'pr:16', participants: ['wren'] });
        const b = await thread(w.other, { key: 'pr:16', participants: ['wren'] });
        for (const t of [a, b]) {
          await attestThread(t, w.w1);
          await attestAllAsSlugs(t);
        }
        expectAbort(await runCutover(), 'thread_key_duplicate', a, b, '2 threads carry key pr:16');
      } finally {
        await rollback();
      }
    });

    it('an identity slug shared by two users inside one workspace aborts (§1c)', async () => {
      await begin();
      try {
        const w = await world();
        await member(w.w1, w.other);
        const twin = await identity(w.other, w.w1, 'wren');
        const t = await thread(w.owner, { key: 'pr:17', participants: ['lumen'] });
        await attestThread(t, w.w1);
        await attestAllAsSlugs(t);
        // The creator 'wren' now resolves to two identities in w1 as well.
        expectAbort(await runCutover(), 'identity_slug_collision', twin, w.wren);
      } finally {
        await rollback();
      }
    });

    it("an attestation resolves only inside the thread's workspace: a foreign SB or a non-member person aborts", async () => {
      await begin();
      try {
        const w = await world();
        const t = await thread(w.owner, { key: 'pr:18', participants: ['wren'] });
        const m1 = await message(t, 'aster');
        const m2 = await message(t, 'unknown', { metadata: { sentBy: 'user' } });
        await attestThread(t, w.w1);
        await attestAllAsSlugs(t); // wren rows; aster batch attested by slug → not in w1
        await attest('message', t, 'unknown', { kind: 'user', userId: w.other }); // not a member of w1
        const result = await runCutover();
        expectAbort(result, 'principal_attestation_unresolved');
        const message_ = (result as { message: string }).message;
        expect(message_).toContain(`no identity in workspace ${w.w1} matches sb_id= slug=aster`);
        expect(message_).toContain(`user ${w.other} is not a member of workspace ${w.w1}`);
        expect(m1 && m2).toBeTruthy();
      } finally {
        await rollback();
      }
    });
  }
);
