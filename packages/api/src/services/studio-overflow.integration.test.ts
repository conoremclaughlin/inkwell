/**
 * Overflow studio concurrency — Integration Tests (real DB + real git)
 *
 * The convergence claim lives in the partial unique index
 * uniq_live_ephemeral_studio_per_parent_thread, which unit mocks cannot see
 * by construction (Lumen #537 r2 P1): the service's variant preflight is
 * check-then-act, so two concurrent ensures can both observe no row and
 * insert on DIFFERENT variants — different slugs and worktree paths, so the
 * (worktree_path, agent_id) index cannot arbitrate. The fence is the DB
 * index; these tests prove it at the seams the race actually crosses:
 *   1. two racing inserts for one (parent, threadKey) — exactly one wins;
 *   2. a revive UPDATE back into the live predicate loses to a live winner;
 *   3. a runtime-live row carrying an archive stamp still holds the fence
 *      (r3: the index and the runtime must agree on what "live" means);
 *   4. end-to-end: two concurrent ensureOverflowStudio calls held at a
 *      barrier past the preflight leave exactly ONE live studio — and BOTH
 *      calls return it (r3: the loser converges instead of failing, because
 *      no divertToOverflow call site retries a null).
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials/DB are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { rm, mkdtemp } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';
import { StudiosRepository, type Studio } from '../data/repositories/studios.repository';
import { StudioOverflowService } from './studio-overflow.service';
import type { StudioLeaseService } from './studio-lease.service';

const execFileAsync = promisify(execFile);

const projectRoot = path.resolve(__dirname, '../../../../');
const envLocalPath = path.resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const USER = INTEGRATION_TEST_USER_ID;
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!available)('overflow studio live-uniqueness (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: SupabaseClient<any>;
  let repo: StudiosRepository;
  let parent: Studio;
  let repoRoot: string;
  let studiosRoot: string;
  let prevStudiosRoot: string | undefined;
  const studioIds: string[] = [];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    repo = new StudiosRepository(client as SupabaseClient<never>);

    // Ephemeral mints land under an isolated canonical root, never the real
    // ~/.ink/studios (spec v8).
    prevStudiosRoot = process.env.INK_STUDIOS_ROOT;
    studiosRoot = await mkdtemp(path.join(tmpdir(), `ink-studios-it-${RUN}-`));
    process.env.INK_STUDIOS_ROOT = studiosRoot;

    repoRoot = await mkdtemp(path.join(tmpdir(), `overflow-it-${RUN}-`));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.email=test@test',
        '-c',
        'user.name=test',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: repoRoot }
    );

    parent = await repo.create({
      userId: USER,
      repoRoot,
      worktreePath: repoRoot,
      branch: 'main',
      baseBranch: 'main',
      purpose: 'overflow integration fixture parent',
      ephemeral: false,
    });
    studioIds.push(parent.id);
  }, 30_000);

  afterAll(async () => {
    // Children first — parent_studio_id references the fixture parent.
    const { data } = await client.from('studios').select('id').eq('parent_studio_id', parent.id);
    for (const row of (data ?? []) as Array<{ id: string }>) studioIds.unshift(row.id);
    for (const id of [...new Set(studioIds)].filter((id) => id !== parent.id)) {
      await client.from('studios').delete().eq('id', id);
    }
    await client.from('studios').delete().eq('id', parent.id);

    // Legacy-convention leftovers beside the repo (fixture rows use these
    // paths), plus everything under the isolated canonical root.
    const dir = path.dirname(repoRoot);
    const base = path.basename(repoRoot);
    const { readdir } = await import('fs/promises');
    for (const entry of await readdir(dir)) {
      if (entry.startsWith(`${base}--`)) {
        await rm(path.join(dir, entry), { recursive: true, force: true });
      }
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(studiosRoot, { recursive: true, force: true });
    if (prevStudiosRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
    else process.env.INK_STUDIOS_ROOT = prevStudiosRoot;
  }, 30_000);

  it('two racing inserts for one (parent, threadKey) — exactly one wins', async () => {
    const threadKey = `pr:it-race-${RUN}`;
    const mk = (variant: string) =>
      repo.create({
        userId: USER,
        repoRoot,
        worktreePath: `${repoRoot}--race-${variant}`,
        branch: `it/eph/race-${variant}`,
        ephemeral: true,
        parentStudioId: parent.id,
        threadKey,
      });

    const results = await Promise.allSettled([mk('primary'), mk('hash')]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(String((losses[0] as PromiseRejectedResult).reason)).toMatch(
      /duplicate key|uniq_live_ephemeral_studio_per_parent_thread/
    );
    studioIds.push((wins[0] as PromiseFulfilledResult<Studio>).value.id);
  });

  it('a revive back into the live predicate loses to a live winner', async () => {
    const threadKey = `pr:it-revive-${RUN}`;
    const winner = await repo.create({
      userId: USER,
      repoRoot,
      worktreePath: `${repoRoot}--revive-primary`,
      branch: 'it/eph/revive-primary',
      ephemeral: true,
      parentStudioId: parent.id,
      threadKey,
    });
    studioIds.push(winner.id);

    // A cleaned row for the same thread sits outside the fence — and as of r3
    // it is the row's STATUS that puts it there, not its cleaned_at stamp.
    const cleaned = await repo.create({
      userId: USER,
      repoRoot,
      worktreePath: `${repoRoot}--revive-hash`,
      branch: 'it/eph/revive-hash',
      ephemeral: true,
      parentStudioId: parent.id,
      threadKey: `pr:it-revive-placeholder-${RUN}`,
    });
    studioIds.push(cleaned.id);
    const { error: parkError } = await client
      .from('studios')
      .update({
        thread_key: threadKey,
        status: 'cleaned',
        cleaned_at: new Date().toISOString(),
      })
      .eq('id', cleaned.id);
    expect(parkError).toBeNull();

    // … and reviving it — status back to live, exactly what the service's
    // revive path writes — while the winner is live must fail.
    const { error } = await client
      .from('studios')
      .update({ status: 'active', cleaned_at: null })
      .eq('id', cleaned.id);
    expect(error?.message).toMatch(/duplicate key|uniq_live_ephemeral_studio_per_parent_thread/);
  });

  // r3 (Lumen): the fence and the runtime must agree on what "live" means.
  // The r2 predicate keyed on cleaned_at/archived_at while every admission
  // path keys on status — so the r2 dedupe's own output (archived_at stamped,
  // status left 'active') was runtime-live yet invisible to the index, and a
  // second live row could be inserted right beside it.
  it('a row that is runtime-live but archive-stamped still holds the fence', async () => {
    const threadKey = `pr:it-status-fence-${RUN}`;

    const first = await repo.create({
      userId: USER,
      repoRoot,
      worktreePath: `${repoRoot}--status-fence-primary`,
      branch: 'it/eph/status-fence-primary',
      ephemeral: true,
      parentStudioId: parent.id,
      threadKey,
    });
    studioIds.push(first.id);

    // Exactly the shape the r2 dedupe produced: archived timestamp set,
    // status still runtime-live, so reuse/admission would happily return it.
    const { error: stampError } = await client
      .from('studios')
      .update({ archived_at: new Date().toISOString(), status: 'active' })
      .eq('id', first.id);
    expect(stampError).toBeNull();

    const reread = await repo.findById(first.id);
    expect(reread?.status).toBe('active');
    expect(reread?.archivedAt).not.toBeNull();

    // Under the r2 predicate this insert SUCCEEDED — the archive stamp took
    // `first` out of the index — leaving two runtime-live studios for one
    // thread. Under the status predicate it loses.
    await expect(
      repo.create({
        userId: USER,
        repoRoot,
        worktreePath: `${repoRoot}--status-fence-hash`,
        branch: 'it/eph/status-fence-hash',
        ephemeral: true,
        parentStudioId: parent.id,
        threadKey,
      })
    ).rejects.toThrow(/duplicate key|uniq_live_ephemeral_studio_per_parent_thread/);

    const { data: liveRows } = await client
      .from('studios')
      .select('id')
      .eq('parent_studio_id', parent.id)
      .eq('thread_key', threadKey)
      .in('status', ['active', 'idle']);
    expect(liveRows).toHaveLength(1);
  });

  it('two concurrent ensureOverflowStudio calls leave exactly one live studio', async () => {
    const threadKey = `pr:it-ensure-${RUN}`;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(repo, leases);

    // Rendezvous seam: both calls must finish the variant preflight (reach
    // worktree creation) before either is allowed to create — the exact
    // interleaving of the r2 repro.
    const proto = StudioOverflowService.prototype as unknown as {
      createWorktree: (...args: unknown[]) => Promise<unknown>;
    };
    const original = proto.createWorktree;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(proto, 'createWorktree')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async function (this: unknown, ...args: any[]) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        return original.apply(this, args);
      });

    try {
      const ensure = () =>
        service.ensureOverflowStudio({
          userId: USER,
          agentId: `it-agent-${RUN}`,
          parentStudio: parent,
          threadKey,
        });
      const results = await Promise.all([ensure(), ensure()]);

      // Liveness is asked for the way every runtime path asks it (r3).
      const { data: liveRows } = await client
        .from('studios')
        .select('id, slug, worktree_path')
        .eq('parent_studio_id', parent.id)
        .eq('thread_key', threadKey)
        .in('status', ['active', 'idle']);
      expect(liveRows).toHaveLength(1);

      // spec v8: the mint materialized under the canonical root, and the row
      // carries a real slug even though the path no longer encodes one.
      const winner = (liveRows as Array<{ id: string; slug: string; worktree_path: string }>)[0];
      expect(winner.worktree_path.startsWith(studiosRoot)).toBe(true);
      expect(winner.slug).toBeTruthy();

      // r3: BOTH calls get the winner. The loser used to return null, and
      // since neither divertToOverflow call site retries, that null became
      // `tier: 'refused'` and a HELD message — the correctness fix silently
      // reintroducing symptom #3 of the bug this PR fixes. Asserting
      // "at most one non-null" would pass on that regression; this does not.
      const returned = results.filter((r): r is Studio => r !== null);
      expect(returned).toHaveLength(2);
      for (const studio of returned) {
        expect(studio.id).toBe((liveRows as Array<{ id: string }>)[0].id);
      }
      studioIds.push((liveRows as Array<{ id: string }>)[0].id);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  // spec v8: root paths don't follow the `<repo>--<slug>` folder convention
  // deriveStudioSlug expects, so create() must be handed the slug explicitly.
  // If it were derived, this row's slug would be NULL, the second ensure's
  // preflight would miss it, and a SECOND studio would be minted for the
  // same thread — the exact class of split this whole arc exists to end.
  it('a root-minted studio round-trips its slug — the second ensure reuses, not re-mints', async () => {
    const threadKey = `pr:it-reuse-${RUN}`;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(repo, leases);

    const first = await service.ensureOverflowStudio({
      userId: USER,
      agentId: `it-agent-${RUN}`,
      parentStudio: parent,
      threadKey,
    });
    expect(first).not.toBeNull();
    studioIds.push(first!.id);
    expect(first!.worktreePath.startsWith(studiosRoot)).toBe(true);

    const row = await repo.findById(first!.id);
    expect(row?.slug).toBeTruthy();
    expect(row?.slug?.endsWith(`--pr-it-reuse-${RUN}`)).toBe(true);

    const second = await service.ensureOverflowStudio({
      userId: USER,
      agentId: `it-agent-${RUN}`,
      parentStudio: parent,
      threadKey,
    });
    expect(second?.id).toBe(first!.id);

    const { data: liveRows } = await client
      .from('studios')
      .select('id')
      .eq('parent_studio_id', parent.id)
      .eq('thread_key', threadKey)
      .in('status', ['active', 'idle']);
    expect(liveRows).toHaveLength(1);
  }, 30_000);
});
