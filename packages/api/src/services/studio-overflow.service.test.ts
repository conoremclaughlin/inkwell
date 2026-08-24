/**
 * Overflow studio unit tests — deterministic naming, verified reuse, and the
 * teardown fence. Worktree creation itself is git-heavy and covered by the
 * lease integration flow; here we prove the ladder's step 1 (reuse) only
 * matches the exact (parent, threadKey) ephemeral, and that destruction is
 * gated on winning the teardown claim.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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
} from './studio-overflow.service';
import type { Studio, StudiosRepository } from '../data/repositories/studios.repository';
import type { StudioLeaseService, StudioLease } from './studio-lease.service';

function makeStudio(overrides: Partial<Studio> = {}): Studio {
  return {
    id: 'parent-1',
    userId: 'user-1',
    agentId: 'lumen',
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
    agentId: 'system',
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
        agentId: 'lumen',
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
      .mockResolvedValueOnce(null); // hash variant → free
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
      agentId: 'lumen',
      parentStudio: makeStudio({ repoRoot: '/nonexistent/repo' }),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(findBySlug).toHaveBeenCalledTimes(2);
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
    const findBySlug = vi.fn().mockResolvedValueOnce(otherThreads).mockResolvedValueOnce(null);
    const studios = {
      findBySlug,
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

    const service = new StudioOverflowService(studios, leases);
    const result = await service.ensureOverflowStudio({
      userId: 'user-1',
      agentId: 'lumen',
      parentStudio: makeStudio({ repoRoot: '/nonexistent/repo' }),
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(studios.update).not.toHaveBeenCalled();
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
      agentId: 'lumen',
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
        agentId: 'lumen',
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

  // Transition hazard: legacy chained worktrees keep flat `eph/` branches
  // checked out, so a post-fix flat mint fails `git worktree add` on
  // `already used by worktree`. Creation failure must fall through to the
  // hash variant (fresh slug AND fresh branch), not give up. Real repo so
  // the primary genuinely fails on the branch and the variant genuinely
  // succeeds.
  it('a branch held by a legacy worktree falls through to the hash variant', async () => {
    const repoRoot = await makeGitRepo();
    const blocker = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}--legacy-chain`);
    const hashSlug = `lumen-review--pr-476-h${slugHash('pr:476')}`;
    const hashWorktree = path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}--${hashSlug}`
    );
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
          return Promise.resolve(makeStudio({ id: 'new-hash', ...(input as Partial<Studio>) }));
        }),
        update: vi.fn(),
      } as unknown as StudiosRepository;
      const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;

      const service = new StudioOverflowService(studios, leases);
      const result = await service.ensureOverflowStudio({
        userId: 'user-1',
        agentId: 'lumen',
        parentStudio: makeStudio({ repoRoot, worktreePath: repoRoot }),
        threadKey: 'pr:476',
      });

      expect(result?.id).toBe('new-hash');
      expect(createdInputs).toHaveLength(1);
      expect(createdInputs[0].branch).toBe(`lumen/eph/pr-476-h${slugHash('pr:476')}`);
      expect(String(createdInputs[0].worktreePath)).toContain(hashSlug);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', hashWorktree], {
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
    const primaryWorktree = path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}--lumen-review--pr-476`
    );
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
        agentId: 'lumen',
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

  // r2: a revive UPDATE back into the live predicate is arbitrated by the
  // partial unique index (integration-proven); the service's side of the
  // contract is losing cleanly — null result, worktree removed, no throw.
  it('a revive loss fails the call and removes the created worktree', async () => {
    const repoRoot = await makeGitRepo();
    const primaryWorktree = path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}--lumen-review--pr-476`
    );
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
        agentId: 'lumen',
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
      agentId: 'lumen',
      parentStudio: ephA,
      threadKey: 'pr:476',
    });

    expect(result).toBeNull();
    expect(findById).toHaveBeenCalledTimes(1);
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
