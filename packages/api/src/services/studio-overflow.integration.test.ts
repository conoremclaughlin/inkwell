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
 *   3. end-to-end: two concurrent ensureOverflowStudio calls held at a
 *      barrier past the preflight leave exactly ONE live studio.
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
  const studioIds: string[] = [];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    repo = new StudiosRepository(client as SupabaseClient<never>);

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

    // Worktrees the service created live beside the repo as `<repo>--*`.
    const dir = path.dirname(repoRoot);
    const base = path.basename(repoRoot);
    const { readdir } = await import('fs/promises');
    for (const entry of await readdir(dir)) {
      if (entry.startsWith(`${base}--`)) {
        await rm(path.join(dir, entry), { recursive: true, force: true });
      }
    }
    await rm(repoRoot, { recursive: true, force: true });
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

    // A cleaned row for the same thread sits outside the index …
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
    await client
      .from('studios')
      .update({ thread_key: threadKey, cleaned_at: new Date().toISOString() })
      .eq('id', cleaned.id);

    // … and reviving it while the winner is live must fail.
    const { error } = await client
      .from('studios')
      .update({ cleaned_at: null })
      .eq('id', cleaned.id);
    expect(error?.message).toMatch(/duplicate key|uniq_live_ephemeral_studio_per_parent_thread/);
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

      const { data: liveRows } = await client
        .from('studios')
        .select('id, slug')
        .eq('parent_studio_id', parent.id)
        .eq('thread_key', threadKey)
        .is('cleaned_at', null)
        .is('archived_at', null);
      expect(liveRows).toHaveLength(1);

      const returned = results.filter((r): r is Studio => r !== null);
      expect(returned.length).toBeLessThanOrEqual(1);
      for (const studio of returned) {
        expect(studio.id).toBe((liveRows as Array<{ id: string }>)[0].id);
      }
      studioIds.push((liveRows as Array<{ id: string }>)[0].id);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
