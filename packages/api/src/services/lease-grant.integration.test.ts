/**
 * Path-serialized lease grants — Integration Tests (real DB)
 *
 * The core Phase 6b guarantee lives in the grant_studio_lease RPC: an
 * advisory xact lock on (user, worktree_path) held across the sibling scan
 * AND the CAS, so several studio rows naming one working tree cannot admit
 * two writers. Unit mocks cannot see any of that by construction.
 *
 * Suite-owned fixtures throughout (PR #516 round 4 discipline): a temp user,
 * temp studios, leak-proof cleanup ordered so the temp-user CASCADE sweeps
 * stragglers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Database } from '../data/supabase/types';
import { grantStudioLease, studioPathConflict } from './lease-grant';
import type { StudioLease } from './studio-lease.service';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);
const d = available ? describe : describe.skip;

const PATH = `/tmp/lease-grant-itest-${Date.now()}`;

function lease(threadKey: string, sessionId: string, heartbeatAt?: string): StudioLease {
  const now = new Date().toISOString();
  return {
    sessionId,
    threadKey,
    agentId: 'echo',
    acquiredAt: heartbeatAt ?? now,
    heartbeatAt: heartbeatAt ?? now,
  };
}

d('grant_studio_lease — path serialization (real DB)', () => {
  let client: SupabaseClient<Database>;
  let userId: string;
  let studioA: string;
  let studioB: string;

  async function makeStudio(agent: string): Promise<string> {
    const { data, error } = await client
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: agent,
        repo_root: PATH,
        worktree_path: PATH,
        branch: `${agent}/itest`,
        status: 'active',
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  async function clearLeases() {
    await client.from('studios').update({ lease: null }).in('id', [studioA, studioB]);
  }

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    userId = crypto.randomUUID();
    const { error } = await client.from('users').insert({
      id: userId,
      email: `lease-itest-${userId.slice(0, 8)}@example.com`,
      username: `lease-itest-${userId.slice(0, 8)}`,
    });
    if (error) throw error;
    // Two rows, one working tree — the exact resolveMainStudio shape that
    // motivated path serialization (3 SBs share the pcp checkout today).
    studioA = await makeStudio('echo');
    studioB = await makeStudio('echo-b');
  });

  afterAll(async () => {
    if (!client) return;
    await client.from('studios').delete().in('id', [studioA, studioB].filter(Boolean));
    // Temp user last — cascades sweep anything a failed assertion left.
    if (userId) await client.from('users').delete().eq('id', userId);
  });

  it('CONCURRENT grants on two rows sharing one tree: exactly one writer wins', async () => {
    for (let round = 0; round < 5; round += 1) {
      await clearLeases();
      const [a, b] = await Promise.all([
        grantStudioLease(client, {
          studioId: studioA,
          userId,
          lease: lease(`pr:${1000 + round}`, `sess-a-${round}`),
        }),
        grantStudioLease(client, {
          studioId: studioB,
          userId,
          lease: lease(`pr:${2000 + round}`, `sess-b-${round}`),
        }),
      ]);
      const granted = [a, b].filter((r) => r.outcome === 'granted').length;
      const conflicts = [a, b].filter((r) => r.outcome === 'path-conflict').length;
      expect({ round, granted, conflicts }).toEqual({ round, granted: 1, conflicts: 1 });
    }
  });

  it('a path-conflict carries the sibling holder for divert messaging', async () => {
    await clearLeases();
    const first = await grantStudioLease(client, {
      studioId: studioA,
      userId,
      lease: lease('pr:3000', 'sess-first'),
    });
    expect(first.outcome).toBe('granted');

    const second = await grantStudioLease(client, {
      studioId: studioB,
      userId,
      lease: lease('pr:3001', 'sess-second'),
    });
    expect(second).toMatchObject({
      outcome: 'path-conflict',
      conflictStudioId: studioA,
      conflictHolder: expect.objectContaining({ threadKey: 'pr:3000' }),
    });
  });

  it('a STALE sibling lease ALSO blocks — its holder can renew back to fresh (r2)', async () => {
    // Round-1 encoded the unsafe case: stale siblings were ignored, then the
    // sibling's unlocked row-local renewal made both leases fresh (Lumen,
    // reproduced live). Stale is not proof of departure; the sweep rescues.
    await clearLeases();
    const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    await client
      .from('studios')
      .update({ lease: lease('pr:4000', 'sess-stale', stale) as never })
      .eq('id', studioA);

    const result = await grantStudioLease(client, {
      studioId: studioB,
      userId,
      lease: lease('pr:4001', 'sess-live'),
    });
    expect(result).toMatchObject({ outcome: 'path-conflict', conflictStudioId: studioA });
  });

  it('a SAME-thread sibling lease ALSO blocks — a thread is not one writer (r2)', async () => {
    // Round-1 encoded the unsafe case: two sessions of one thread on two
    // rows both granted (Lumen, reproduced live). The v14 adoption rule
    // refuses fresh same-thread holders at row level; path level is no freer.
    await clearLeases();
    await client
      .from('studios')
      .update({ lease: lease('pr:5000', 'sess-x') as never })
      .eq('id', studioA);

    const result = await grantStudioLease(client, {
      studioId: studioB,
      userId,
      lease: lease('pr:5000', 'sess-y'),
    });
    expect(result).toMatchObject({ outcome: 'path-conflict', conflictStudioId: studioA });
  });

  it('textual path aliases are ONE tree: /x and /x/. conflict (r2)', async () => {
    // Lumen granted both live with '/tmp/x' + '/tmp/x/.'. Normalization makes
    // them one lock key and one sibling-equality class.
    await clearLeases();
    const { data: aliasRow, error: aliasErr } = await client
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: 'echo-alias',
        repo_root: PATH,
        worktree_path: `${PATH}/.`,
        branch: 'echo-alias/itest',
        status: 'active',
      })
      .select('id')
      .single();
    expect(aliasErr).toBeNull();
    const aliasId = aliasRow!.id;
    try {
      const [a, b] = await Promise.all([
        grantStudioLease(client, { studioId: studioA, userId, lease: lease('pr:8000', 'sess-a8') }),
        grantStudioLease(client, { studioId: aliasId, userId, lease: lease('pr:8001', 'sess-b8') }),
      ]);
      const granted = [a, b].filter((r) => r.outcome === 'granted').length;
      expect(granted).toBe(1);
    } finally {
      await client.from('studios').delete().eq('id', aliasId);
    }
  });

  it('pathless rows share ONE backing: concurrent grants, exactly one winner (r3 P0-3)', async () => {
    // Every pathless studio executes in the SAME shared defaultWorkingDirectory
    // at runtime — r2's independent row locks let two writers into one real
    // tree (Lumen's two-pathless-grants repro). worktree_path is NOT NULL in
    // today's schema, so empty string exercises the pathless class live; the
    // SQL NULL branch is future-proofing (fake-parity unit coverage).
    await clearLeases();
    const make = (agent: string) =>
      client
        .from('studios')
        .insert({
          user_id: userId,
          agent_id: agent,
          repo_root: PATH,
          worktree_path: '',
          branch: `${agent}/itest`,
          status: 'active',
        })
        .select('id')
        .single();
    const { data: n1 } = await make('echo-n1');
    const { data: n2 } = await make('echo-n2');
    try {
      const [a, b] = await Promise.all([
        grantStudioLease(client, { studioId: n1!.id, userId, lease: lease('pr:9000', 'sess-n1') }),
        grantStudioLease(client, { studioId: n2!.id, userId, lease: lease('pr:9001', 'sess-n2') }),
      ]);
      const granted = [a, b].filter((r) => r.outcome === 'granted').length;
      const conflicts = [a, b].filter((r) => r.outcome === 'path-conflict').length;
      expect({ granted, conflicts }).toEqual({ granted: 1, conflicts: 1 });
    } finally {
      await client.from('studios').delete().in('id', [n1!.id, n2!.id]);
    }
  });

  it('worktree_path is immutable while leased, and cannot move onto a leased backing (r3 P0-2)', async () => {
    // Lumen's live repro: grant A@P1 and B@P2, then UPDATE A's path to
    // 'P2/.' — two fresh leases on one canonical backing, installed AROUND
    // the grant fence. The path column is part of the lock's identity.
    await clearLeases();
    const granted = await grantStudioLease(client, {
      studioId: studioA,
      userId,
      lease: lease('pr:9600', 'sess-p2'),
    });
    expect(granted.outcome).toBe('granted');

    // Leased row's path is immutable.
    const { error: movedLeased } = await client
      .from('studios')
      .update({ worktree_path: `${PATH}-elsewhere` })
      .eq('id', studioA);
    expect(movedLeased?.message).toMatch(/immutable while the studio is leased/);

    // An UNLEASED row at a DIFFERENT path cannot move ONTO the leased
    // backing via an alias (studioB shares A's path already, so the repro
    // needs a fresh row at a distinct path — exactly Lumen's A@P1/B@P2 shape).
    const { data: rowC, error: cErr } = await client
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: 'echo-c',
        repo_root: `${PATH}-p2`,
        worktree_path: `${PATH}-p2`,
        branch: 'echo-c/itest',
        status: 'active',
      })
      .select('id')
      .single();
    expect(cErr).toBeNull();
    try {
      const { error: movedOnto } = await client
        .from('studios')
        .update({ worktree_path: `${PATH}/.` })
        .eq('id', rowC!.id);
      expect(movedOnto?.message).toMatch(/collides with a leased studio/);
    } finally {
      await client.from('studios').delete().eq('id', rowC!.id);
    }

    // Textual change within the SAME canonical backing stays free — even on
    // the LEASED row (the immutability rule is about the backing, not the
    // string).
    const { error: sameBacking } = await client
      .from('studios')
      .update({ worktree_path: `${PATH}/.` })
      .eq('id', studioA);
    expect(sameBacking).toBeNull();
    await client.from('studios').update({ worktree_path: PATH }).eq('id', studioA);
  });

  it('studio_path_conflict reports the sibling for the pre-rescue fence (r2)', async () => {
    await clearLeases();
    await client
      .from('studios')
      .update({ lease: lease('pr:9500', 'sess-fence') as never })
      .eq('id', studioA);
    const conflicted = await studioPathConflict(client, { studioId: studioB, userId });
    expect(conflicted).toMatchObject({
      conflict: true,
      conflictStudioId: studioA,
      conflictHolder: expect.objectContaining({ threadKey: 'pr:9500' }),
    });
    await clearLeases();
    const clear = await studioPathConflict(client, { studioId: studioB, userId });
    expect(clear).toEqual({ conflict: false });
  });

  it('handover with a mismatched expected prior is LOST, never granted', async () => {
    await clearLeases();
    const holder = lease('pr:6000', 'sess-holder');
    await client
      .from('studios')
      .update({ lease: holder as never })
      .eq('id', studioA);

    const result = await grantStudioLease(client, {
      studioId: studioA,
      userId,
      lease: lease('pr:6000', 'sess-taker'),
      expectedPrior: { ...holder, heartbeatAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(result.outcome).toBe('lost');
  });

  it('vacant grant refuses non-acquirable statuses', async () => {
    await clearLeases();
    await client.from('studios').update({ status: 'cleaned' }).eq('id', studioB);
    const result = await grantStudioLease(client, {
      studioId: studioB,
      userId,
      lease: lease('pr:7000', 'sess-z'),
    });
    expect(result.outcome).toBe('lost');
    await client.from('studios').update({ status: 'active' }).eq('id', studioB);
  });
});
