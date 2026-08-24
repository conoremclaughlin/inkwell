/**
 * Concurrent task_group creation — per-user numbering must not collide.
 *
 * `assign_task_group_number_and_slug()` assigns group_number as
 * `MAX(group_number) + 1` for the user. That read cannot see another
 * transaction's uncommitted row, so two inserts for the same user that
 * overlap both claim the same number and the second violates
 * idx_task_groups_user_group_number:
 *
 *   duplicate key value violates unique constraint "idx_task_groups_user_group_number"
 *
 * This turned CI red on main — vitest runs integration files in parallel
 * against one seeded user — but it is not a test artifact. The same window
 * is open whenever two agents create a group for the same user at once,
 * which is ordinary behaviour here.
 *
 * The suite-owned rows are deleted in afterAll. Leaked rows cannot cause
 * this failure (a stale row only pushes MAX higher), so cleanup is hygiene,
 * not part of the contract under test.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY; skipped when
 * unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';

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
const TEST_USER_ID: string | undefined = INTEGRATION_TEST_USER_ID;
const canRun = !!SUPABASE_URL && !!SUPABASE_KEY && !!TEST_USER_ID;

/**
 * Enough overlap to lose the race reliably. With the unguarded trigger a
 * batch of 8 fails essentially every run; one or two inserts might not
 * overlap at all and would make this test lie by passing.
 */
const CONCURRENT_CREATES = 8;

describe.skipIf(!canRun)('task_group per-user numbering under concurrency', () => {
  let client: SupabaseClient;
  let repo: InstanceType<typeof import('./task-groups.repository').TaskGroupsRepository>;
  const createdGroupIds: string[] = [];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { TaskGroupsRepository } = await import('./task-groups.repository');
    repo = new TaskGroupsRepository(client);
  }, 15_000);

  afterAll(async () => {
    if (!client || createdGroupIds.length === 0) return;
    await client.from('task_groups').delete().in('id', createdGroupIds);
  }, 15_000);

  it('assigns every concurrent create a distinct group_number', async () => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CREATES }, (_, i) =>
        repo.create({
          user_id: TEST_USER_ID!,
          // Distinct titles: this test is about group_number, and identical
          // titles would also exercise the slug index, blurring which
          // constraint failed.
          title: `__numbering_race_${stamp}_${i}`,
          description: 'Integration test — safe to delete',
          priority: 'low',
          tags: ['__test'],
          metadata: { seeded: true },
        })
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') createdGroupIds.push(result.value.id);
    }

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      'concurrent creates for one user must not collide on group_number'
    ).toEqual([]);

    const numbers = results
      .filter(
        (r): r is PromiseFulfilledResult<{ group_number: number }> => r.status === 'fulfilled'
      )
      .map((r) => r.value.group_number);

    expect(numbers).toHaveLength(CONCURRENT_CREATES);
    expect(new Set(numbers).size).toBe(CONCURRENT_CREATES);
    // Deliberately not asserting a contiguous range. Twelve integration
    // suites share this seeded user and vitest runs files in parallel, so a
    // sibling suite creating a group mid-test legitimately interleaves a
    // number into ours. Asserting contiguity here would fail on correct
    // behaviour — the contract is that no create is refused, which the
    // rejected-list assertion above already pins.
  }, 60_000);

  it('resolves duplicate titles to distinct slugs under concurrency', async () => {
    // Same race, other unique index: identical titles resolve the same
    // candidate slug, and the collision branch reads a MAX that a concurrent
    // insert is about to invalidate.
    const title = `__slug_race_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        repo.create({
          user_id: TEST_USER_ID!,
          title,
          description: 'Integration test — safe to delete',
          priority: 'low',
          tags: ['__test'],
          metadata: { seeded: true },
        })
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') createdGroupIds.push(result.value.id);
    }

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      'identical titles created concurrently must not collide on slug'
    ).toEqual([]);

    const slugs = results
      .filter((r): r is PromiseFulfilledResult<{ slug: string | null }> => r.status === 'fulfilled')
      .map((r) => r.value.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  }, 60_000);
});
