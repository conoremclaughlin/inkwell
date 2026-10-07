/**
 * Overflow studio unit tests — deterministic naming, verified reuse, and the
 * teardown fence. Worktree creation itself is git-heavy and covered by the
 * lease integration flow; here we prove the ladder's step 1 (reuse) only
 * matches the exact (parent, threadKey) ephemeral, and that destruction is
 * gated on winning the teardown claim.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, access, symlink, readFile, lstat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

/** A real (tiny) git repo, for tests where worktree creation must SUCCEED. */
async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'overflow-repo-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir }
  );
  return dir;
}
import {
  threadSlug,
  slugHash,
  overflowSlug,
  StudioOverflowService,
  pullRequestDetachTarget,
} from './studio-overflow.service';
import type { Studio, StudiosRepository } from '../data/repositories/studios.repository';
import type { StudioLeaseService, StudioLease } from './studio-lease.service';
import { readCheckoutPin } from './studio-lease.service';
import { ephemeralWorktreePath } from './studio-paths';

/**
 * The completion routine (`ink init` through this checkout's CLI, task
 * c3b34be8) is mocked: its file writes are pinned in its own suites, and
 * running the real CLI here would reach a live server for skills. What this
 * suite pins is the boundary — that it runs after the row exists and, for a
 * review checkout, after the PR-supplied startup config was quarantined.
 */
const completion = vi.hoisted(() => ({
  calls: [] as Array<{
    worktreePath: string;
    studioId?: string;
    sbSlug: string;
    present: string[];
    permissionProfile?: string;
  }>,
}));
vi.mock('./studio-complete', async () => {
  const { lstat: lstatAt } = await import('fs/promises');
  const pathMod = await import('path');
  return {
    completeStudioViaCli: vi.fn(
      async (
        worktreePath: string,
        opts: { sbSlug: string; studioId?: string; permissionProfile?: string }
      ) => {
        const present: string[] = [];
        for (const rel of ['.mcp.json', '.env.local', '.env', '.claude', '.codex', '.gemini']) {
          if (
            await lstatAt(pathMod.join(worktreePath, rel)).then(
              () => true,
              () => false
            )
          ) {
            present.push(rel);
          }
        }
        completion.calls.push({
          worktreePath,
          studioId: opts.studioId,
          sbSlug: opts.sbSlug,
          present,
          permissionProfile: opts.permissionProfile,
        });
        return { ok: true, complete: true, missing: [] };
      }
    ),
    ensureStudioComplete: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
  };
});

// What is running from a worktree is read from the host by default. This
// suite pins the teardown's decisions, so the default here is "nothing", and
// the in-use cases inject their own answer (worktree-in-use.test.ts runs the
// real check).
vi.mock('./worktree-in-use', () => ({
  worktreeInUse: vi.fn(async () => ({ state: 'idle' })),
}));

