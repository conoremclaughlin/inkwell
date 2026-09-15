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
import * as keyedLock from '../utils/keyed-lock';
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

  it('concurrent worktree creations in one repository all succeed — git locks are serialized', async () => {
    // Two concurrent `git worktree add` calls in one repository fail each
    // other on git's own locks (index.lock, .git/worktrees/<name>). Six at
    // once, all must land: the service serializes the git step per repo.
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(repo, leases);
    const create = (
      service as unknown as {
        createWorktree: (
          p: Studio,
          slug: string,
          o: { worktreePath: string }
        ) => Promise<{ worktreePath: string } | null>;
      }
    ).createWorktree.bind(service);
    const slugs = Array.from({ length: 6 }, (_, i) => `concurrent-${RUN}-${i}`);
    const lockSpy = vi.spyOn(keyedLock, 'withKeyedLock');
    try {
      const results = await Promise.all(
        slugs.map((slug) => create(parent, slug, { worktreePath: path.join(studiosRoot, slug) }))
      );
      expect(results.filter((r) => r !== null)).toHaveLength(6);
      // Git's lock collisions are probabilistic — a fast machine can survive
      // six unserialized adds — so also pin that every add went through the
      // per-repository lock, which is what makes CI's contention safe.
      expect(lockSpy).toHaveBeenCalledTimes(6);
      for (const [key] of lockSpy.mock.calls) {
        expect(key).toBe(`git-worktree:${parent.repoRoot}`);
      }
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('a call whose every worktree creation fails still converges on a live winner', async () => {
    // CI, 2026-09-11 (#601 attempt 1): the race loser's three `git worktree
    // add` attempts all failed on the winner's git locks and the winner's
    // path, and the service returned null — a held message in production.
    // The exhausted path must re-read for the winner before failing closed.
    const threadKey = `pr:it-exhausted-${RUN}`;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(repo, leases);
    const sbSlug = `it-agent-${RUN}`;

    const winner = await service.ensureOverflowStudio({
      userId: USER,
      sbSlug,
      parentStudio: parent,
      threadKey,
    });
    expect(winner).not.toBeNull();

    // A second caller whose stale preflight saw no live studio and whose
    // every git step then fails (the CI shape) — forced by making creation
    // fail, and by hiding the winner from its preflight read.
    const proto = StudioOverflowService.prototype as unknown as {
      createWorktree: (...args: unknown[]) => Promise<unknown>;
      firstLiveMatch: (...args: unknown[]) => Promise<unknown>;
    };
    const originalFirstLive = proto.firstLiveMatch;
    let preflightReads = 0;
    const liveSpy = vi
      .spyOn(proto, 'firstLiveMatch')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async function (this: unknown, ...args: any[]) {
        preflightReads += 1;
        // First read is the step-1 reuse preflight: pretend the winner is not
        // there yet (the loser's stale view). Later reads see the truth.
        if (preflightReads === 1) return null;
        return originalFirstLive.apply(this, args);
      });
    const createSpy = vi.spyOn(proto, 'createWorktree').mockResolvedValue(null);
    try {
      const loser = await service.ensureOverflowStudio({
        userId: USER,
        sbSlug,
        parentStudio: parent,
        threadKey,
      });
      expect(createSpy).toHaveBeenCalled();
      expect(loser?.id).toBe(winner!.id);
    } finally {
      createSpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  it('concurrent ensureOverflowStudio calls converge on one studio — later arrivals wait for the in-flight winner', async () => {
    // Lumen, #603: the winner publishes its row only AFTER finishWorktreeSetup
    // (up to the dependency install). A rival that raced it through git and
    // exhausted its candidates in that window rereads before any row exists
    // and returns null — a held message. So same-thread ensures are serialized
    // end to end in-process: the gate holds the winner in setup, the other two
    // must not settle (nor reach setup) until it is released, and then all
    // three hand back the one live row.
    const threadKey = `pr:it-ensure-${RUN}`;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(repo, leases);

    const proto = StudioOverflowService.prototype as unknown as {
      finishWorktreeSetup: (...args: unknown[]) => Promise<unknown>;
    };
    const originalSetup = proto.finishWorktreeSetup;
    let setupArrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let setupEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      setupEntered = resolve;
    });
    const spy = vi
      .spyOn(proto, 'finishWorktreeSetup')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async function (this: unknown, ...args: any[]) {
        setupArrivals += 1;
        setupEntered();
        await gate;
        return originalSetup.apply(this, args);
      });

    let calls: Array<Promise<Studio | null>> = [];
    try {
      const ensure = () =>
        service.ensureOverflowStudio({
          userId: USER,
          sbSlug: `it-agent-${RUN}`,
          parentStudio: parent,
          threadKey,
        });
      calls = [ensure(), ensure(), ensure()];

      // Open the negative window only once the winner is actually held in
      // setup: on a loaded runner its preflight and git step may take longer
      // than the window, and the check must not pass or fail for that reason.
      await entered;

      // With the winner held in setup, no call may settle — settling now
      // means a rival rushed past the winner and answered without its row.
      const settledEarly = await Promise.race([
        Promise.race(calls.map((c, i) => c.then(() => `call ${i} settled`))),
        new Promise<string>((resolve) => setTimeout(() => resolve('none'), 400)),
      ]);
      expect(settledEarly).toBe('none');
      expect(setupArrivals).toBe(1);

      release();
      const results = await Promise.all(calls);

      // Liveness is asked for the way every runtime path asks it (r3).
      const { data: liveRows } = await client
        .from('studios')
        .select('id, slug, worktree_path')
        .eq('parent_studio_id', parent.id)
        .eq('thread_key', threadKey)
        .in('status', ['active', 'idle']);
      expect(liveRows).toHaveLength(1);
      const winner = (liveRows as Array<{ id: string; slug: string; worktree_path: string }>)[0];
      expect(winner.worktree_path.startsWith(studiosRoot)).toBe(true);
      expect(winner.slug).toBeTruthy();

      // r3: EVERY call gets the winner. A null here is `tier: 'refused'` and a
      // HELD message at both divertToOverflow call sites (neither retries).
      const returned = results.filter((r): r is Studio => r !== null);
      expect(returned).toHaveLength(3);
      for (const studio of returned) expect(studio.id).toBe(winner.id);
      // Only the winner ever built a worktree; the others reused its row.
      expect(setupArrivals).toBe(1);
      studioIds.push(winner.id);
    } finally {
      release();
      // Drain whatever was started, so a failed assertion leaves no ensure
      // still running against a restored spy.
      await Promise.allSettled(calls);
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
      sbSlug: `it-agent-${RUN}`,
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
      sbSlug: `it-agent-${RUN}`,
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
