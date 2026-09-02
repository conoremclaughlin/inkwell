/**
 * session_running_write — the DB-level running-transition trigger: strips
 * interruption breadcrumbs on every running write, and rotates the turn
 * epoch on every ENTRY into running.
 *
 * The invariant "a running session is not interrupted" lives in a trigger
 * because sessions are written through at least two independent paths
 * (SessionRepository.update, the CLI hooks' memory.updateSession), and both
 * rebuild the metadata JSONB from a read snapshot — an application-level
 * clear can be resurrected by a concurrent read-modify-write replaying a
 * stale blob. None of that is visible to a mock: the behaviour under test IS
 * the database's, so this suite talks to the real schema.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';
import type { Database } from '../../data/supabase/types';

const projectRoot = resolve(__dirname, '../../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const d = SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;
const USER = INTEGRATION_TEST_USER_ID;

/**
 * Direct Postgres, for the one test that needs a second connection holding a
 * row lock — PostgREST gives one transaction per request and cannot express
 * an in-flight write blocked on ownership changing underneath it.
 */
const DB_URL =
  process.env.INTEGRATION_DB_URL ||
  (SUPABASE_URL?.includes('127.0.0.1') || SUPABASE_URL?.includes('localhost')
    ? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
    : undefined);

d('session_running_write trigger', () => {
  const client: SupabaseClient<Database> = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdIds: string[] = [];

  async function insertSession(row: {
    lifecycle: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    createdIds.push(id);
    const { error } = await client.from('sessions').insert({
      id,
      user_id: USER,
      agent_id: 'wren',
      lifecycle: row.lifecycle,
      status: 'active',
      metadata: row.metadata,
    } as never);
    expect(error).toBeNull();
    return id;
  }

  async function readSession(id: string): Promise<{
    lifecycle: string | null;
    metadata: Record<string, unknown>;
    turn_epoch: string | null;
  }> {
    const { data, error } = await client
      .from('sessions')
      .select('lifecycle, metadata, turn_epoch')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return data as never;
  }

  afterAll(async () => {
    if (createdIds.length > 0) {
      await client.from('sessions').delete().in('id', createdIds);
    }
  });

  it('a resume write sheds the interruption breadcrumbs', async () => {
    const id = await insertSession({
      lifecycle: 'interrupted',
      metadata: {
        interruptedAt: '2026-09-01T14:49:32.000Z',
        interruptedReason: 'server-shutdown',
        taskDescription: 'review pr:558',
      },
    });

    // The resume: any writer moving the row to running — the pre-turn write,
    // a CLI on-prompt hook — even one replaying the stale breadcrumbs from a
    // snapshot it read earlier, which is exactly why this is a trigger.
    const { error } = await client
      .from('sessions')
      .update({
        lifecycle: 'running',
        metadata: {
          interruptedAt: '2026-09-01T14:49:32.000Z',
          interruptedReason: 'server-shutdown',
          taskDescription: 'review pr:558',
        },
      } as never)
      .eq('id', id);
    expect(error).toBeNull();

    const after = await readSession(id);
    expect(after.lifecycle).toBe('running');
    expect(after.metadata).not.toHaveProperty('interruptedAt');
    expect(after.metadata).not.toHaveProperty('interruptedReason');
    // Only the breadcrumbs are stripped — nothing else is touched.
    expect(after.metadata.taskDescription).toBe('review pr:558');
  });

  it('a non-resume write leaves the breadcrumbs alone', async () => {
    const id = await insertSession({
      lifecycle: 'interrupted',
      metadata: { interruptedAt: '2026-09-01T14:49:32.000Z', interruptedReason: 'server-shutdown' },
    });

    // Bookkeeping while still interrupted (phase update, alias, whatever) —
    // the interruption record must survive anything that is not a resume.
    const { error } = await client
      .from('sessions')
      .update({
        metadata: {
          interruptedAt: '2026-09-01T14:49:32.000Z',
          interruptedReason: 'server-shutdown',
          currentPhase: 'waiting:review',
        },
      } as never)
      .eq('id', id);
    expect(error).toBeNull();

    const after = await readSession(id);
    expect(after.metadata.interruptedAt).toBe('2026-09-01T14:49:32.000Z');
    expect(after.metadata.interruptedReason).toBe('server-shutdown');
  });

  it('an insert born running cannot carry breadcrumbs either', async () => {
    const id = await insertSession({
      lifecycle: 'running',
      metadata: { interruptedAt: '2026-09-01T14:49:32.000Z', interruptedReason: 'server-shutdown' },
    });

    const after = await readSession(id);
    expect(after.metadata).not.toHaveProperty('interruptedAt');
    expect(after.metadata).not.toHaveProperty('interruptedReason');
  });

  /**
   * Turn-epoch rotation (Lumen, PR #563 round 3): entering `running` takes
   * ownership, on any write path — the DB assigns the generation, and the
   * fenced finalize write can only land while it still holds it.
   */
  describe('turn epoch', () => {
    it('is minted when a session enters running, on insert or update', async () => {
      const born = await readSession(await insertSession({ lifecycle: 'running', metadata: {} }));
      expect(born.turn_epoch).toEqual(expect.any(String));

      const idleId = await insertSession({ lifecycle: 'idle', metadata: {} });
      expect((await readSession(idleId)).turn_epoch).toBeNull();
      await client
        .from('sessions')
        .update({ lifecycle: 'running' } as never)
        .eq('id', idleId);
      expect((await readSession(idleId)).turn_epoch).toEqual(expect.any(String));
    });

    it('a reused idle row ROTATES on a lifecycle-only entry — ride-alongs are not claims', async () => {
      // Round 6 P2: the reused row retains its previous turn's epoch; an
      // entering write that does not NAME a new epoch arrives with
      // NEW.turn_epoch = OLD.turn_epoch, and v3's fill-if-absent left the
      // stale value in place — the previous owner's fence still matched.
      const id = await insertSession({ lifecycle: 'running', metadata: {} });
      const stale = (await readSession(id)).turn_epoch as string;

      await client
        .from('sessions')
        .update({ lifecycle: 'idle' } as never)
        .eq('id', id);
      // Lifecycle-only re-entry: no epoch named.
      await client
        .from('sessions')
        .update({ lifecycle: 'running' } as never)
        .eq('id', id);

      const rotated = (await readSession(id)).turn_epoch;
      expect(rotated).toEqual(expect.any(String));
      expect(rotated).not.toBe(stale);
    });

    it('a caller candidate is AUTHORITATIVE — the trigger never overrides it', async () => {
      // Round 4: candidates make takeover writes idempotent by value, which
      // is what turns a committed-but-rejected running write into a
      // reconcilable state instead of an unanswerable one.
      const id = await insertSession({ lifecycle: 'idle', metadata: {} });
      await client
        .from('sessions')
        .update({ lifecycle: 'running', turn_epoch: 'caller-candidate' } as never)
        .eq('id', id);

      expect((await readSession(id)).turn_epoch).toBe('caller-candidate');
    });

    it('claim with p_set_running takes over atomically: epoch + lifecycle + marker', async () => {
      // Round 5: a claim must not be able to succeed while the lifecycle
      // write fails — ownership, running state, and the CLI turn marker move
      // in ONE statement.
      const id = await insertSession({ lifecycle: 'idle', metadata: {} });
      const { data: claimed, error } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
      } as never);
      expect(error).toBeNull();

      const { data: after } = await client
        .from('sessions')
        .select('lifecycle, turn_epoch, cli_turn_at')
        .eq('id', id)
        .single();
      expect(after!.lifecycle).toBe('running');
      expect(after!.turn_epoch).toBe(claimed);
      expect(after!.cli_turn_at).toEqual(expect.any(String));
    });

    it('the stop tombstone refuses a stale reclaim in the same statement (round 9)', async () => {
      // The parked-claim race: marker written → stop lands → the reclaim
      // arrives late. Client-side ordering cannot close it; the refusal has
      // to be CASed with the claim. A reclaim carries its marker's birth
      // time — older than the stop means the turn it reclaims is over.
      const id = await insertSession({ lifecycle: 'running', metadata: {} });
      const stoppedAt = new Date().toISOString();
      await client
        .from('sessions')
        .update({ cli_turn_stopped_at: stoppedAt } as never)
        .eq('id', id);

      const before = (await readSession(id)).turn_epoch;
      const staleMarker = new Date(Date.parse(stoppedAt) - 60_000).toISOString();
      const { data: refused, error } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
        p_not_stopped_after: staleMarker,
      } as never);
      expect(error).toBeNull();
      expect(refused).toBeNull(); // zero rows — no epoch, no takeover
      expect((await readSession(id)).turn_epoch).toBe(before);

      // A marker born AFTER the stop is a newer prompt generation — claims.
      const freshMarker = new Date(Date.parse(stoppedAt) + 60_000).toISOString();
      const { data: claimed } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
        p_not_stopped_after: freshMarker,
      } as never);
      expect(claimed).toEqual(expect.any(String));

      // An ordinary prompt claim (no marker) stays unconditional.
      const { data: unconditional } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
      } as never);
      expect(unconditional).toEqual(expect.any(String));
    });

    it('claim_turn_epoch rotates a running → running row atomically', async () => {
      // The CLI-prompt takeover: no lifecycle transition for the trigger to
      // see, no metadata in the hook's column-only write. The claim is the
      // ownership primitive for that path — and it must rotate even though
      // the row never leaves running.
      const id = await insertSession({ lifecycle: 'running', metadata: {} });
      const before = (await readSession(id)).turn_epoch as string;

      const { data: claimed, error } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
      } as never);
      expect(error).toBeNull();
      expect(claimed).toEqual(expect.any(String));
      expect(claimed).not.toBe(before);
      expect((await readSession(id)).turn_epoch).toBe(claimed);
    });

    it('is preserved across running → running writes — same owner, same series', async () => {
      const id = await insertSession({ lifecycle: 'running', metadata: {} });
      const first = (await readSession(id)).turn_epoch;

      await client
        .from('sessions')
        .update({ lifecycle: 'running', metadata: { note: 'prompt 2' } } as never)
        .eq('id', id);

      expect((await readSession(id)).turn_epoch).toBe(first);
    });

    it('fences the real repository finalize: stale epoch matches zero rows', async () => {
      const { SessionRepository } = await import('./session-repository');
      const repository = new SessionRepository(client);

      const id = await insertSession({ lifecycle: 'running', metadata: {} });
      const epoch = (await readSession(id)).turn_epoch as string;

      // A newer owner takes over via the claim primitive — running →
      // running, the CLI-prompt shape (candidates are never overridden, so
      // leave/re-enter would preserve the old epoch).
      const { error: claimError } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
      } as never);
      expect(claimError).toBeNull();

      // The old owner's in-flight finalize must match ZERO rows.
      const stale = await repository.updateIfTurnEpoch(id, epoch, { lifecycle: 'idle' });
      expect(stale).toBeNull();
      const after = await readSession(id);
      expect(after.lifecycle).toBe('running');

      // The current owner's finalize lands.
      const current = after.turn_epoch as string;
      const applied = await repository.updateIfTurnEpoch(id, current, { lifecycle: 'idle' });
      expect(applied?.lifecycle).toBe('idle');
      expect((await readSession(id)).lifecycle).toBe('idle');
    });

    /**
     * The reason the fence is a CAS and not just the pre-read check: a write
     * ALREADY IN FLIGHT when ownership changes. The pre-read passes (MVCC
     * shows the old committed row), the UPDATE blocks on the new owner's row
     * lock, and when the lock releases Postgres re-evaluates the predicate on
     * the committed row — epoch rotated, zero rows. Removing the `.eq` on the
     * epoch leaves this test red and only this test: sequential cases are
     * masked by the pre-read (found by mutation, round 3).
     */
    it.skipIf(!DB_URL)(
      'holds against a write already in flight when ownership changes',
      async () => {
        const { SessionRepository } = await import('./session-repository');
        const repository = new SessionRepository(client);

        const id = await insertSession({ lifecycle: 'running', metadata: {} });
        const epoch = (await readSession(id)).turn_epoch as string;

        const { Client } = await import('pg');
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          // The new owner takes over inside the lock-holding transaction via
          // the claim primitive — a running → running takeover, exactly the
          // CLI-prompt shape.
          await holder.query('SELECT public.claim_turn_epoch($1)', [id]);

          // The old owner's finalize starts NOW: its pre-read sees the old
          // committed row (epoch still its own), then its UPDATE blocks.
          const inFlight = repository.updateIfTurnEpoch(id, epoch, { lifecycle: 'idle' });
          await new Promise((r) => setTimeout(r, 500));
          await holder.query('COMMIT');

          expect(await inFlight).toBeNull();
        } finally {
          await holder.end();
        }

        // The new owner's running state survived the in-flight write.
        expect((await readSession(id)).lifecycle).toBe('running');
      }
    );
  });
});
