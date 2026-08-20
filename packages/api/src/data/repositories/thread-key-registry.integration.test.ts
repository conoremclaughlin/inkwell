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
const SLUG = 'tkitest';
const TYPE = 'tkitesttype';
const KEY_PREFIX = `${TYPE}:pin-itest-`;

d('thread-key registry + pin integrity (real DB)', () => {
  let client: SupabaseClient<Database>;
  let repo: ThreadKeyTypesRepository;
  let projectId: string | null = null;
  const threadIds: string[] = [];

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    repo = new ThreadKeyTypesRepository(client);

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
    await client.from('thread_key_types').delete().eq('user_id', USER);
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

    await repo.setOverride(USER, 'debug', { writeIntent: 'write', studioPolicy: 'provision' });
    const overridden = await repo.getEffective(USER, 'debug');
    expect(overridden).toMatchObject({ studioPolicy: 'provision', source: 'override' });

    const removed = await repo.clearOverride(USER, 'debug');
    expect(removed).toBe(true);
    const after = await repo.getEffective(USER, 'debug');
    expect(after).toMatchObject({ studioPolicy: 'reuse-only', source: 'template' });
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
      const { data, error } = await client.rpc(
        'compute_thread_key_pin' as never,
        {
          p_user_id: USER,
          p_key: key,
        } as never
      );
      expect(error).toBeNull();
      const sql = (Array.isArray(data) ? data[0] : data) as {
        o_project: string | null;
        o_type: string | null;
        o_id: string | null;
      };
      expect({ project: sql.o_project, type: sql.o_type, id: sql.o_id }).toEqual({
        project: ts?.project ?? null,
        type: ts?.type ?? null,
        id: ts?.id ?? null,
      });
    }
  });
});