// Every ephemeral mint in this file materializes under an isolated root —
// never the real ~/.ink/studios. Restored so parallel-worker siblings that
// share this process env are unaffected after the file completes.
let studiosRootOverride: string;
let prevStudiosRoot: string | undefined;
beforeAll(async () => {
  prevStudiosRoot = process.env.INK_STUDIOS_ROOT;
  studiosRootOverride = await mkdtemp(path.join(tmpdir(), 'ink-studios-root-'));
  process.env.INK_STUDIOS_ROOT = studiosRootOverride;
});
afterAll(async () => {
  if (prevStudiosRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
  else process.env.INK_STUDIOS_ROOT = prevStudiosRoot;
  await rm(studiosRootOverride, { recursive: true, force: true });
});

function makeStudio(overrides: Partial<Studio> = {}): Studio {
  return {
    id: 'parent-1',
    userId: 'user-1',
    sbSlug: 'lumen',
    sessionId: null,
    repoRoot: '/ws/pcp/inkwell',
    worktreePath: '/ws/pcp/inkwell--lumen-review',
    branch: 'main',
    baseBranch: 'main',
    purpose: null,
    workType: null,
    slug: 'lumen-review',
    roleTemplate: null,
    defaultProjectId: 'project-1',
    status: 'active',
    metadata: {},
    lease: null,
    ephemeral: false,
    parentStudioId: null,
    threadKey: null,
    expiresAt: null,
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
    cleanedAt: null,
    ...overrides,
  };
}

function makeTeardownClaim(): StudioLease {
  const now = new Date().toISOString();
  return {
    sessionId: '00000000-0000-0000-0000-000000000000',
    threadKey: '__quarantine__',
    sbSlug: 'system',
    acquiredAt: now,
    heartbeatAt: now,
    quarantined: true,
  };
}

describe('threadSlug', () => {
  it('derives filesystem-safe slugs from threadKeys', () => {
    expect(threadSlug('pr:476')).toBe('pr-476');
    expect(threadSlug('spec:trigger-studio-routing')).toBe('spec-trigger-studio-routing');
    expect(threadSlug('inktrade:pr:42')).toBe('inktrade-pr-42');
  });

  it('is deterministic — same input, same slug, every time', () => {
    expect(threadSlug('pr:476')).toBe(threadSlug('pr:476'));
    expect(slugHash('pr:476')).toBe(slugHash('pr:476'));
  });

  it('never returns an empty slug', () => {
    expect(threadSlug(':::')).toBe('thread');
  });

  it('distinct long threadKeys collide on slug but not on hash', () => {
    const a = `thread:${'x'.repeat(60)}alpha`;
    const b = `thread:${'x'.repeat(60)}beta`;
    expect(threadSlug(a)).toBe(threadSlug(b)); // truncation collision
    expect(slugHash(a)).not.toBe(slugHash(b)); // disambiguated
  });
});

describe('overflowSlug', () => {
  it('matches the spec naming: <parent-slug>--<thread-slug>', () => {
    expect(overflowSlug(makeStudio(), 'pr:476')).toBe('lumen-review--pr-476');
  });

  it('appends the hash variant for collision disambiguation', () => {
    const slug = overflowSlug(makeStudio(), 'pr:476', slugHash('pr:476'));
    expect(slug).toBe(`lumen-review--pr-476-h${slugHash('pr:476')}`);
  });

  it('falls back to the worktree folder name when slug is missing', () => {
    const parent = makeStudio({ slug: null });
    expect(overflowSlug(parent, 'pr:476')).toBe('inkwell--lumen-review--pr-476');
  });
});

describe('StudioOverflowService.ensureOverflowStudio — reuse', () => {
  it('reuses only the exact (parent, threadKey) ephemeral whose worktree exists', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-reuse-'));
    try {
      const existing = makeStudio({
        id: 'eph-1',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        worktreePath,
      });
      const studios = {
        findBySlug: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio(),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('eph-1');
      expect(studios.create).not.toHaveBeenCalled();
      expect(studios.update).not.toHaveBeenCalled();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('never reuses a slug-colliding studio that is not this thread’s overflow (round 2)', async () => {
    // A long-lived NON-ephemeral studio happens to own the primary slug.
    const collider = makeStudio({
      id: 'longlived-1',
      slug: 'lumen-review--pr-476',
      ephemeral: false,
      worktreePath: '/ws/pcp/inkwell--lumen-review--pr-476',
    });
    const findBySlug = vi
      .fn()
      .mockResolvedValueOnce(collider) // primary slug → unrelated studio
      .mockResolvedValueOnce(null) // hash variant → free
      .mockResolvedValue(null); // the exhausted reread asks again; still free
    const studios = {
      findBySlug,
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    // Parent repoRoot doesn't exist → worktree creation for the disambiguated
    // slug fails → null. The important part: the collider is NOT returned and
    // NOT revived.
    const result = await service.ensureOverflowStudio({
      userId: 'user-1',
      sbSlug: 'lumen',
      parentStudio: makeStudio({ repoRoot: '/nonexistent/repo' }),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    // Two reads for the candidate walk, two more for the exhausted reread
    // that looks for a rival's published row before failing closed.
    expect(findBySlug).toHaveBeenCalledTimes(4);
    expect(studios.update).not.toHaveBeenCalled();
  });

  it('does not reuse another thread’s ephemeral under the same parent', async () => {
    const otherThreads = makeStudio({
      id: 'eph-other',
      slug: 'lumen-review--pr-476',
      ephemeral: true,
      parentStudioId: 'parent-1',
      threadKey: 'pr:9999',
      metadata: { overflow: true },
    });
    const findBySlug = vi
      .fn()
      .mockResolvedValueOnce(otherThreads)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null); // the exhausted reread asks again; still free
    const studios = {
      findBySlug,
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    const result = await service.ensureOverflowStudio({
      userId: 'user-1',
      sbSlug: 'lumen',
      parentStudio: makeStudio({ repoRoot: '/nonexistent/repo' }),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(studios.update).not.toHaveBeenCalled();
  });
});

describe('StudioOverflowService.findOverflowStudio — read-only half of the ladder (v18 S3)', () => {
  it('returns the live matching overflow without creating, reviving, or updating anything', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-find-'));
    try {
      const existing = makeStudio({
        id: 'eph-1',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        worktreePath,
      });
      const studios = {
        findBySlug: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.findOverflowStudio({
        userId: 'user-1',
        parentStudio: makeStudio(),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('eph-1');
      expect(studios.create).not.toHaveBeenCalled();
      expect(studios.update).not.toHaveBeenCalled();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('returns null when no overflow exists — plan-time lookups never mint', async () => {
    const studios = {
      findBySlug: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    const result = await service.findOverflowStudio({
      userId: 'user-1',
      parentStudio: makeStudio(),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(studios.create).not.toHaveBeenCalled();
    expect(studios.update).not.toHaveBeenCalled();
  });

  it('skips a matching row whose worktree is gone — finds, never revives (ensure would)', async () => {
    const existing = makeStudio({
      id: 'eph-cleaned',
      slug: 'lumen-review--pr-476',
      ephemeral: true,
      parentStudioId: 'parent-1',
      threadKey: 'pr:476',
      metadata: { overflow: true },
      worktreePath: '/nonexistent/worktree/path',
    });
    const studios = {
      findBySlug: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    const result = await service.findOverflowStudio({
      userId: 'user-1',
      parentStudio: makeStudio(),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(studios.update).not.toHaveBeenCalled();
    expect(studios.create).not.toHaveBeenCalled();
  });
});

describe('StudioOverflowService.ensureOverflowStudio — durable anchoring', () => {
  // 2026-08-24: `lumen-review--pr-503--pr-503--pr-534--pr-474--pr-535`. Each
  // provisioning was parented on the ephemeral studio the agent's live
  // session occupied, so slugs compounded one suffix per hop. Overflow must
  // anchor on the durable ancestor no matter which studio routing hands in.
  it('mints from the durable ancestor when the candidate is a chained ephemeral', async () => {
    const root = makeStudio(); // parent-1, slug lumen-review, durable
    const eph1 = makeStudio({
      id: 'eph-1',
      slug: 'lumen-review--pr-503',
      ephemeral: true,
      parentStudioId: 'parent-1',
      threadKey: 'pr:503',
      repoRoot: '/nonexistent/repo',
    });
    const chainEnd = makeStudio({
      id: 'eph-2',
      slug: 'lumen-review--pr-503--pr-534',
      ephemeral: true,
      parentStudioId: 'eph-1',
      threadKey: 'pr:534',
      repoRoot: '/nonexistent/repo',
    });
    const findById = vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id === 'eph-1' ? eph1 : id === 'parent-1' ? root : null)
      );
    const findBySlug = vi.fn().mockResolvedValue(null);
    const studios = {
      findById,
      findBySlug,
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    // Worktree creation fails (root's repoRoot exists only in the fixture),
    // so the assertion is on the slugs LOOKED UP, which is where minting
    // decides its name.
    await service.ensureOverflowStudio({
      userId: 'user-1',
      sbSlug: 'lumen',
      parentStudio: chainEnd,
      threadKey: 'pr:474',
    });

    expect(findById).toHaveBeenCalledWith('eph-1');
    expect(findById).toHaveBeenCalledWith('parent-1');
    expect(findBySlug.mock.calls[0][1]).toBe('lumen-review--pr-474');
    for (const call of findBySlug.mock.calls) {
      expect(call[1]).not.toContain('pr-503');
    }
  });

  // The doubled `--pr-503--pr-503`: a thread overflowing from its OWN
  // ephemeral studio must resolve to reusing that studio, not minting an
  // overflow-of-the-overflow for the identical thread.
  it('self-overflow — a thread anchored on its own ephemeral reuses it', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-self-'));
    try {
      const root = makeStudio();
      const own = makeStudio({
        id: 'eph-own',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        worktreePath,
      });
      const studios = {
        findById: vi.fn().mockResolvedValue(root),
        findBySlug: vi.fn().mockResolvedValue(own),
        create: vi.fn(),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: own,
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('eph-own');
      expect(studios.create).not.toHaveBeenCalled();
      expect(studios.update).not.toHaveBeenCalled();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  // Ephemeral worktrees check out DETACHED (Conor, 2026-09-01): no
  // `<agent>/eph/*` branch is minted, so a legacy worktree still holding the
  // old flat branch name is no obstacle at all — the primary variant
  // succeeds where it used to fail with `already used by worktree` and force
  // the hash fallback. Real repo so the detached add genuinely runs.
  it('a legacy eph-branch holder no longer blocks the primary variant — detached checkout', async () => {
    const repoRoot = await makeGitRepo();
    const blocker = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}--legacy-chain`);
    const primarySlug = 'lumen-review--pr-476';
    const primaryWorktree = ephemeralWorktreePath({
      sbSlug: 'lumen',
      repoRoot,
      leaf: primarySlug,
    });
    try {
      // The legacy chained studio still has the flat eph/ branch checked out.
      await execFileAsync('git', ['worktree', 'add', '-b', 'lumen/eph/pr-476', blocker, 'main'], {
        cwd: repoRoot,
      });
      const createdInputs: Array<Record<string, unknown>> = [];
      const studios = {
        findById: vi.fn(),
        findBySlug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
          createdInputs.push(input);
          return Promise.resolve(makeStudio({ id: 'new-primary', ...(input as Partial<Studio>) }));
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('new-primary');
      expect(createdInputs).toHaveLength(1);
      // The sentinel, not a branch name: the row records "no branch, cut from main".
      expect(createdInputs[0].branch).toBe('detached:main');
      expect(createdInputs[0].slug).toBe(primarySlug);
      expect(String(createdInputs[0].worktreePath)).toContain(primarySlug);

      // The checkout really is detached, and no new eph branch exists.
      const { stdout: head } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: primaryWorktree,
      });
      expect(head.trim()).toBe('HEAD');
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'lumen/eph/*'], {
        cwd: repoRoot,
      });
      // Only the legacy blocker's branch — nothing newly minted.
      expect(branches.trim().split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', primaryWorktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await execFileAsync('git', ['worktree', 'remove', '--force', blocker], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  // r1 P1 (Lumen): the hash fallback must be STICKY. A blocker once forced
  // the hash variant; the blocker later freed the primary branch. A
  // sequential check-then-create would now mint the primary alongside the
  // live hash studio — two studios for one (parent, threadKey), sessions
  // split across them. The preflight must find the hash row first.
  it('an existing hash-variant studio is reused before the primary is reminted', async () => {
    const repoRoot = await makeGitRepo();
    const hashWorktree = await mkdtemp(path.join(tmpdir(), 'overflow-hash-'));
    const primaryWorktree = ephemeralWorktreePath({
      sbSlug: 'lumen',
      repoRoot,
      leaf: 'lumen-review--pr-476',
    });
    try {
      const root = makeStudio({ repoRoot, worktreePath: repoRoot });
      const hashRow = makeStudio({
        id: 'eph-hash',
        slug: `lumen-review--pr-476-h${slugHash('pr:476')}`,
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        worktreePath: hashWorktree,
      });
      const studios = {
        findById: vi.fn(),
        findBySlug: vi
          .fn()
          .mockImplementation((_userId: string, slug: string) =>
            Promise.resolve(slug === hashRow.slug ? hashRow : null)
          ),
        create: vi.fn(),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: root,
        threadKey: 'pr:476',
      });

      // The primary is creatable in this real repo — but the live hash row
      // stays authoritative.
      expect(result?.id).toBe('eph-hash');
      expect(studios.create).not.toHaveBeenCalled();
      expect(studios.update).not.toHaveBeenCalled();
    } finally {
      // Under a regressed sequential loop the primary worktree gets created;
      // sweep it so the mutation run leaves nothing behind.
      await execFileAsync('git', ['worktree', 'remove', '--force', primaryWorktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(hashWorktree, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  // r2/r3: a revive UPDATE back into the live predicate is arbitrated by the
  // partial unique index (integration-proven). Losing cleanly means removing
  // the worktree and not throwing. When no live winner turns up on the
  // re-read — as here, the only matching row's worktree is gone — the call
  // still fails closed with null.
  it('a revive loss with no live winner fails the call and removes the created worktree', async () => {
    const repoRoot = await makeGitRepo();
    const primaryWorktree = ephemeralWorktreePath({
      sbSlug: 'lumen',
      repoRoot,
      leaf: 'lumen-review--pr-476',
    });
    try {
      const cleanedRow = makeStudio({
        id: 'eph-cleaned',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        // Live row whose worktree is gone (default fake path) — the revive
        // path, not the reuse path.
        metadata: { overflow: true },
      });
      const studios = {
        findById: vi.fn(),
        findBySlug: vi
          .fn()
          .mockImplementation((_userId: string, slug: string) =>
            Promise.resolve(slug === cleanedRow.slug ? cleanedRow : null)
          ),
        create: vi.fn(),
        update: vi.fn().mockRejectedValue(new Error('duplicate key value violates uniq_live...')),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result).toBeNull();
      expect(studios.create).not.toHaveBeenCalled();
      // The worktree the losing revive created is gone again.
      const { access: fsAccess } = await import('fs/promises');
      await expect(fsAccess(primaryWorktree)).rejects.toThrow();
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', primaryWorktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  // r3: losing the unique index means a CONCURRENT ensure won live ownership.
  // Returning null there is not "failing closed" — neither divertToOverflow
  // call site retries, so null becomes `tier: 'refused'` and the trigger is
  // HELD. The loser must hand back the winner's row.
  it('an insert loss converges on the concurrent winner instead of failing', async () => {
    const repoRoot = await makeGitRepo();
    const winnerWorktree = await mkdtemp(path.join(tmpdir(), 'overflow-winner-'));
    const primaryWorktree = ephemeralWorktreePath({
      sbSlug: 'lumen',
      repoRoot,
      leaf: 'lumen-review--pr-476',
    });
    try {
      const winnerRow = makeStudio({
        id: 'eph-winner',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        worktreePath: winnerWorktree,
      });

      // The winner's row only becomes visible once our insert has lost — the
      // whole point of a check-then-act race.
      let winnerVisible = false;
      const studios = {
        findById: vi.fn(),
        findBySlug: vi
          .fn()
          .mockImplementation((_userId: string, slug: string) =>
            Promise.resolve(winnerVisible && slug === winnerRow.slug ? winnerRow : null)
          ),
        create: vi.fn().mockImplementation(() => {
          winnerVisible = true;
          return Promise.reject(
            new Error(
              'duplicate key value violates unique constraint "uniq_live_ephemeral_studio_per_parent_thread"'
            )
          );
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('eph-winner');
      expect(studios.create).toHaveBeenCalledTimes(1);
      // Our own losing worktree is gone; the winner's is untouched.
      const { access: fsAccess } = await import('fs/promises');
      await expect(fsAccess(primaryWorktree)).rejects.toThrow();
      await expect(fsAccess(winnerWorktree)).resolves.toBeUndefined();
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', primaryWorktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(winnerWorktree, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  // r3: a row revived out of 'archived' is runtime-live again, so its archive
  // stamp has to go with it — otherwise the row's status and its timestamps
  // disagree about whether it is live.
  it('reviving an archived studio clears archived_at as well as cleaned_at', async () => {
    const repoRoot = await makeGitRepo();
    const primaryWorktree = ephemeralWorktreePath({
      sbSlug: 'lumen',
      repoRoot,
      leaf: 'lumen-review--pr-476',
    });
    try {
      const archivedRow = makeStudio({
        id: 'eph-archived',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'pr:476',
        metadata: { overflow: true },
        status: 'archived',
        archivedAt: new Date().toISOString(),
      });
      const studios = {
        findById: vi.fn(),
        findBySlug: vi
          .fn()
          .mockImplementation((_userId: string, slug: string) =>
            Promise.resolve(slug === archivedRow.slug ? archivedRow : null)
          ),
        create: vi.fn(),
        update: vi
          .fn()
          .mockImplementation((_id: string, patch: Record<string, unknown>) =>
            Promise.resolve({ ...archivedRow, ...patch })
          ),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('eph-archived');
      expect(studios.create).not.toHaveBeenCalled();
      expect(studios.update).toHaveBeenCalledWith(
        'eph-archived',
        expect.objectContaining({ status: 'active', cleanedAt: null, archivedAt: null })
      );
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', primaryWorktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('a parent-chain cycle terminates instead of walking forever', async () => {
    const ephA = makeStudio({
      id: 'eph-a',
      slug: 'lumen-review--a',
      ephemeral: true,
      parentStudioId: 'eph-b',
      repoRoot: '/nonexistent/repo',
    });
    const ephB = makeStudio({
      id: 'eph-b',
      slug: 'lumen-review--b',
      ephemeral: true,
      parentStudioId: 'eph-a',
      repoRoot: '/nonexistent/repo',
    });
    const findById = vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(id === 'eph-b' ? ephB : ephA));
    const studios = {
      findById,
      findBySlug: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    const result = await service.ensureOverflowStudio({
      userId: 'user-1',
      sbSlug: 'lumen',
      parentStudio: ephA,
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(findById).toHaveBeenCalledTimes(1);
  });
});

describe('StudioOverflowService — canonical ephemeral root (spec v8)', () => {
  // The whole point of the root: paths are `<root>/<agent>/<project>/<slug>`,
  // flat by construction, and the row slug travels explicitly because the
  // path no longer encodes it. The expectation is hand-built — using the
  // helper here would let a helper bug self-certify.
  it('ephemeral mints materialize under the root with an explicit slug', async () => {
    // A canonical repo basename, so the hand-built expectation needs no
    // digest arithmetic (mkdtemp basenames are mixed-case → digest-suffixed).
    const holder = await mkdtemp(path.join(tmpdir(), 'overflow-canon-'));
    const repoRoot = path.join(holder, 'inkwell-fixture');
    await mkdir(repoRoot);
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
    const expected = path.join(
      studiosRootOverride,
      'lumen',
      'inkwell-fixture',
      'lumen-review--pr-476'
    );
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const studios = {
        findById: vi.fn(),
        findBySlug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
          createdInputs.push(input);
          return Promise.resolve(makeStudio({ id: 'new-root', ...(input as Partial<Studio>) }));
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('new-root');
      expect(createdInputs[0].worktreePath).toBe(expected);
      expect(createdInputs[0].slug).toBe('lumen-review--pr-476');
      // The worktree genuinely exists at the canonical location.
      const { access: fsAccess } = await import('fs/promises');
      await expect(fsAccess(expected)).resolves.toBeUndefined();
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', expected], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(holder, { recursive: true, force: true });
    }
  });

  it('an ordinary overflow (a non-PR thread, detached at the base) is completed as a builder', async () => {
    // Every overflow worktree is detached; only a PR review is a reviewer.
    // An ordinary overflow does write work, and the reviewer profile would
    // leave it unable to edit (review 4177f7fe, P2 4).
    const holder = await mkdtemp(path.join(tmpdir(), 'overflow-builder-'));
    const repoRoot = path.join(holder, 'inkwell-fixture');
    await mkdir(repoRoot);
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
    let worktree = '';
    try {
      const studios = {
        findById: vi.fn(),
        findBySlug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
          worktree = input.worktreePath as string;
          return Promise.resolve(
            makeStudio({ id: 'plain-overflow', ...(input as Partial<Studio>) })
          );
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const service = new StudioOverflowService(studios, {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      completion.calls.length = 0;
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'thread:perf-audit',
      });
      expect(result?.id).toBe('plain-overflow');
      expect(completion.calls.at(-1)).toMatchObject({ permissionProfile: 'builder' });
    } finally {
      if (worktree) {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repoRoot,
        }).catch(() => undefined);
      }
      await rm(holder, { recursive: true, force: true });
    }
  });

  // Scope boundary: durable homes are checkouts a human also lives in. Only
  // the EPHEMERAL mints move; the D1 parent stays a sibling of the repo.
  it('the durable D1 parent studio stays a sibling of the repo, not under the root', async () => {
    const repoRoot = await makeGitRepo();
    const createdInputs: Array<Record<string, unknown>> = [];
    try {
      const studios = {
        findById: vi.fn(),
        findBySlug: vi.fn().mockResolvedValue(null),
        findByRepoRoot: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
          createdInputs.push(input);
          return Promise.resolve(makeStudio({ id: 'parent-new', ...(input as Partial<Studio>) }));
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureParentStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        repoRoot,
      });

      expect(result?.id).toBe('parent-new');
      const worktreePath = String(createdInputs[0].worktreePath);
      expect(path.dirname(worktreePath)).toBe(path.dirname(repoRoot));
      expect(worktreePath.startsWith(studiosRootOverride)).toBe(false);
    } finally {
      if (createdInputs[0]?.worktreePath) {
        await execFileAsync(
          'git',
          ['worktree', 'remove', '--force', String(createdInputs[0].worktreePath)],
          { cwd: repoRoot }
        ).catch(() => undefined);
      }
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('StudioOverflowService.ensureParentStudio — a closed home is revived', () => {
  /**
   * A studios repository over ONE row: findBySlug reads the row as it stands
   * and update applies the patch it receives, so a second ensure sees what
   * the first one wrote rather than a stale fixture.
   */
  function oneRowStudios(row: Studio) {
    let current = row;
    const updates: Array<Record<string, unknown>> = [];
    const studios = {
      findById: vi.fn(),
      findBySlug: vi.fn(async (_userId: string, slug: string) =>
        slug === current.slug ? current : null
      ),
      findByRepoRoot: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        if (id !== current.id) throw new Error(`no studio ${id}`);
        current = { ...current, ...(patch as Partial<Studio>) };
        return current;
      }),
    } as unknown as StudiosRepository;
    return { studios, updates, current: () => current };
  }

  /** The home the 2026-09-28 PR session closed: cleaned, its branch kept. */
  async function closedHome(repoRoot: string, overrides: Partial<Studio> = {}): Promise<Studio> {
    await execFileAsync('git', ['branch', 'lumen/studio/lumen'], { cwd: repoRoot });
    const slug = `${path.basename(repoRoot)}--lumen`;
    return makeStudio({
      id: 'home-1',
      sbSlug: 'lumen',
      sbId: 'sb-lumen',
      repoRoot,
      slug,
      worktreePath: path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}--${slug}`),
      branch: 'lumen/studio/lumen',
      purpose: 'Home studio for lumen (auto-created)',
      defaultProjectId: null,
      status: 'cleaned',
      cleanedAt: '2026-09-28T08:57:57.069Z',
      metadata: { autoCreated: true, createdBy: 'caller-repo-routing' },
      ...overrides,
    });
  }

  async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: repoRoot,
    }).catch(() => undefined);
  }

  it('revives its own cleaned home onto a fresh worktree on the surviving branch', async () => {
    const repoRoot = await makeGitRepo();
    const home = await closedHome(repoRoot);
    const { studios, updates } = oneRowStudios(home);
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    completion.calls.length = 0;
    try {
      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureParentStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        repoRoot,
        sbId: 'sb-lumen',
      });

      expect(result?.id).toBe('home-1');
      expect(result?.status).toBe('active');
      expect(studios.create).not.toHaveBeenCalled();
      // The whole revive transition, not a status flip.
      expect(updates).toEqual([
        {
          status: 'active',
          worktreePath: home.worktreePath,
          branch: 'lumen/studio/lumen',
          cleanedAt: null,
          archivedAt: null,
          expiresAt: null,
        },
      ]);
      // A real checkout, attached to the branch the teardown kept.
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: home.worktreePath,
      });
      expect(stdout.trim()).toBe('lumen/studio/lumen');
      // Completed as a new home is, against the revived row's id.
      // A home on its own branch is a builder.
      expect(completion.calls).toEqual([
        expect.objectContaining({
          worktreePath: home.worktreePath,
          studioId: 'home-1',
          permissionProfile: 'builder',
        }),
      ]);
    } finally {
      await removeWorktree(repoRoot, home.worktreePath);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('two concurrent ensures for one closed home converge on the single revived row', async () => {
    const repoRoot = await makeGitRepo();
    const home = await closedHome(repoRoot);
    const { studios, updates } = oneRowStudios(home);
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    try {
      const service = new StudioOverflowService(studios, leases);
      const ensure = () =>
        service.ensureParentStudio({
          userId: 'user-1',
          sbSlug: 'lumen',
          repoRoot,
          sbId: 'sb-lumen',
        });
      const [first, second] = await Promise.all([ensure(), ensure()]);

      // Held triggers are not retried, so the loser of a git race must not
      // come back null: it finds the winner's live row and reuses it.
      expect(first?.id).toBe('home-1');
      expect(second?.id).toBe('home-1');
      expect(updates).toHaveLength(1);
    } finally {
      await removeWorktree(repoRoot, home.worktreePath);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("still refuses a cleaned row at the slug that is another identity's", async () => {
    const repoRoot = await makeGitRepo();
    const home = await closedHome(repoRoot, { sbId: 'sb-another-lumen' });
    const { studios } = oneRowStudios(home);
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    try {
      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureParentStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        repoRoot,
        sbId: 'sb-lumen',
      });

      expect(result).toBeNull();
      expect(studios.update).not.toHaveBeenCalled();
      expect(studios.create).not.toHaveBeenCalled();
      await expect(access(home.worktreePath)).rejects.toThrow();
    } finally {
      await removeWorktree(repoRoot, home.worktreePath);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('StudioOverflowService.teardownEphemeralStudio — fencing', () => {
  it('refuses to tear down a non-ephemeral studio', async () => {
    const studios = { markCleaned: vi.fn() } as unknown as StudiosRepository;
    const leases = {
      logEvent: vi.fn(),
      claimForTeardown: vi.fn(),
    } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    await service.teardownEphemeralStudio(makeStudio({ ephemeral: false }), { reason: 'test' });
    expect(studios.markCleaned).not.toHaveBeenCalled();
    expect(leases.claimForTeardown).not.toHaveBeenCalled();
  });

  it('skips teardown when the claim is refused, marking a prompt sweep retry — rounds 2–3', async () => {
    const update = vi.fn().mockResolvedValue(makeStudio());
    const studios = { markCleaned: vi.fn(), update } as unknown as StudiosRepository;
    const logEvent = vi.fn();
    const leases = {
      logEvent,
      claimForTeardown: vi.fn().mockResolvedValue(null),
      clearTeardownClaim: vi.fn(),
    } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    await service.teardownEphemeralStudio(makeStudio({ ephemeral: true }), {
      reason: 'thread pr:476 closed',
      expectedThreadKey: 'pr:476',
    });

    expect(studios.markCleaned).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
    // Thread-close context: expires_at pulled to now so the 5-minute sweep
    // retries once the holder's boundary releases the lease.
    expect(update).toHaveBeenCalledWith('parent-1', {
      expiresAt: expect.any(String),
    });
  });

  it('aborts after a failed rescue with the claim left as quarantine', async () => {
    // A directory that exists but is not a git repo: capture errors, so
    // destruction must not proceed and the row must not be marked cleaned.
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'overflow-norescue-'));
    try {
      const studios = { markCleaned: vi.fn() } as unknown as StudiosRepository;
      const logEvent = vi.fn();
      const clearTeardownClaim = vi.fn();
      const leases = {
        logEvent,
        claimForTeardown: vi.fn().mockResolvedValue(makeTeardownClaim()),
        clearTeardownClaim,
      } as unknown as StudioLeaseService;
      const service = new StudioOverflowService(studios, leases);

      await service.teardownEphemeralStudio(
        makeStudio({ ephemeral: true, worktreePath: nonRepoDir, repoRoot: nonRepoDir }),
        { reason: 'thread pr:476 closed', expectedThreadKey: 'pr:476' }
      );

      expect(studios.markCleaned).not.toHaveBeenCalled();
      // The quarantine claim is NOT cleared — it keeps blocking acquirers.
      expect(clearTeardownClaim).not.toHaveBeenCalled();
      // The worktree is still on disk.
      await expect(rm(nonRepoDir, { recursive: true })).resolves.toBeUndefined();
      const conflictCall = logEvent.mock.calls.find((c) => c[2] === 'conflict');
      expect(conflictCall?.[3]?.reason).toContain('teardown-aborted-rescue-failed');
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('StudioOverflowService.teardownEphemeralStudio — a worktree in use (task 7ec05d10)', () => {
  // On 2026-10-07 the sweep removed an expired ephemeral checkout 17 s into a
  // Codex turn spawned there, under a running Metro: the turn held no lease.
  const running = {
    state: 'in-use' as const,
    processes: [{ pid: 4242, command: 'node', cwd: '/ws/inkling--canonical' }],
  };

  function fixtures() {
    const update = vi.fn().mockResolvedValue(makeStudio());
    const studios = { markCleaned: vi.fn(), update } as unknown as StudiosRepository;
    const claim = makeTeardownClaim();
    const leases = {
      logEvent: vi.fn(),
      claimForTeardown: vi.fn().mockResolvedValue(claim),
      verifyClaim: vi.fn().mockResolvedValue(true),
      clearTeardownClaim: vi.fn().mockResolvedValue(true),
      finalizeTeardown: vi.fn().mockResolvedValue(true),
    } as unknown as StudioLeaseService & Record<string, ReturnType<typeof vi.fn>>;
    return { studios, update, leases, claim };
  }

  for (const [label, use] of [
    ['something is running from it', running],
    ['the check could not run', { state: 'unknown' as const, error: 'spawn lsof ENOENT' }],
  ] as const) {
    it(`backs out before the rescue when ${label}`, async () => {
      // A directory that is not a git repo: had the teardown gone on, the
      // rescue would have failed and left the claim as a quarantine.
      const dir = await mkdtemp(path.join(tmpdir(), 'overflow-inuse-'));
      try {
        const f = fixtures();
        const inUse = vi.fn().mockResolvedValue(use);
        const service = new StudioOverflowService(f.studios, f.leases, inUse);

        await service.teardownEphemeralStudio(
          makeStudio({ ephemeral: true, worktreePath: dir, repoRoot: dir }),
          { reason: 'expired' }
        );

        expect(inUse).toHaveBeenCalledWith(dir);
        // Its own claim is cleared, so the studio is not left quarantined.
        expect(f.leases.clearTeardownClaim).toHaveBeenCalledWith('parent-1', 'user-1', f.claim);
        expect(f.studios.markCleaned).not.toHaveBeenCalled();
        expect(f.leases.finalizeTeardown).not.toHaveBeenCalled();
        // The sweep looks again later.
        const [, patch] = f.update.mock.calls[0] as [string, { expiresAt: string }];
        expect(Date.parse(patch.expiresAt)).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
        const conflict = f.leases.logEvent.mock.calls.find((c) => c[2] === 'conflict');
        expect(conflict?.[3]?.reason).toBe('teardown-skipped-in-use (expired)');
        // Nothing on disk was touched.
        await expect(access(dir)).resolves.toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('goes on when nothing is running from it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'overflow-idle-'));
    try {
      const f = fixtures();
      const inUse = vi.fn().mockResolvedValue({ state: 'idle' });
      const service = new StudioOverflowService(f.studios, f.leases, inUse);

      await service.teardownEphemeralStudio(
        makeStudio({ ephemeral: true, worktreePath: dir, repoRoot: dir }),
        { reason: 'expired' }
      );

      // It reached the rescue, which fails on a non-repo and keeps the claim.
      expect(f.leases.clearTeardownClaim).not.toHaveBeenCalled();
      const conflict = f.leases.logEvent.mock.calls.find((c) => c[2] === 'conflict');
      expect(conflict?.[3]?.reason).toContain('teardown-aborted-rescue-failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backs out at the last moment when a process starts during the rescue', async () => {
    const repoRoot = await makeGitRepo();
    const worktree = `${repoRoot}--live`;
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', 'eph/live', worktree, 'main'], {
        cwd: repoRoot,
      });
      const f = fixtures();
      // Idle when the teardown starts; in use by the time it would remove.
      const inUse = vi.fn().mockResolvedValueOnce({ state: 'idle' }).mockResolvedValue(running);
      const service = new StudioOverflowService(f.studios, f.leases, inUse);

      await service.teardownEphemeralStudio(
        makeStudio({ ephemeral: true, worktreePath: worktree, repoRoot }),
        { reason: 'expired' }
      );

      expect(inUse).toHaveBeenCalledTimes(2);
      await expect(access(worktree)).resolves.toBeUndefined();
      expect(f.leases.clearTeardownClaim).toHaveBeenCalledWith('parent-1', 'user-1', f.claim);
      expect(f.leases.finalizeTeardown).not.toHaveBeenCalled();
      expect(f.studios.markCleaned).not.toHaveBeenCalled();
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('still removes an idle clean worktree', async () => {
    const repoRoot = await makeGitRepo();
    const worktree = `${repoRoot}--idle`;
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', 'eph/idle', worktree, 'main'], {
        cwd: repoRoot,
      });
      const f = fixtures();
      const inUse = vi.fn().mockResolvedValue({ state: 'idle' });
      const service = new StudioOverflowService(f.studios, f.leases, inUse);

      await service.teardownEphemeralStudio(
        makeStudio({ ephemeral: true, worktreePath: worktree, repoRoot }),
        { reason: 'expired' }
      );

      expect(inUse).toHaveBeenCalledTimes(2);
      await expect(access(worktree)).rejects.toThrow();
      expect(f.leases.finalizeTeardown).toHaveBeenCalled();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('S2: teardownEphemeralStudiosForThread under multiplexing (spec v18)', () => {
  function multiplexedStudio(threadKeys: string[]): Studio {
    const now = new Date().toISOString();
    return makeStudio({
      ephemeral: true,
      threadKey: 'pr:A',
      lease: {
        sessionId: 'session-b',
        threadKey: 'pr:A',
        threadKeys,
        sbSlug: 'wren',
        acquiredAt: now,
        heartbeatAt: now,
      } as unknown as Studio['lease'],
    });
  }

  it('skips teardown — and the expires_at pull — while another live key rides the lease', async () => {
    // The spec-mandated case: ephemeral created for pr:A, session appended
    // pr:B, pr:A closes. The studio and lease must survive holding pr:B, and
    // the claim-refusal path's "retry teardown soon" expires_at pull must
    // never fire against a studio that has to keep living.
    const update = vi.fn();
    const studios = {
      markCleaned: vi.fn(),
      update,
      inWorkspace: (found: Studio[]) => Promise.resolve(found),
      listEphemeralByThread: vi.fn().mockResolvedValue([multiplexedStudio(['pr:A', 'pr:B'])]),
    } as unknown as StudiosRepository;
    const claimForTeardown = vi.fn();
    const leases = { logEvent: vi.fn(), claimForTeardown } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    const closed = await service.teardownEphemeralStudiosForThread(
      { workspaceId: 'ws-1', threadKey: 'pr:A' },
      {
        legacyOwnerUserId: 'user-1',
        reason: 'thread pr:A closed',
      }
    );

    expect(closed).toBe(0);
    expect(claimForTeardown).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('proceeds to the fenced teardown when the closing key is the created-for thread', async () => {
    // The pre-multiplex lifecycle: built for pr:B, only ever served pr:B —
    // the created-for query legitimately finds it.
    const update = vi.fn().mockResolvedValue(makeStudio());
    const created = makeStudio({ ephemeral: true, threadKey: 'pr:B', lease: null });
    const studios = {
      markCleaned: vi.fn(),
      update,
      inWorkspace: (found: Studio[]) => Promise.resolve(found),
      listEphemeralByThread: vi
        .fn()
        .mockImplementation(async (threadKey: string) => (threadKey === 'pr:B' ? [created] : [])),
    } as unknown as StudiosRepository;
    // Claim refused (live holder) — the point is only that the fenced path
    // WAS attempted for the survivor key; its own gates still apply.
    const claimForTeardown = vi.fn().mockResolvedValue(null);
    const leases = { logEvent: vi.fn(), claimForTeardown } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    const closed = await service.teardownEphemeralStudiosForThread(
      { workspaceId: 'ws-1', threadKey: 'pr:B' },
      {
        legacyOwnerUserId: 'user-1',
        reason: 'thread pr:B closed',
      }
    );

    expect(closed).toBe(1);
    expect(claimForTeardown).toHaveBeenCalledWith('parent-1', 'user-1', {
      expectedThreadKey: 'pr:B',
      expectedWorkspaceId: 'ws-1',
      reason: 'teardown-claim (thread pr:B closed)',
    });
  });

  it('a created-for-A ephemeral is found through the close candidates when B closes last (Lumen r1 P1-2)', async () => {
    // Production shape: studios.thread_key = 'pr:A' (created-for), lease
    // already released by releaseByThread — the created-for query for pr:B
    // returns NOTHING, and nothing on the row remembers pr:B. Discovery has
    // to come from the close path handing over the studios whose lease the
    // thread actually rode.
    const createdForA = makeStudio({ ephemeral: true, threadKey: 'pr:A', lease: null });
    const listEphemeralByThread = vi
      .fn()
      .mockImplementation(async (threadKey: string) => (threadKey === 'pr:A' ? [createdForA] : []));
    const findById = vi
      .fn()
      .mockImplementation(async (id: string) => (id === 'parent-1' ? createdForA : null));
    const studios = {
      markCleaned: vi.fn(),
      update: vi.fn().mockResolvedValue(createdForA),
      inWorkspace: (found: Studio[]) => Promise.resolve(found),
      listEphemeralByThread,
      findById,
    } as unknown as StudiosRepository;
    const claimForTeardown = vi.fn().mockResolvedValue(null);
    const leases = { logEvent: vi.fn(), claimForTeardown } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    // Without candidates: invisible — this IS the P1-2 gap, pinned.
    const withoutCandidates = await service.teardownEphemeralStudiosForThread(
      { workspaceId: 'ws-1', threadKey: 'pr:B' },
      {
        legacyOwnerUserId: 'user-1',
        reason: 'thread pr:B closed',
      }
    );
    expect(withoutCandidates).toBe(0);
    expect(claimForTeardown).not.toHaveBeenCalled();

    // With the close path's candidates: discovered and fenced-torn-down.
    const closed = await service.teardownEphemeralStudiosForThread(
      { workspaceId: 'ws-1', threadKey: 'pr:B' },
      {
        legacyOwnerUserId: 'user-1',
        reason: 'thread pr:B closed',
        candidateStudioIds: ['parent-1'],
      }
    );
    expect(closed).toBe(1);
    expect(claimForTeardown).toHaveBeenCalledWith('parent-1', 'user-1', {
      expectedThreadKey: 'pr:B',
      expectedWorkspaceId: 'ws-1',
      reason: 'teardown-claim (thread pr:B closed)',
    });
  });

  it("candidate ids never widen scope: a studio outside the thread's workspace, or a durable one, is ignored", async () => {
    // The boundary is the thread's WORKSPACE now (spec §1): a legacy studio
    // with no identity belongs only to the closing owner, so another
    // owner's stays out; the repository's inWorkspace applies that rule.
    const foreign = makeStudio({ id: 'foreign-1', ephemeral: true, userId: 'user-2', lease: null });
    const durable = makeStudio({ id: 'durable-1', ephemeral: false, lease: null });
    const findById = vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === 'foreign-1' ? foreign : id === 'durable-1' ? durable : null
      );
    const studios = {
      markCleaned: vi.fn(),
      update: vi.fn(),
      inWorkspace: (found: Studio[], _ws: string, owner?: string) =>
        Promise.resolve(found.filter((st) => (st.sbId ? true : st.userId === owner))),
      listEphemeralByThread: vi.fn().mockResolvedValue([]),
      findById,
    } as unknown as StudiosRepository;
    const claimForTeardown = vi.fn();
    const leases = { logEvent: vi.fn(), claimForTeardown } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    const closed = await service.teardownEphemeralStudiosForThread(
      { workspaceId: 'ws-1', threadKey: 'pr:B' },
      {
        legacyOwnerUserId: 'user-1',
        reason: 'thread pr:B closed',
        candidateStudioIds: ['foreign-1', 'durable-1', 'missing-1'],
      }
    );
    expect(closed).toBe(0);
    expect(claimForTeardown).not.toHaveBeenCalled();
  });
});

// ── PR threads detach at the PR head (studio-model, piece 2) ──

/**
 * A repo whose `origin` is a bare clone holding a PR head that NO local branch
 * reaches — the shape of reviewing someone else's PR. The PR commit is made on
 * a throwaway branch, published to origin as `refs/pull/<n>/head` (GitHub's
 * convention), and the branch is deleted locally.
 */
async function makeGitRepoWithPullRef(
  prNumber: number,
  opts: { yarnTrap?: boolean; startupTrap?: boolean; symlinkTrap?: string } = {}
): Promise<{ repoRoot: string; origin: string; prHead: string; mainHead: string }> {
  const repoRoot = await makeGitRepo();
  const origin = await mkdtemp(path.join(tmpdir(), 'overflow-origin-'));
  const git = (args: string[], cwd = repoRoot) => execFileAsync('git', args, { cwd });
  if (opts.yarnTrap) {
    // Lumen's PR #604 probe: the repo's own Yarn config decides which binary
    // `yarn install` runs. The trap "binary" only writes a marker into the
    // worktree, so a test can SEE whether the package manager executed.
    await writeFile(path.join(repoRoot, 'package.json'), '{"name":"trap","private":true}\n');
    await writeFile(path.join(repoRoot, '.yarnrc.yml'), 'yarnPath: ./fake-yarn.cjs\n');
    await writeFile(
      path.join(repoRoot, 'fake-yarn.cjs'),
      "require('fs').writeFileSync(require('path').join(process.cwd(), 'PR-CODE-RAN.marker'), 'ran');\n"
    );
    await git(['add', '.']);
    await git(['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'yarn trap']);
  }
  await git(['init', '--bare', '-b', 'main'], origin);
  await git(['remote', 'add', 'origin', origin]);
  await git(['push', '-q', 'origin', 'main']);
  const { stdout: mainSha } = await git(['rev-parse', 'HEAD']);
  await git(['checkout', '-q', '-b', 'pr-source']);
  if (opts.startupTrap) {
    // Lumen's PR #604 round-2 probe: the PR TRACKS the startup config a
    // review session would execute or trust — an MCP server, a SessionStart
    // hook, per-backend config. Bootstrap seeds only when absent, so without
    // quarantine these copies win.
    await writeFile(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'pr-trap': { command: '/bin/false' } } })
    );
    await mkdir(path.join(repoRoot, '.claude'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch PR-HOOK-RAN' }] }] },
      })
    );
    await mkdir(path.join(repoRoot, '.codex'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.codex', 'config.toml'),
      '[mcp_servers.pr-trap]\ncommand = "/bin/false"\n'
    );
    await writeFile(
      path.join(repoRoot, '.env'),
      'NODE_OPTIONS=--trace-warnings\nPR_ENV_MARKER=1\n'
    );
    await mkdir(path.join(repoRoot, '.gemini'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.gemini', 'settings.json'),
      JSON.stringify({ mcpServers: { 'pr-trap': {} } })
    );
    await git(['add', '.']);
  }
  if (opts.symlinkTrap) {
    // The PR ships `.claude` as a link to a directory OUTSIDE the checkout.
    await symlink(opts.symlinkTrap, path.join(repoRoot, '.claude'));
    await git(['add', '.claude']);
  }
  await git([
    '-c',
    'user.email=test@test',
    '-c',
    'user.name=test',
    'commit',
    '--allow-empty',
    '-m',
    `pr ${prNumber} head`,
  ]);
  const { stdout: prSha } = await git(['rev-parse', 'HEAD']);
  await git(['push', '-q', 'origin', `HEAD:refs/pull/${prNumber}/head`]);
  await git(['checkout', '-q', 'main']);
  await git(['branch', '-D', 'pr-source']);
  if (opts.startupTrap) {
    // The TRUSTED copy bootstrap seeds from: the main root's own, untracked
    // `.mcp.json` (written after the PR commit so it never enters git).
    await writeFile(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { trusted: { command: '/bin/true' } } })
    );
  }
  return { repoRoot, origin, prHead: prSha.trim(), mainHead: mainSha.trim() };
}

describe('pullRequestDetachTarget', () => {
  it('names the GitHub pull ref for a pr thread, with or without a project prefix', () => {
    expect(pullRequestDetachTarget('pr:591')).toEqual({
      number: 591,
      fetchRefspec: '+refs/pull/591/head:refs/remotes/origin/pr/591',
      localRef: 'refs/remotes/origin/pr/591',
      label: 'origin/pr/591',
    });
    expect(pullRequestDetachTarget('inktrade:pr:42')?.localRef).toBe('refs/remotes/origin/pr/42');
  });

  it('is null for every other thread shape — those detach at the base branch', () => {
    for (const key of [
      'task:abc',
      'branch:wren/feat/x',
      'spec:studio-model',
      'pr:abc',
      'pr:',
      'pr',
    ]) {
      expect(pullRequestDetachTarget(key)).toBeNull();
    }
  });
});

describe('StudioOverflowService.ensureOverflowStudio — PR threads detach at the PR head', () => {
  function capturingRepo(createdInputs: Array<Record<string, unknown>>) {
    return {
      findById: vi.fn(),
      findBySlug: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
        createdInputs.push(input);
        return Promise.resolve(makeStudio({ id: 'new-primary', ...(input as Partial<Studio>) }));
      }),
      update: vi.fn(),
    } as unknown as StudiosRepository;
  }

  it('checks out the PR head, pins the commit on the row, and mints no branch', async () => {
    const { repoRoot, origin, prHead } = await makeGitRepoWithPullRef(7);
    const slug = 'lumen-review--pr-7';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);

      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:7',
      });

      expect(result?.id).toBe('new-primary');
      expect(createdInputs).toHaveLength(1);
      expect(createdInputs[0].branch).toBe('detached:origin/pr/7');
      expect(createdInputs[0].metadata).toEqual({
        overflow: true,
        checkout: { mode: 'detached', ref: 'origin/pr/7', commit: prHead },
      });
      // A review checkout is completed with the reviewer profile, from the row.
      expect(completion.calls.at(-1)).toMatchObject({
        worktreePath: worktree,
        permissionProfile: 'reviewer',
      });

      // The worktree really sits on the PR's commit, detached.
      const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree });
      expect(head.trim()).toBe(prHead);
      const { stdout: abbrev } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: worktree,
      });
      expect(abbrev.trim()).toBe('HEAD');
      // No branch was created anywhere — only main exists.
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list'], {
        cwd: repoRoot,
      });
      expect(
        branches
          .split('\n')
          .map((line) => line.replace(/^\*?\s*/, '').trim())
          .filter(Boolean)
      ).toEqual(['main']);
      // The fetched head lives under a remote-tracking ref, not a branch.
      const { stdout: tracking } = await execFileAsync(
        'git',
        ['rev-parse', 'refs/remotes/origin/pr/7'],
        { cwd: repoRoot }
      );
      expect(tracking.trim()).toBe(prHead);
      // The checkout pin travels with the worktree, in its own gitdir.
      await expect(readCheckoutPin(worktree)).resolves.toEqual({
        commit: prHead,
        ref: 'refs/remotes/origin/pr/7',
      });
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('falls back to the base branch when the PR ref cannot be fetched — still detached, still no branch', async () => {
    const { repoRoot, origin, mainHead } = await makeGitRepoWithPullRef(7);
    const slug = 'lumen-review--pr-404';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);

      // origin exists, but no PR 404 does.
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:404',
      });

      expect(result?.id).toBe('new-primary');
      expect(createdInputs[0].branch).toBe('detached:main');
      expect(createdInputs[0].metadata).toEqual({
        overflow: true,
        checkout: { mode: 'detached', ref: 'main', commit: mainHead },
      });
      // Detached at the base after a failed fetch is still a detached checkout.
      expect(completion.calls.at(-1)).toMatchObject({
        worktreePath: worktree,
        permissionProfile: 'reviewer',
      });
      const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree });
      expect(head.trim()).toBe(mainHead);
      const { stdout: branches } = await execFileAsync('git', ['branch', '--list'], {
        cwd: repoRoot,
      });
      expect(branches.split('\n').filter((l) => l.trim()).length).toBe(1);
      // Pinned to what it actually checked out — no ref, since none was fetched.
      await expect(readCheckoutPin(worktree)).resolves.toEqual({ commit: mainHead });
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('a revived row gets the fresh checkout pin merged into its existing metadata', async () => {
    const { repoRoot, origin, prHead } = await makeGitRepoWithPullRef(7);
    const parent = makeStudio({ repoRoot, worktreePath: repoRoot });
    const slug = overflowSlug(parent, 'pr:7');
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      // A cleaned row for this exact (parent, thread): its worktree is gone,
      // so the ensure revives it rather than inserting beside it.
      const stale = makeStudio({
        id: 'stale-row',
        slug,
        threadKey: 'pr:7',
        parentStudioId: parent.id,
        ephemeral: true,
        status: 'cleaned' as Studio['status'],
        cleanedAt: '2026-09-01T00:00:00.000Z',
        worktreePath: path.join(repoRoot, 'gone'),
        branch: 'lumen/eph/pr-7',
        metadata: { overflow: true, note: 'keep me' },
      });
      const updates: Array<Record<string, unknown>> = [];
      const studios = {
        findById: vi.fn(),
        findBySlug: vi
          .fn()
          .mockImplementation((_userId: string, s: string) =>
            Promise.resolve(s === slug ? stale : null)
          ),
        create: vi.fn(),
        update: vi.fn().mockImplementation((id: string, input: Record<string, unknown>) => {
          updates.push(input);
          return Promise.resolve(makeStudio({ ...stale, ...(input as Partial<Studio>), id }));
        }),
      } as unknown as StudiosRepository;
      const service = new StudioOverflowService(studios, {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);

      completion.calls.length = 0;
      const revived = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: parent,
        threadKey: 'pr:7',
      });

      expect(revived?.id).toBe('stale-row');
      expect(studios.create).not.toHaveBeenCalled();
      expect(updates).toHaveLength(1);
      expect(updates[0].branch).toBe('detached:origin/pr/7');
      expect(updates[0].metadata).toEqual({
        overflow: true,
        note: 'keep me',
        checkout: { mode: 'detached', ref: 'origin/pr/7', commit: prHead },
      });
      // The revived row sits on a FRESH worktree, so it is completed exactly
      // as a created one is: with the row's id, after the row was updated.
      // Every review round after the first takes this path (task 2841c7a9).
      // Detached on the PR head, so the revived row is a reviewer (design v3,
      // item 5): the profile is read from the row, never the checkout.
      expect(completion.calls).toEqual([
        expect.objectContaining({
          worktreePath: worktree,
          studioId: 'stale-row',
          sbSlug: 'lumen',
          permissionProfile: 'reviewer',
        }),
      ]);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('never runs the package manager on an unreviewed PR head — the PR chooses the binary via yarnPath (Lumen, PR #604 P1)', async () => {
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7, { yarnTrap: true });
    const slug = 'lumen-review--pr-7';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:7',
      });
      expect(result?.id).toBe('new-primary');
      const present = (p: string) =>
        access(p)
          .then(() => true)
          .catch(() => false);
      expect(await present(path.join(worktree, 'package.json'))).toBe(true);
      expect(await present(path.join(worktree, 'PR-CODE-RAN.marker'))).toBe(false);
      expect(await present(path.join(worktree, 'node_modules'))).toBe(false);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('control: the same trap fires for a non-PR ephemeral at the base, so the test can see execution', async () => {
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7, { yarnTrap: true });
    const slug = 'lumen-review--task-abc';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'task:abc',
      });
      expect(result?.id).toBe('new-primary');
      await expect(access(path.join(worktree, 'PR-CODE-RAN.marker'))).resolves.toBeUndefined();
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('teardown rescues only what the reviewer added on top of the fetched head', async () => {
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7);
    const slug = 'lumen-review--pr-7';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    const parent = makeStudio({ repoRoot, worktreePath: repoRoot });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const studios = {
        findById: vi.fn(),
        findBySlug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((input: Record<string, unknown>) => {
          createdInputs.push(input);
          return Promise.resolve(makeStudio({ id: 'new-primary', ...(input as Partial<Studio>) }));
        }),
        update: vi.fn(),
        markCleaned: vi.fn().mockResolvedValue(undefined),
      } as unknown as StudiosRepository;
      const leases = {
        logEvent: vi.fn(),
        claimForTeardown: vi.fn().mockResolvedValue(makeTeardownClaim()),
        verifyClaim: vi.fn().mockResolvedValue(true),
        clearTeardownClaim: vi.fn().mockResolvedValue(true),
        finalizeTeardown: vi.fn().mockResolvedValue(true),
      } as unknown as StudioLeaseService;
      const service = new StudioOverflowService(studios, leases);
      const ensure = () =>
        service.ensureOverflowStudio({
          userId: 'user-1',
          sbSlug: 'lumen',
          parentStudio: parent,
          threadKey: 'pr:7',
        });
      const rescues = async () => {
        const { stdout } = await execFileAsync('git', ['branch', '--list', 'ink-rescue/*'], {
          cwd: repoRoot,
        });
        return stdout
          .split('\n')
          .map((l) => l.replace(/^\*?\s*/, '').trim())
          .filter(Boolean);
      };

      // Pass 1: an untouched review — teardown removes the worktree and mints nothing.
      const first = await ensure();
      await service.teardownEphemeralStudio(first!, { reason: 'thread pr:7 closed' });
      expect(
        await access(worktree)
          .then(() => true)
          .catch(() => false)
      ).toBe(false);
      expect(await rescues()).toEqual([]);

      // Pass 2: the reviewer commits on top — teardown anchors exactly that.
      const second = await ensure();
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
          'review fixup',
        ],
        { cwd: worktree }
      );
      const { stdout: fixup } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: worktree,
      });
      await service.teardownEphemeralStudio(second!, { reason: 'thread pr:7 closed' });
      const names = await rescues();
      expect(names).toHaveLength(1);
      const { stdout: anchored } = await execFileAsync('git', ['rev-parse', names[0]], {
        cwd: repoRoot,
      });
      expect(anchored.trim()).toBe(fixup.trim());
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it("quarantines PR-supplied startup config before bootstrap — the checkout ends with the main root's copies (Lumen, PR #604 r2)", async () => {
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7, { startupTrap: true });
    const slug = 'lumen-review--pr-7';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:7',
      });
      expect(result?.id).toBe('new-primary');

      // Every PR-supplied startup path is gone from the checkout — the MCP
      // server, the hook, the per-backend configs, the root .env Gemini
      // would have loaded — and the completion routine ran AFTER that, on
      // a checkout holding none of them, with the row it now has. Its own
      // suites pin that what it then writes comes from the main worktree.
      for (const rel of ['.mcp.json', '.claude', '.codex', '.gemini', '.env']) {
        await expect(access(path.join(worktree, rel))).rejects.toBeDefined();
      }
      const ran = completion.calls.find((c) => c.worktreePath === worktree);
      expect(ran).toBeDefined();
      expect(ran?.studioId).toBe('new-primary');
      expect(ran?.sbSlug).toBe('lumen');
      expect(ran?.present).toEqual([]);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('a PR that ships .claude as a symlink cannot make settings land outside the checkout', async () => {
    // The link points at a sibling directory inside the isolated studios root,
    // which is where the worktree materializes: `<root>/lumen/<repo>/<slug>`,
    // so `../outside-<n>` is `<root>/lumen/<repo>/outside-<n>`. Disposable.
    const outsideName = `outside-${Date.now()}`;
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7, {
      symlinkTrap: path.join('..', outsideName),
    });
    const slug = 'lumen-review--pr-7';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    const outside = path.join(path.dirname(worktree), outsideName);
    try {
      await mkdir(outside, { recursive: true });
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:7',
      });
      expect(result?.id).toBe('new-primary');
      // Nothing was written where the link pointed.
      await expect(access(path.join(outside, 'settings.local.json'))).rejects.toBeDefined();
      // The PR's link is gone by the time the completion routine runs, so
      // the settings it writes land in a real directory of ours (its own
      // suites pin that it refuses to write through a link that survives).
      await expect(lstat(path.join(worktree, '.claude'))).rejects.toBeDefined();
      const ran = completion.calls.find((c) => c.worktreePath === worktree);
      expect(ran?.present).not.toContain('.claude');
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });

  it('control: a base-branch ephemeral is not quarantined — trusted code keeps its own config', async () => {
    // Same trap files, but tracked on the BASE (trusted) commit, and a task
    // thread that checks out the base. Quarantine is a review-only measure.
    const { repoRoot, origin } = await makeGitRepoWithPullRef(7);
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repoRoot });
    await writeFile(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'base-own': { command: '/bin/true' } } })
    );
    await writeFile(path.join(repoRoot, '.env'), 'BASE_OWN=1\n');
    await git(['add', '.mcp.json', '.env']);
    await git([
      '-c',
      'user.email=test@test',
      '-c',
      'user.name=test',
      'commit',
      '-m',
      'base config',
    ]);
    const slug = 'lumen-review--task-abc';
    const worktree = ephemeralWorktreePath({ sbSlug: 'lumen', repoRoot, leaf: slug });
    try {
      const createdInputs: Array<Record<string, unknown>> = [];
      const service = new StudioOverflowService(capturingRepo(createdInputs), {
        logEvent: vi.fn(),
      } as unknown as StudioLeaseService);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'task:abc',
      });
      expect(result?.id).toBe('new-primary');
      const mcp = JSON.parse(await readFile(path.join(worktree, '.mcp.json'), 'utf8'));
      expect(Object.keys(mcp.mcpServers)).toEqual(['base-own']);
      expect(await readFile(path.join(worktree, '.env'), 'utf8')).toBe('BASE_OWN=1\n');
      // The routine ran on a checkout that kept its trusted config.
      const ran = completion.calls.find((c) => c.worktreePath === worktree);
      expect(ran?.present).toEqual(expect.arrayContaining(['.mcp.json', '.env']));
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
      await rm(origin, { recursive: true, force: true });
    }
  });
});

describe('StudioOverflowService — the parent must be in the thread’s project repo (task b5c71bc3)', () => {
  /*
   * Thread `inktrade:pr:1` routed to an Inkwell studio, and this service minted
   * its checkout from that parent's repo — detached at inkwell's
   * refs/pull/1/head, the wrong repository's PR #1. Routing now resolves the
   * project's repo and passes it here as `expectedRepoRoot`; a parent in any
   * other repo is refused outright, before a slug is read or a worktree is
   * touched. Null is the documented "hold the message" outcome.
   */
  function doubles() {
    const studios = {
      findBySlug: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    return { studios, leases };
  }

  it('ensureOverflowStudio refuses a parent outside the expected repo without reading or minting anything', async () => {
    const { studios, leases } = doubles();
    const service = new StudioOverflowService(studios, leases);

    const result = await service.ensureOverflowStudio({
      userId: 'user-1',
      sbSlug: 'lumen',
      parentStudio: makeStudio({ repoRoot: '/ws/pcp/inkwell' }),
      threadKey: 'inktrade:pr:1',
      expectedRepoRoot: '/ws/inktrade',
    });

    expect(result).toBeNull();
    expect(studios.findBySlug).not.toHaveBeenCalled();
    expect(studios.create).not.toHaveBeenCalled();
    expect(studios.update).not.toHaveBeenCalled();
    expect(leases.logEvent).not.toHaveBeenCalled();
  });

  it('ensureOverflowStudio proceeds when the parent is in the expected repo', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-project-'));
    try {
      const existing = makeStudio({
        id: 'eph-inktrade-1',
        slug: 'review-inktrade--inktrade-pr-1',
        repoRoot: '/ws/inktrade',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'inktrade:pr:1',
        metadata: { overflow: true },
        worktreePath,
      });
      const { studios, leases } = doubles();
      (studios.findBySlug as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      const service = new StudioOverflowService(studios, leases);

      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        sbSlug: 'lumen',
        parentStudio: makeStudio({ slug: 'review-inktrade', repoRoot: '/ws/inktrade' }),
        threadKey: 'inktrade:pr:1',
        expectedRepoRoot: '/ws/inktrade',
      });

      expect(result?.id).toBe('eph-inktrade-1');
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('findOverflowStudio never hands back an overflow hanging off a parent in another repo', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-project-find-'));
    try {
      // The mis-repo overflow row from the incident: live, matching thread,
      // parent in inkwell. Without the guard it is "the placement" and the
      // reviewer lands in inkwell PR #1 again.
      const wrongRepo = makeStudio({
        id: 'eph-wrong-repo',
        slug: 'lumen-review--inktrade-pr-1',
        repoRoot: '/ws/pcp/inkwell',
        ephemeral: true,
        parentStudioId: 'parent-1',
        threadKey: 'inktrade:pr:1',
        metadata: { overflow: true },
        worktreePath,
      });
      const { studios, leases } = doubles();
      (studios.findBySlug as ReturnType<typeof vi.fn>).mockResolvedValue(wrongRepo);
      const service = new StudioOverflowService(studios, leases);

      const unguarded = await service.findOverflowStudio({
        userId: 'user-1',
        parentStudio: makeStudio({ repoRoot: '/ws/pcp/inkwell' }),
        threadKey: 'inktrade:pr:1',
      });
      // Control: the same row IS found when no repo is expected, so the null
      // below is the guard and not a fixture that matches nothing.
      expect(unguarded?.id).toBe('eph-wrong-repo');

      const guarded = await service.findOverflowStudio({
        userId: 'user-1',
        parentStudio: makeStudio({ repoRoot: '/ws/pcp/inkwell' }),
        threadKey: 'inktrade:pr:1',
        expectedRepoRoot: '/ws/inktrade',
      });
      expect(guarded).toBeNull();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });
});
