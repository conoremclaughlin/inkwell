/**
 * Overflow studio unit tests — deterministic naming, verified reuse, and the
 * teardown fence. Worktree creation itself is git-heavy and covered by the
 * lease integration flow; here we prove the ladder's step 1 (reuse) only
 * matches the exact (parent, threadKey) ephemeral, and that destruction is
 * gated on winning the teardown claim.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
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
