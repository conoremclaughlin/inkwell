/**
 * Thread-key registry + pin integrity — Integration Tests (real DB)
 *
 * Required by PR #516 round 2 (Lumen condition 8): the unit tier mocks the
 * client, which is exactly the layer where this feature's guarantees live —
 * DB triggers (pinning, immutability, namespace serialization) are invisible
 * to mocks by construction.
 *
 * Also carries the TS↔SQL PARSER PARITY test: pinning authority is the
 * plpgsql compute_thread_key_pin trigger, while patterns/tooling use the TS
 * parser. Two implementations of one grammar are tolerable only while a test
 * fails when they drift.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically in CI / when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';
import type { Database } from '../supabase/types';
import { ThreadKeyTypesRepository } from './thread-key-types.repository';
import { parseThreadKey } from '../../services/thread-key/parser';

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
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const d = available ? describe : describe.skip;

const USER = INTEGRATION_TEST_USER_ID;
let OTHER_USER: string;
const SLUG = 'tkitest';
const TYPE = 'tkitesttype';
const KEY_PREFIX = `${TYPE}:pin-itest-`;

d('thread-key registry + pin integrity (real DB)', () => {
  let client: SupabaseClient<Database>;
  let repo: ThreadKeyTypesRepository;
  let projectId: string | null = null;
  const threadIds: string[] = [];
  const overrideTypes: string[] = [];

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    repo = new ThreadKeyTypesRepository(client);

    // Any user other than the fixture user, for the owner-change bypass test.
    const { data: otherUser, error: otherErr } = await client
      .from('users')
      .select('id')
      .neq('id', USER)
      .limit(1)
      .single();
    if (otherErr) throw otherErr;
    OTHER_USER = otherUser.id;

    // A project with a slug for the integration user, so project-prefixed
    // pinning is exercised. Cleaned up in afterAll.
    const { data, error } = await client
      .from('projects')
      .insert({ user_id: USER, name: `TK Integration ${Date.now()}`, slug: SLUG })
      .select('id')
      .single();
    if (error) throw error;
    projectId = data.id;
  });

  afterAll(async () => {
    if (!client) return;
    if (threadIds.length) await client.from('inbox_threads').delete().in('id', threadIds);
    // Scoped to suite-owned rows only — the fixture user is shared, and other
    // suites' overrides are not ours to delete (Lumen, PR #516 round 3).
    if (overrideTypes.length) {
      await client.from('thread_key_types').delete().eq('user_id', USER).in('type', overrideTypes);
    }
    if (projectId) await client.from('projects').delete().eq('id', projectId);
  });

  async function createThread(threadKey: string) {
    const { data, error } = await client
      .from('inbox_threads')
      .insert({ thread_key: threadKey, user_id: USER, created_by_agent_id: 'echo' })
      .select('id, key_project, key_type, key_id')
      .single();
    if (error) throw error;
    threadIds.push(data.id);
    return data;
  }

  it('the DB trigger pins an insert that supplies no key_* values', async () => {
    const row = await createThread(`${SLUG}:pr:${Date.now()}`);
    expect(row.key_project).toBe(SLUG);
    expect(row.key_type).toBe('pr');
    expect(row.key_id).toMatch(/^\d+$/);
  });

  it('unprefixed and unregistered-first-segment keys pin as (null, type, id)', async () => {
    const row = await createThread(`${KEY_PREFIX}${Date.now()}:with:colons`);
    expect(row.key_project).toBeNull();
    expect(row.key_type).toBe(TYPE);
    expect(row.key_id).toContain(':with:colons');
  });

  it('pinned identity and thread_key are immutable', async () => {
    const row = await createThread(`${KEY_PREFIX}immutable-${Date.now()}`);

    const { error: pinErr } = await client
      .from('inbox_threads')
      .update({ key_type: 'issue' })
      .eq('id', row.id);
    expect(pinErr?.message).toMatch(/immutable/);

    const { error: keyErr } = await client
      .from('inbox_threads')
      .update({ thread_key: 'renamed:key' })
      .eq('id', row.id);
    expect(keyErr?.message).toMatch(/immutable/);

    // Ordinary updates still pass.
    const { error: okErr } = await client
      .from('inbox_threads')
      .update({ title: 'still writable' })
      .eq('id', row.id);
    expect(okErr).toBeNull();
  });

  it('the namespace is DB-serialized in both directions', async () => {
    // type name colliding with the user's project slug
    const { error: typeErr } = await client
      .from('thread_key_types')
      .insert({ user_id: USER, type: SLUG, write_intent: 'write', studio_policy: 'reuse-only' });
    expect(typeErr?.message).toMatch(/collides/);

    // project slug colliding with a shipped template type
    const { error: slugErr } = await client
      .from('projects')
      .update({ slug: 'pr' })
      .eq('id', projectId!);
    expect(slugErr?.message).toMatch(/collides/);
  });

  it('registry round-trip: override shadows template, reset restores it', async () => {
    const before = await repo.getEffective(USER, 'debug');
    expect(before).toMatchObject({ writeIntent: 'write', source: 'template' });

    overrideTypes.push('debug');
    await repo.setOverride(USER, 'debug', { writeIntent: 'write', studioPolicy: 'provision' });
    const overridden = await repo.getEffective(USER, 'debug');
    expect(overridden).toMatchObject({ studioPolicy: 'provision', source: 'override' });

    const removed = await repo.clearOverride(USER, 'debug');
    expect(removed).toBe(true);
    const after = await repo.getEffective(USER, 'debug');
    expect(after).toMatchObject({ studioPolicy: 'reuse-only', source: 'template' });
  });

  it('forged caller-supplied pins are OVERWRITTEN by the computed identity', async () => {
    // Round-3 blocker 1 (Lumen): the trigger previously deferred to non-null
    // caller values, so the round-one app binary (or any writer) could store
    // a wrong identity verbatim. Authority that defers to its caller is not
    // authority — the DB computes unconditionally.
    const marker = `forged-${Date.now()}`;
    const { data, error } = await client
      .from('inbox_threads')
      .insert({
        thread_key: `${SLUG}:issue:${marker}`,
        user_id: USER,
        created_by_agent_id: 'echo',
        key_project: 'FORGED',
        key_type: 'FORGED',
        key_id: 'FORGED',
      })
      .select('id, key_project, key_type, key_id')
      .single();
    expect(error).toBeNull();
    threadIds.push(data!.id);
    expect(data).toMatchObject({ key_project: SLUG, key_type: 'issue', key_id: marker });
  });

  it('moving a type override to a colliding owner is rejected (owner-change bypass)', async () => {
    // Round-3 blocker 2 (Lumen): the namespace triggers fired on name changes
    // only, so type 'x' created under user B could be MOVED to user A who
    // owns project slug 'x'. They now fire on owner changes too.
    const { data: victim, error: insErr } = await client
      .from('thread_key_types')
      .insert({
        user_id: OTHER_USER,
        type: SLUG,
        write_intent: 'write',
        studio_policy: 'reuse-only',
      })
      .select('id')
      .single();
    expect(insErr).toBeNull();

    const { error: moveErr } = await client
      .from('thread_key_types')
      .update({ user_id: USER })
      .eq('id', victim!.id);
    expect(moveErr?.message).toMatch(/collides/);

    await client.from('thread_key_types').delete().eq('id', victim!.id);
  });

  it('the namespace race is GENUINELY concurrent: exactly one winner', async () => {
    // Two simultaneous claims on the same name from opposite sides of the
    // namespace. The advisory xact lock serializes them; the cross-check
    // rejects the loser. Run several rounds with fresh names.
    for (let round = 0; round < 5; round += 1) {
      const name = `race-${Date.now()}-${round}`;
      const claimType = client
        .from('thread_key_types')
        .insert({ user_id: USER, type: name, write_intent: 'write', studio_policy: 'reuse-only' })
        .select('id')
        .single();
      const claimSlug = client
        .from('projects')
        .update({ slug: name })
        .eq('id', projectId!)
        .select('id')
        .single();

      const [typeRes, slugRes] = await Promise.all([claimType, claimSlug]);
      const winners = [typeRes, slugRes].filter((r) => !r.error).length;
      expect(winners).toBe(1);

      // Reset for the next round.
      if (!typeRes.error) {
        await client.from('thread_key_types').delete().eq('user_id', USER).eq('type', name);
      }
      if (!slugRes.error) {
        await client.from('projects').update({ slug: SLUG }).eq('id', projectId!);
      }
    }
  });

  it('TS parser and SQL compute_thread_key_pin agree (parity guard)', async () => {
    const slugs = new Set([SLUG]);
    const cases = [
      `${SLUG}:pr:42`, // project-prefixed
      `${SLUG}:pr:42:with:colons`, // composite id under a project
      `${SLUG}:onlytwo`, // registered slug but only two segments → type
      'openclaw:issue:15', // unregistered first segment → type
      'pr:999', // plain
      'thread:review-queue:aug', // colons in id
      'standup:2026-08-18', // unregistered type
    ];
    for (const key of cases) {
      const ts = parseThreadKey(key, slugs);
      const { data, error } = await client.rpc('compute_thread_key_pin', {
        p_user_id: USER,
        p_key: key,
      });
      expect(error).toBeNull();
      const sql = (Array.isArray(data) ? data[0] : data) as NonNullable<typeof data>;
      expect({ project: sql.o_project, type: sql.o_type, id: sql.o_id }).toEqual({
        project: ts?.project ?? null,
        type: ts?.type ?? null,
        id: ts?.id ?? null,
      });
    }
  });
});
