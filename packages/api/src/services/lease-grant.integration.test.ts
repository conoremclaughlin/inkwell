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
import { grantStudioLease } from './lease-grant';
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

  it('a STALE sibling lease does not block — the sweep owns it, not us', async () => {
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
    expect(result.outcome).toBe('granted');
  });

  it('a SAME-thread sibling lease does not block — one thread, one tree, two rows', async () => {
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
    expect(result.outcome).toBe('granted');
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
