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
import { ThreadKeyService } from '../../services/thread-key/thread-key.service';

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
const ALIAS = 'tkitalias';
const TYPE = 'tkitesttype';
const KEY_PREFIX = `${TYPE}:pin-itest-`;

d('thread-key registry + pin integrity (real DB)', () => {
  let client: SupabaseClient<Database>;
  let repo: ThreadKeyTypesRepository;
  let projectId: string | null = null;
  const threadIds: string[] = [];
  const overrideTypes: string[] = [];
  const raceTypeIds: string[] = [];

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    repo = new ThreadKeyTypesRepository(client);

    // A SUITE-OWNED second user for the owner-change bypass test. Never
    // borrow a real user: fresh isolated CI databases have only the fixture
    // user (single() fails), and on the shared DB the test would mutate a
    // real user's registry (Lumen, PR #516 round 4).
    OTHER_USER = crypto.randomUUID();
    const { error: userErr } = await client.from('users').insert({
      id: OTHER_USER,
      email: `tk-itest-${OTHER_USER.slice(0, 8)}@example.com`,
      username: `tk-itest-${OTHER_USER.slice(0, 8)}`,
    });
    if (userErr) throw userErr;

    // A project with a slug for the integration user, so project-prefixed
    // pinning is exercised. Cleaned up in afterAll.
    const { data, error } = await client
      .from('projects')
      .insert({ user_id: USER, name: `TK Integration ${Date.now()}`, slug: SLUG })
      .select('id')
      .single();
    if (error) throw error;
    projectId = data.id;

    // A suite-owned alias for the project, so alias-prefixed pinning and the
    // alias integrity triggers are exercised. Cleaned up in afterAll (the ON
    // DELETE CASCADE from projects is the backstop).
    const { error: aliasErr } = await client
      .from('project_slug_aliases')
      .insert({ user_id: USER, alias: ALIAS, project_id: data.id });
    if (aliasErr) throw aliasErr;
  });

  afterAll(async () => {
    if (!client) return;
    if (threadIds.length) await client.from('inbox_threads').delete().in('id', threadIds);
    // Scoped to suite-owned rows only — the fixture user is shared, and other
    // suites' overrides are not ours to delete (Lumen, PR #516 round 3).
    if (overrideTypes.length) {
      await client.from('thread_key_types').delete().eq('user_id', USER).in('type', overrideTypes);
    }
    if (raceTypeIds.length) {
      await client.from('thread_key_types').delete().in('id', raceTypeIds);
    }
    await client.from('project_slug_aliases').delete().eq('user_id', USER).eq('alias', ALIAS);
    if (projectId) await client.from('projects').delete().eq('id', projectId);
    // The temp user last: the ON DELETE CASCADE on thread_key_types.user_id
    // clears any registry row a failed assertion left behind.
    if (OTHER_USER) await client.from('users').delete().eq('id', OTHER_USER);
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

  it('the four discussion templates are presence + reuse-only (Conor, 2026-08-24)', async () => {
    // Discussions EXECUTE: they bind without the lock and never get a
    // worktree auto-built. This pins the migration against the real DB so a
    // rebuild cannot silently resurrect write-typed (queueing) discussions.
    for (const type of ['thread', 'spec', 'issue', 'debug']) {
      const effective = await repo.getEffective(USER, type);
      expect(effective).toMatchObject({
        writeIntent: 'presence',
        studioPolicy: 'reuse-only',
        source: 'template',
      });
    }
  });

  it('registry round-trip: override shadows template, reset restores it', async () => {
    const before = await repo.getEffective(USER, 'debug');
    expect(before).toMatchObject({ writeIntent: 'presence', source: 'template' });

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

    try {
      const { error: moveErr } = await client
        .from('thread_key_types')
        .update({ user_id: USER })
        .eq('id', victim!.id);
      expect(moveErr?.message).toMatch(/collides/);
    } finally {
      // finally, not sequential: a failed assertion must not leak the row.
      await client.from('thread_key_types').delete().eq('id', victim!.id);
    }
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
      // Track winners and reset BEFORE asserting: a failed assertion must not
      // leak rows or a mutated slug into later rounds or other suites.
      if (!typeRes.error && typeRes.data) raceTypeIds.push(typeRes.data.id);
      if (!slugRes.error) {
        await client.from('projects').update({ slug: SLUG }).eq('id', projectId!);
      }
      const winners = [typeRes, slugRes].filter((r) => !r.error).length;
      expect(winners).toBe(1);

      if (!typeRes.error) {
        await client.from('thread_key_types').delete().eq('user_id', USER).eq('type', name);
      }
    }
  });

  it('an alias-prefixed thread pins the CANONICAL project slug', async () => {
    const row = await createThread(`${ALIAS}:pr:pin-itest-alias-${Date.now()}`);
    expect(row.key_project).toBe(SLUG);
    expect(row.key_type).toBe('pr');
  });

  it('alias grammar is CHECKed like slugs', async () => {
    const { error } = await client
      .from('project_slug_aliases')
      .insert({ user_id: USER, alias: 'Bad_Alias', project_id: projectId! });
    expect(error?.message).toMatch(/project_slug_aliases_alias_check/);
  });

  it("an alias cannot target another user's project", async () => {
    // OTHER_USER owns a slugged project; USER may not alias it (Lumen round 1
    // blocker 1: the original table resolved user A's keys to user B's slug).
    const { data: otherProj, error: opErr } = await client
      .from('projects')
      .insert({ user_id: OTHER_USER, name: `TK Other ${Date.now()}`, slug: 'tkitestother' })
      .select('id')
      .single();
    expect(opErr).toBeNull();
    try {
      const { error } = await client
        .from('project_slug_aliases')
        .insert({ user_id: USER, alias: 'tkitestforeign', project_id: otherProj!.id });
      expect(error?.message).toMatch(/must belong to the target project's owner/);
    } finally {
      await client.from('projects').delete().eq('id', otherProj!.id);
    }
  });

  it('an aliased project cannot clear its slug, and an owner move carries the alias', async () => {
    const { data: proj2, error: p2Err } = await client
      .from('projects')
      .insert({ user_id: USER, name: `TK Move ${Date.now()}`, slug: 'tkitest2' })
      .select('id')
      .single();
    expect(p2Err).toBeNull();
    try {
      const { error: a2Err } = await client
        .from('project_slug_aliases')
        .insert({ user_id: USER, alias: 'tkitest2alias', project_id: proj2!.id });
      expect(a2Err).toBeNull();

      // Slug clear while aliased: rejected (blocker 2 — the alias would
      // re-parse as a TYPE with no canonical to pin).
      const { error: clearErr } = await client
        .from('projects')
        .update({ slug: null })
        .eq('id', proj2!.id);
      expect(clearErr?.message).toMatch(/cannot clear the slug/);

      // Owner move: the alias follows the project, exactly like the slug
      // itself does (blocker 1's owner-move variant).
      const { error: moveErr } = await client
        .from('projects')
        .update({ user_id: OTHER_USER })
        .eq('id', proj2!.id);
      expect(moveErr).toBeNull();
      const { data: moved } = await client
        .from('project_slug_aliases')
        .select('user_id')
        .eq('alias', 'tkitest2alias')
        .single();
      expect(moved?.user_id).toBe(OTHER_USER);

      // The alias now parses for the NEW owner and no longer for the old.
      const { data: newParse } = await client.rpc('compute_thread_key_pin', {
        p_user_id: OTHER_USER,
        p_key: 'tkitest2alias:pr:1',
      });
      const np = (Array.isArray(newParse) ? newParse[0] : newParse) as NonNullable<typeof newParse>;
      expect(np.o_project).toBe('tkitest2');
      const { data: oldParse } = await client.rpc('compute_thread_key_pin', {
        p_user_id: USER,
        p_key: 'tkitest2alias:pr:1',
      });
      const op = (Array.isArray(oldParse) ? oldParse[0] : oldParse) as NonNullable<typeof oldParse>;
      expect(op.o_project).toBeNull();
      expect(op.o_type).toBe('tkitest2alias');
    } finally {
      await client.from('projects').delete().eq('id', proj2!.id); // cascades the alias
    }
  });

  it('the alias namespace is enforced in BOTH directions', async () => {
    // An alias colliding with a registered (builtin) type is rejected.
    const { error: aliasVsType } = await client
      .from('project_slug_aliases')
      .insert({ user_id: USER, alias: 'pr', project_id: projectId! });
    expect(aliasVsType?.message).toMatch(/collides with a registered thread-key type/);

    // A type override colliding with an existing alias is rejected.
    const { data: typeRow, error: typeVsAlias } = await client
      .from('thread_key_types')
      .insert({ user_id: USER, type: ALIAS, write_intent: 'write', studio_policy: 'reuse-only' })
      .select('id')
      .single();
    if (typeRow) raceTypeIds.push(typeRow.id);
    expect(typeVsAlias?.message).toMatch(/collides with your project slug alias/);
  });

  it('the alias-insert vs slug-clear race has exactly one winner', async () => {
    // Without the shared 'project-alias:<id>' advisory lock this is a write
    // skew: the alias insert checks the project while the slug clear checks
    // the aliases, and each side passes its own snapshot check.
    const { data: proj3, error: p3Err } = await client
      .from('projects')
      .insert({ user_id: USER, name: `TK Race ${Date.now()}`, slug: 'tkitest3' })
      .select('id')
      .single();
    expect(p3Err).toBeNull();
    try {
      const [aliasRes, clearRes] = await Promise.all([
        client
          .from('project_slug_aliases')
          .insert({ user_id: USER, alias: 'tkitest3alias', project_id: proj3!.id }),
        client.from('projects').update({ slug: null }).eq('id', proj3!.id),
      ]);
      const aliasWon = aliasRes.error === null;
      const clearWon = clearRes.error === null;
      expect(aliasWon !== clearWon).toBe(true);
    } finally {
      await client.from('projects').delete().eq('id', proj3!.id);
    }
  });

  it('TS parser and SQL compute_thread_key_pin agree (parity guard)', async () => {
    // The lookup comes from the PRODUCTION loader, so this also guards the
    // service's alias join against the SQL alias branch.
    const lookup = await new ThreadKeyService(client).projectSlugLookup(USER);
    const cases = [
      `${SLUG}:pr:42`, // project-prefixed
      `${SLUG}:pr:42:with:colons`, // composite id under a project
      `${SLUG}:onlytwo`, // registered slug but only two segments → type
      `${ALIAS}:pr:42`, // alias-prefixed → canonical slug
      `${ALIAS}:pr:42:with:colons`, // composite id under an alias
      `${ALIAS}:onlytwo`, // alias with only two segments → type
      'openclaw:issue:15', // unregistered first segment → type
      'pr:999', // plain
      'thread:review-queue:aug', // colons in id
      'standup:2026-08-18', // unregistered type
    ];
    for (const key of cases) {
      const ts = parseThreadKey(key, lookup);
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
