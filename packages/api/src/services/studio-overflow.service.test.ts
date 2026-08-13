/**
 * Overflow studio unit tests — deterministic naming and the reuse path.
 * Worktree creation itself is git-heavy and covered by the lease integration
 * flow; here we prove the ladder's step 1 (reuse) short-circuits creation.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { threadSlug, overflowSlug, StudioOverflowService } from './studio-overflow.service';
import type { Studio, StudiosRepository } from '../data/repositories/studios.repository';
import type { StudioLeaseService } from './studio-lease.service';

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
    expiresAt: null,
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
    cleanedAt: null,
    ...overrides,
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
  });

  it('never returns an empty slug', () => {
    expect(threadSlug(':::')).toBe('thread');
  });
});

describe('overflowSlug', () => {
  it('matches the spec naming: <parent-slug>--<thread-slug>', () => {
    expect(overflowSlug(makeStudio(), 'pr:476')).toBe('lumen-review--pr-476');
  });

  it('falls back to the worktree folder name when slug is missing', () => {
    const parent = makeStudio({ slug: null });
    expect(overflowSlug(parent, 'pr:476')).toBe('inkwell--lumen-review--pr-476');
  });
});

describe('StudioOverflowService.ensureOverflowStudio — reuse', () => {
  it('reuses an existing open ephemeral studio whose worktree still exists', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'overflow-reuse-'));
    try {
      const existing = makeStudio({
        id: 'eph-1',
        slug: 'lumen-review--pr-476',
        ephemeral: true,
        parentStudioId: 'parent-1',
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

  it('refuses to tear down a non-ephemeral studio', async () => {
    const studios = { markCleaned: vi.fn() } as unknown as StudiosRepository;
    const leases = { logEvent: vi.fn() } as unknown as StudioLeaseService;
    const service = new StudioOverflowService(studios, leases);

    await service.teardownEphemeralStudio(makeStudio({ ephemeral: false }), { reason: 'test' });
    expect(studios.markCleaned).not.toHaveBeenCalled();
  });

  it('aborts teardown — worktree left in place — when the rescue fails', async () => {
    // A directory that exists but is not a git repo: capture errors, so
    // destruction must not proceed and the row must not be marked cleaned.
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'overflow-norescue-'));
    try {
      const studios = { markCleaned: vi.fn() } as unknown as StudiosRepository;
      const logEvent = vi.fn();
      const leases = { logEvent } as unknown as StudioLeaseService;
      const service = new StudioOverflowService(studios, leases);

      await service.teardownEphemeralStudio(
        makeStudio({ ephemeral: true, worktreePath: nonRepoDir, repoRoot: nonRepoDir }),
        { reason: 'thread pr:476 closed' }
      );

      expect(studios.markCleaned).not.toHaveBeenCalled();
      // The worktree is still on disk.
      await expect(rm(nonRepoDir, { recursive: true })).resolves.toBeUndefined();
      const conflictCall = logEvent.mock.calls.find((c) => c[2] === 'conflict');
      expect(conflictCall?.[3]?.reason).toContain('teardown-aborted-rescue-failed');
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
