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
      const verdict = claimed as unknown as { outcome: string; epoch: string };
      expect(verdict.outcome).toBe('claimed');

      const { data: after } = await client
        .from('sessions')
        .select('lifecycle, turn_epoch, cli_turn_at')
        .eq('id', id)
        .single();
      expect(after!.lifecycle).toBe('running');
      expect(after!.turn_epoch).toBe(verdict.epoch);
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
      expect((refused as unknown as { outcome: string }).outcome).toBe('stopped');
      expect((await readSession(id)).turn_epoch).toBe(before);

      // A marker born AFTER the stop is a newer prompt generation — claims.
      const freshMarker = new Date(Date.parse(stoppedAt) + 60_000).toISOString();
      const { data: claimed } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
        p_not_stopped_after: freshMarker,
      } as never);
      expect((claimed as unknown as { outcome: string }).outcome).toBe('claimed');

      // An ordinary prompt claim (no marker) stays unconditional.
      const { data: unconditional } = await client.rpc('claim_turn_epoch', {
        p_session_id: id,
        p_set_running: true,
      } as never);
      expect((unconditional as unknown as { outcome: string }).outcome).toBe('claimed');
    });

    it('the claim and the lease stamp are ONE atomic boundary (round 12)', async () => {
      // The release-wins ordering: a claim naming a studio whose lease is
      // gone (or foreign) refuses with NOTHING committed — no running row,
      // no open marker, no rotated epoch. A held lease is verified under the
      // studio row lock and stamped with the fresh epoch in the same
      // transaction.
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const before = await readSession(sessionId);
      const studioId = randomUUID();
      const { error: studioError } = await client.from('studios').insert({
        id: studioId,
        user_id: USER,
        branch: 'test/claim-atomic',
        repo_root: '/tmp/claim-atomic',
        worktree_path: `/tmp/claim-atomic-${studioId}`,
        status: 'active',
        lease: null,
      } as never);
      expect(studioError).toBeNull();

      try {
        // 1) No lease at all → lease-lost, session untouched.
        const { data: lost } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
        } as never);
        expect((lost as unknown as { outcome: string }).outcome).toBe('lease-lost');
        const untouched = await readSession(sessionId);
        expect(untouched.lifecycle).toBe(before.lifecycle);
        expect(untouched.turn_epoch).toBe(before.turn_epoch);

        // 2) FOREIGN lease → lease-lost, lease untouched.
        const foreign = {
          sessionId: randomUUID(),
          threadKey: 'pr:1',
          agentId: 'wren',
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        };
        await client
          .from('studios')
          .update({ lease: foreign as never })
          .eq('id', studioId);
        const { data: stillLost } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
        } as never);
        expect((stillLost as unknown as { outcome: string }).outcome).toBe('lease-lost');

        // 3) OUR lease → claimed, and EVERY lease the session holds carries
        // the fresh epoch + a heartbeat bump, atomically with the session
        // claim (round 13: a second, unnamed studio held by the same session
        // is restamped too — no application-level follow-up exists to
        // rewind).
        const ours = { ...foreign, sessionId, turnEpoch: 'stale-server-epoch' };
        await client
          .from('studios')
          .update({ lease: ours as never })
          .eq('id', studioId);
        const otherStudioId = randomUUID();
        const { error: otherError } = await client.from('studios').insert({
          id: otherStudioId,
          user_id: USER,
          branch: 'test/claim-atomic-other',
          repo_root: '/tmp/claim-atomic',
          worktree_path: `/tmp/claim-atomic-${otherStudioId}`,
          status: 'active',
          lease: { ...ours, turnEpoch: 'stale-other-epoch' },
        } as never);
        expect(otherError).toBeNull();

        try {
          const { data: won } = await client.rpc('claim_turn_epoch', {
            p_session_id: sessionId,
            p_set_running: true,
            p_studio_id: studioId,
          } as never);
          const verdict = won as unknown as { outcome: string; epoch: string };
          expect(verdict.outcome).toBe('claimed');

          const after = await readSession(sessionId);
          expect(after.lifecycle).toBe('running');
          expect(after.turn_epoch).toBe(verdict.epoch);
          for (const sid of [studioId, otherStudioId]) {
            const { data: studioAfter } = await client
              .from('studios')
              .select('lease')
              .eq('id', sid)
              .single();
            const lease = studioAfter!.lease as { turnEpoch?: string; heartbeatAt?: string };
            expect(lease.turnEpoch).toBe(verdict.epoch);
            expect(lease.heartbeatAt).not.toBe(ours.heartbeatAt);
          }
        } finally {
          await client.from('studios').delete().eq('id', otherStudioId);
        }
      } finally {
        await client.from('studios').delete().eq('id', studioId);
      }
    });

    it('the regrant is revocation-aware and grants nothing to a stopped reclaim (round 14)', async () => {
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const studioId = randomUUID();
      const threadKey = `test:regrant-${studioId.slice(0, 8)}`;
      const { error: studioError } = await client.from('studios').insert({
        id: studioId,
        user_id: USER,
        branch: 'test/regrant',
        repo_root: '/tmp/regrant',
        worktree_path: `/tmp/regrant-${studioId}`,
        status: 'active',
        ephemeral: true,
        lease: null,
      } as never);
      expect(studioError).toBeNull();
      const regrant = {
        sessionId,
        threadKey,
        threadKeys: [threadKey],
        agentId: 'wren',
        reason: 'cli-prompt-regrant',
      };

      try {
        // 1) STOPPED beats the regrant: a reclaim whose marker predates the
        // stop tombstone gets 'stopped' and the studio stays VACANT — no
        // lease held by a dead turn (the round-14 watcher sequence).
        const stoppedAt = new Date().toISOString();
        await client
          .from('sessions')
          .update({ cli_turn_stopped_at: stoppedAt } as never)
          .eq('id', sessionId);
        const { data: refused } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_not_stopped_after: new Date(Date.parse(stoppedAt) - 60_000).toISOString(),
          p_studio_id: studioId,
          p_regrant: regrant,
        } as never);
        expect((refused as unknown as { outcome: string }).outcome).toBe('stopped');
        const { data: afterStopped } = await client
          .from('studios')
          .select('lease')
          .eq('id', studioId)
          .single();
        expect(afterStopped!.lease).toBeNull();

        // 2) A CLOSED thread is a revocation — vacancy is not authorization.
        const { error: threadError } = await client.from('inbox_threads').insert({
          user_id: USER,
          thread_key: threadKey,
          created_by_agent_id: 'wren',
          status: 'closed',
        } as never);
        expect(threadError).toBeNull();
        const { data: revoked } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: regrant,
        } as never);
        expect((revoked as unknown as { outcome: string }).outcome).toBe('lease-lost');
        await client.from('inbox_threads').delete().eq('user_id', USER).eq('thread_key', threadKey);

        // 3) ELIGIBLE vacancy: claimed + regranted, the lease installed with
        // the fresh epoch, and the session re-bound to the studio in the
        // SAME transaction.
        const { data: won } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: regrant,
        } as never);
        const verdict = won as unknown as { outcome: string; epoch: string; regranted: boolean };
        expect(verdict.outcome).toBe('claimed');
        expect(verdict.regranted).toBe(true);
        const { data: studioAfter } = await client
          .from('studios')
          .select('lease')
          .eq('id', studioId)
          .single();
        const lease = studioAfter!.lease as { sessionId?: string; turnEpoch?: string };
        expect(lease.sessionId).toBe(sessionId);
        expect(lease.turnEpoch).toBe(verdict.epoch);
        const { data: sessionAfter } = await client
          .from('sessions')
          .select('studio_id')
          .eq('id', sessionId)
          .single();
        expect(sessionAfter!.studio_id).toBe(studioId);

        // 4) The locked repoint SKIPS a re-leased studio: the release's
        // clear → repoint gap can no longer point a regranted session off
        // its own studio.
        const { data: skipped } = await client.rpc('repoint_sessions_off_ephemeral', {
          p_studio_id: studioId,
          p_user_id: USER,
        } as never);
        expect(skipped).toBe(0);
        const { data: stillBound } = await client
          .from('sessions')
          .select('studio_id')
          .eq('id', sessionId)
          .single();
        expect(stillBound!.studio_id).toBe(studioId);

        // 5) ...and repoints a genuinely vacated one.
        await client
          .from('studios')
          .update({ lease: null } as never)
          .eq('id', studioId);
        const { data: repointed } = await client.rpc('repoint_sessions_off_ephemeral', {
          p_studio_id: studioId,
          p_user_id: USER,
        } as never);
        expect(repointed).toBe(1);
        const { data: unbound } = await client
          .from('sessions')
          .select('studio_id')
          .eq('id', sessionId)
          .single();
        expect(unbound!.studio_id).toBeNull();
      } finally {
        await client.from('inbox_threads').delete().eq('user_id', USER).eq('thread_key', threadKey);
        await client.from('studios').delete().eq('id', studioId);
      }
    });

    it('a cross-tenant claim is FORBIDDEN with nothing modified (round 15 P0)', async () => {
      // An authenticated caller's own session naming ANOTHER user's vacant
      // studio must not install a lease across tenants — the service role
      // bypasses RLS, so the boundary lives in the claim itself.
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const before = await readSession(sessionId);
      const otherUserId = randomUUID();
      const studioId = randomUUID();
      const { error: userError } = await client.from('users').insert({
        id: otherUserId,
        email: `pcp-test-${otherUserId.slice(0, 8)}@example.invalid`,
      } as never);
      expect(userError).toBeNull();
      const { error: studioError } = await client.from('studios').insert({
        id: studioId,
        user_id: otherUserId,
        branch: 'test/cross-tenant',
        repo_root: '/tmp/cross-tenant',
        worktree_path: `/tmp/cross-tenant-${studioId}`,
        status: 'active',
        lease: null,
      } as never);
      expect(studioError).toBeNull();

      try {
        const { data } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: { sessionId, threadKey: 'test:cross', agentId: 'wren' },
        } as never);
        expect((data as unknown as { outcome: string }).outcome).toBe('forbidden');

        const untouched = await readSession(sessionId);
        expect(untouched.lifecycle).toBe(before.lifecycle);
        expect(untouched.turn_epoch).toBe(before.turn_epoch);
        const { data: studioAfter } = await client
          .from('studios')
          .select('lease')
          .eq('id', studioId)
          .single();
        expect(studioAfter!.lease).toBeNull();
      } finally {
        await client.from('studios').delete().eq('id', studioId);
        await client.from('users').delete().eq('id', otherUserId);
      }
    });

    it('the attempt fence preserves every abandoned attempt; legacy tails fence separately (round 21)', async () => {
      const sessionId = await insertSession({ lifecycle: 'running', metadata: {} });
      const markerAt = new Date().toISOString();

      // 1) Append-preserving: fence attempt-a, then attempt-b — BOTH stay
      // refused (the scalar generation fence lost A on B's overwrite), and
      // an unfenced attempt-c claims even with identical timestamps.
      await client.rpc('fence_turn_attempts', {
        p_session_id: sessionId,
        p_attempts: ['attempt-a'],
      } as never);
      await client.rpc('fence_turn_attempts', {
        p_session_id: sessionId,
        p_attempts: ['attempt-b'],
      } as never);
      for (const fenced of ['attempt-a', 'attempt-b']) {
        const { data } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_not_stopped_after: markerAt,
          p_attempt: fenced,
        } as never);
        expect((data as unknown as { outcome: string }).outcome).toBe('stopped');
      }
      const { data: fresh } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: markerAt,
        p_attempt: 'attempt-c',
      } as never);
      expect((fresh as unknown as { outcome: string }).outcome).toBe('claimed');

      // 2) Legacy attempt-less reclaims are fenced by the missing-stop
      // stamp (which fence_turn_attempts also lands) — a marker predating
      // it refuses, a strictly newer one claims. Modern claims skip that
      // column entirely (attempt-c above claimed despite the stamp).
      const { data: legacyOld } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: markerAt,
      } as never);
      expect((legacyOld as unknown as { outcome: string }).outcome).toBe('stopped');
      const { data: legacyNew } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: new Date(Date.now() + 60_000).toISOString(),
      } as never);
      expect((legacyNew as unknown as { outcome: string }).outcome).toBe('claimed');

      // 3) The REAL-stop timestamp fence: equality refuses, strictly newer
      // claims (the <= edge used to claim — round 20).
      const stampAt = new Date().toISOString();
      await client
        .from('sessions')
        .update({ cli_turn_stopped_at: stampAt } as never)
        .eq('id', sessionId);
      const { data: equalRefused } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: stampAt,
      } as never);
      expect((equalRefused as unknown as { outcome: string }).outcome).toBe('stopped');
      const { data: newerAllowed } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: new Date(Date.parse(stampAt) + 60_000).toISOString(),
      } as never);
      expect((newerAllowed as unknown as { outcome: string }).outcome).toBe('claimed');
    });

    it('attempt claims are IDEMPOTENT and the fence RECONCILES committed ones (round 22)', async () => {
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const markerAt = new Date().toISOString();

      // 1) First claim commits and records the attempt → epoch binding.
      const { data: first } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: markerAt,
        p_attempt: 'attempt-i',
      } as never);
      const v1 = first as unknown as { outcome: string; epoch: string };
      expect(v1.outcome).toBe('claimed');

      // 2) A REPLAY of the same attempt returns the SAME epoch — no
      // rotation (the round-22 duplicate-claim repro).
      const { data: replay } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: markerAt,
        p_attempt: 'attempt-i',
      } as never);
      const v2 = replay as unknown as { outcome: string; epoch: string };
      expect(v2.outcome).toBe('claimed');
      expect(v2.epoch).toBe(v1.epoch);
      expect((await readSession(sessionId)).turn_epoch).toBe(v1.epoch);

      // 3) Commit-then-response-loss: the caller abandons the attempt and
      // fences it — the fence RECONCILES, closing the committed turn (idle,
      // marker cleared, tombstone) instead of stranding it running.
      await client.rpc('fence_turn_attempts', {
        p_session_id: sessionId,
        p_attempts: ['attempt-i'],
      } as never);
      const { data: closedRow } = await client
        .from('sessions')
        .select('lifecycle, cli_turn_at, cli_turn_stopped_at, turn_epoch')
        .eq('id', sessionId)
        .single();
      expect(closedRow!.lifecycle).toBe('idle');
      expect(closedRow!.cli_turn_at).toBeNull();
      expect(closedRow!.cli_turn_stopped_at).toEqual(expect.any(String));

      // 4) The fenced attempt's replay is now refused — consumed, not
      // rotatable.
      const { data: afterFence } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_not_stopped_after: markerAt,
        p_attempt: 'attempt-i',
      } as never);
      expect((afterFence as unknown as { outcome: string }).outcome).toBe('stopped');

      // 5) A replay whose epoch was SUPERSEDED reports stopped, never a
      // silent re-claim: new attempt claims (rotates), then the old
      // attempt's replay is refused.
      const { data: fresh } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_attempt: 'attempt-j',
      } as never);
      expect((fresh as unknown as { outcome: string }).outcome).toBe('claimed');
      // attempt-i is fenced; use a THIRD attempt claimed then superseded:
      const { data: third } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_attempt: 'attempt-k',
      } as never);
      expect((third as unknown as { outcome: string }).outcome).toBe('claimed');
      const { data: fourth } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_attempt: 'attempt-l',
      } as never);
      expect((fourth as unknown as { outcome: string }).outcome).toBe('claimed');
      const { data: staleReplay } = await client.rpc('claim_turn_epoch', {
        p_session_id: sessionId,
        p_set_running: true,
        p_attempt: 'attempt-k',
      } as never);
      expect((staleReplay as unknown as { outcome: string }).outcome).toBe('stopped');
    });

    it('a PATHLESS studio regrants under the canonical backing class (round 16)', async () => {
      // Round 15 refused every unchanged empty-path regrant (the moved-
      // backing recheck compared '' to NULLIF('','')) and locked the wrong
      // class. A vacant eligible pathless studio must claim + regrant; a
      // pathless SIBLING holding a lease must refuse (one shared
      // defaultWorkingDirectory class per user, like the canonical grant).
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const studioId = randomUUID();
      const siblingId = randomUUID();
      const { error: e1 } = await client.from('studios').insert({
        id: studioId,
        user_id: USER,
        branch: 'test/pathless-a',
        repo_root: '/tmp/pathless',
        worktree_path: '',
        status: 'active',
        lease: null,
      } as never);
      expect(e1).toBeNull();

      try {
        const { data: won } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: { sessionId, threadKey: 'test:pathless', agentId: 'wren' },
        } as never);
        const verdict = won as unknown as { outcome: string; regranted: boolean };
        expect(verdict.outcome).toBe('claimed');
        expect(verdict.regranted).toBe(true);

        // Vacate, add a pathless sibling with a lease — the shared class is
        // occupied, so the regrant refuses.
        await client
          .from('studios')
          .update({ lease: null } as never)
          .eq('id', studioId);
        const { error: e2 } = await client.from('studios').insert({
          id: siblingId,
          user_id: USER,
          branch: 'test/pathless-b',
          repo_root: '/tmp/pathless',
          worktree_path: '',
          status: 'active',
          lease: {
            sessionId: randomUUID(),
            threadKey: 'pr:pathless-sibling',
            agentId: 'lumen',
            acquiredAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
          },
        } as never);
        expect(e2).toBeNull();

        const { data: refused } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: { sessionId, threadKey: 'test:pathless', agentId: 'wren' },
        } as never);
        expect((refused as unknown as { outcome: string }).outcome).toBe('lease-lost');
      } finally {
        await client.from('studios').delete().in('id', [studioId, siblingId]);
      }
    });

    it('the regrant sibling scan compares NORMALIZED checkout paths (round 15)', async () => {
      // Two rows naming the same tree with different raw spellings: the
      // sibling's held lease must refuse the regrant, exactly as
      // grant_studio_lease's advisory-locked scan would.
      const sessionId = await insertSession({ lifecycle: 'idle', metadata: {} });
      const studioId = randomUUID();
      const siblingId = randomUUID();
      const base = `/tmp/norm-${studioId.slice(0, 8)}`;
      const { error: e1 } = await client.from('studios').insert({
        id: studioId,
        user_id: USER,
        branch: 'test/norm-a',
        repo_root: base,
        worktree_path: base,
        status: 'active',
        lease: null,
      } as never);
      expect(e1).toBeNull();
      const { error: e2 } = await client.from('studios').insert({
        id: siblingId,
        user_id: USER,
        branch: 'test/norm-b',
        repo_root: base,
        worktree_path: `${base}/`,
        status: 'active',
        lease: {
          sessionId: randomUUID(),
          threadKey: 'pr:sibling',
          agentId: 'lumen',
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        },
      } as never);
      expect(e2).toBeNull();

      try {
        const { data } = await client.rpc('claim_turn_epoch', {
          p_session_id: sessionId,
          p_set_running: true,
          p_studio_id: studioId,
          p_regrant: { sessionId, threadKey: 'test:norm', agentId: 'wren' },
        } as never);
        expect((data as unknown as { outcome: string }).outcome).toBe('lease-lost');
        const { data: after } = await client
          .from('studios')
          .select('lease')
          .eq('id', studioId)
          .single();
        expect(after!.lease).toBeNull();
      } finally {
        await client.from('studios').delete().in('id', [studioId, siblingId]);
      }
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
      const verdict = claimed as unknown as { outcome: string; epoch: string };
      expect(verdict.outcome).toBe('claimed');
      expect(verdict.epoch).toEqual(expect.any(String));
      expect(verdict.epoch).not.toBe(before);
      expect((await readSession(id)).turn_epoch).toBe(verdict.epoch);
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
