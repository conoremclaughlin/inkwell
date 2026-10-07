/**
 * Registration through the routine records the worktree as it IS (Lumen,
 * PR #692 round 1). `ink init` in a bare linked worktree registers its row
 * through create_studio with the git work already done; the handler used to
 * invent a sibling path and a `feat` branch from the slug, so a checkout at
 * any other path or branch was recorded wrong while the checklist read
 * complete. The real `runInit` drives the real handler over mocked
 * repositories; no database, no server.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv },
  isDevelopment: () => false,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn(async () => ({
      user: { id: '00000000-0000-0000-0000-000000000001' },
    })),
  };
});
vi.mock('../../services/studio-complete', () => ({
  completeStudioViaCli: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
  ensureStudioComplete: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
}));
const { acquireMock, implicitMock, callerMock, findOrCreateThreadMock, assignMock, callerSbMock } =
  vi.hoisted(() => ({
    acquireMock: vi.fn(async () => ({ acquired: true, lease: {} })),
    implicitMock: vi.fn(async () => ({ session: null, reason: 'no-session' })),
    callerMock: vi.fn(async () => ({ sbSlug: 'wren', sbId: undefined })),
    findOrCreateThreadMock: vi.fn(async () => ({ id: 'thread-1', isNew: true })),
    assignMock: vi.fn(async () => ({
      sessionId: 'sess-1',
      rerouted: false,
      boundVia: 'explicit-anchor',
      stampPersisted: true,
    })),
    callerSbMock: vi.fn(async () => ({
      kind: 'sb',
      sbId: 'sb-1',
      sbSlug: 'wren',
      userId: '00000000-0000-0000-0000-000000000001',
      workspaceId: 'ws-1',
    })),
  }));
vi.mock('./inbox-handlers', () => ({ findOrCreateThread: findOrCreateThreadMock }));
vi.mock('./caller-principal', () => ({ resolveCallerSb: callerSbMock }));
vi.mock('../../services/sessions/thread-assignment', () => ({
  assignThreadParticipant: assignMock,
}));
vi.mock('./memory-handlers', () => ({
  resolveCaller: callerMock,
  resolveImplicitSession: implicitMock,
}));
vi.mock('../../services/studio-lease.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/studio-lease.service')>();
  return {
    ...actual,
    StudioLeaseService: class {
      acquire = acquireMock;
    },
  };
});

import { handleCreateStudio } from './studio-handlers';
import type { DataComposer } from '../../data/composer';
import { runInit } from '../../../../cli/src/commands/init.js';
import { deriveStudioSlug } from '../../data/repositories/studios.repository';

const ROW_ID = '00000000-0000-4000-8000-000000000692';

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pr692-register-')));
  const main = path.join(base, 'repo');
  const actual = path.join(base, 'some-other-directory');
  mkdirSync(main);
  const git = (args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(base, 'message'), 'fixture root\n');
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '--allow-empty',
    '-F',
    path.join(base, 'message'),
  ]);
  git(['worktree', 'add', '-q', '-b', 'wren/fix/existing', actual]);
  return { base, main, actual };
}

function composer(
  rows: Record<string, unknown>[],
  existing: Record<string, unknown> | null = null
) {
  return {
    getClient: () => ({}),
    repositories: {
      studios: {
        create: vi.fn(async (args: Record<string, unknown>) => {
          rows.push(args);
          return { ...args, id: ROW_ID };
        }),
        // The repository applies the patch it receives and returns the row;
        // the mock does the same so the handler's response is the row as
        // persisted, not a synthesis.
        update: vi.fn(async (_id: string, patch: Record<string, unknown>) =>
          existing ? Object.assign(existing, patch) : {}
        ),
        findByPath: vi.fn(async () => existing),
      },
      activityStream: { logActivity: vi.fn(async () => ({})) },
      projects: { findById: vi.fn() },
    },
  } as unknown as DataComposer;
}

describe('registration records the worktree as it is', () => {
  it('a bare linked worktree is registered at its actual path and branch', async () => {
    const { base, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    const dc = composer(rows);
    try {
      const report = await runInit(
        actual,
        { agent: 'wren' },
        {
          register: async (args) => {
            const result = await handleCreateStudio({ ...args, skipGitOperations: true }, dc);
            const payload = JSON.parse(result.content[0].text);
            expect(payload.success).toBe(true);
            return payload.studio.id;
          },
          syncSkills: async () => ({ label: 'skills sync', status: 'skipped' }),
          // A manual init reads its permission profile from the row by path;
          // never the live server from a test.
          lookupStudio: async () => ({
            status: 'found' as const,
            row: { id: ROW_ID, sbSlug: 'wren', permissionProfile: 'builder' as const },
          }),
        }
      );
      expect(report.audit.complete).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ worktreePath: actual, branch: 'wren/fix/existing' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a worktree that already has a row is repaired onto that row, not registered twice', async () => {
    const { base, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    const existing = {
      id: '00000000-0000-4000-8000-000000000777',
      worktreePath: actual,
      sbSlug: 'wren',
      userId: '00000000-0000-0000-0000-000000000001',
    };
    const dc = composer(rows, existing);
    try {
      const report = await runInit(
        actual,
        { agent: 'wren' },
        {
          register: async (args) => {
            const result = await handleCreateStudio({ ...args, skipGitOperations: true }, dc);
            const payload = JSON.parse(result.content[0].text);
            expect(payload.success).toBe(true);
            return payload.studio.id;
          },
          syncSkills: async () => ({ label: 'skills sync', status: 'skipped' }),
          // A manual init reads its permission profile from the row by path;
          // never the live server from a test.
          lookupStudio: async () => ({
            status: 'found' as const,
            row: { id: ROW_ID, sbSlug: 'wren', permissionProfile: 'builder' as const },
          }),
        }
      );
      expect(report.audit.complete).toBe(true);
      expect(rows).toHaveLength(0);
      const identity = JSON.parse(
        (await import('fs')).readFileSync(path.join(actual, '.ink', 'identity.json'), 'utf8')
      );
      expect(identity.studioId).toBe(existing.id);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('the path and branch are honoured only with the git work already done', async () => {
    const { base, main } = fixture();
    const rows: Record<string, unknown>[] = [];
    const dc = composer(rows);
    try {
      const result = await handleCreateStudio(
        {
          sbSlug: 'wren',
          repoRoot: main,
          slug: 'fresh',
          worktreePath: path.join(base, 'anywhere'),
          branch: 'wren/fix/anything',
        },
        dc
      );
      const payload = JSON.parse(result.content[0].text);
      // Without skipGitOperations the server creates the worktree itself, at
      // its own sibling path and branch; a client cannot point it elsewhere.
      expect(payload.success).toBe(true);
      expect(rows[0].worktreePath).toBe(path.join(base, 'repo--fresh'));
      expect(rows[0].branch).toBe('wren/feat/fresh');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * Round 2 (Lumen): the reuse added for repair must be the CALLER's row, at
 * a lifecycle the session resolver accepts, and the row must carry the slug
 * the caller chose.
 */
describe('registration reuse boundaries (Lumen, PR #692 round 2)', () => {
  const USER = '00000000-0000-0000-0000-000000000001';

  it("does not return a foreign canonical owner's row as the caller's repaired studio", async () => {
    const { base, main, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    // Same slug, another canonical identity (another workspace's "wren").
    const foreign = {
      id: '00000000-0000-4000-8000-000000000777',
      userId: USER,
      sbSlug: 'wren',
      sbId: '00000000-0000-4000-8000-000000000002',
      worktreePath: actual,
      branch: 'wren/fix/existing',
      status: 'active',
    };
    callerMock.mockResolvedValueOnce({
      sbSlug: 'wren',
      sbId: '00000000-0000-4000-8000-000000000001',
      agentBound: true,
    } as never);
    try {
      const result = await handleCreateStudio(
        {
          sbSlug: 'wren',
          repoRoot: main,
          slug: 'fixture',
          worktreePath: actual,
          branch: 'wren/fix/existing',
          skipGitOperations: true,
        },
        composer(rows, foreign)
      );
      const payload = JSON.parse(result.content[0].text);
      // A scoped creation or an explicit refusal is fine; stamping the
      // foreign studio's id into this caller's identity is not.
      expect(payload.success && payload.studio?.id === foreign.id).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not declare complete when a recreated worktree resolves to a cleaned row left unchanged', async () => {
    const { base, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    const existing = {
      id: '00000000-0000-4000-8000-000000000777',
      userId: USER,
      sbSlug: 'wren',
      sbId: null,
      worktreePath: actual,
      branch: 'wren/fix/existing',
      status: 'cleaned',
    };
    const dc = composer(rows, existing);
    try {
      const report = await runInit(
        actual,
        { agent: 'wren' },
        {
          register: async (args) => {
            const result = await handleCreateStudio({ ...args, skipGitOperations: true }, dc);
            const payload = JSON.parse(result.content[0].text);
            return payload.success ? payload.studio.id : null;
          },
          syncSkills: async () => ({ label: 'skills sync', status: 'skipped' }),
          // A manual init reads its permission profile from the row by path;
          // never the live server from a test.
          lookupStudio: async () => ({
            status: 'found' as const,
            row: { id: ROW_ID, sbSlug: 'wren', permissionProfile: 'builder' as const },
          }),
        }
      );
      // Either revive the row deliberately or refuse; success with an
      // unchanged cleaned row is an id the session resolver refuses.
      const update = dc.repositories.studios.update as unknown as { mock: { calls: unknown[] } };
      const unchanged = rows.length === 0 && update.mock.calls.length === 0;
      expect(report.audit.complete && unchanged).toBe(false);
      // The choice made here: revival, with the row set active for the caller.
      expect(update.mock.calls.length).toBe(1);
      expect(report.audit.complete).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('records the chosen studio slug even when the directory has no -- suffix', async () => {
    const { base, main, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    try {
      const result = await handleCreateStudio(
        {
          sbSlug: 'wren',
          repoRoot: main,
          slug: 'chosen-name',
          worktreePath: actual,
          branch: 'wren/fix/existing',
          skipGitOperations: true,
        },
        composer(rows)
      );
      expect(JSON.parse(result.content[0].text).success).toBe(true);
      // StudiosRepository.create derives a slug from the path only when none
      // is given; an arbitrary path derives nothing.
      const persisted =
        rows[0].slug !== undefined
          ? rows[0].slug
          : deriveStudioSlug(rows[0].worktreePath as string);
      expect(persisted).toBe('chosen-name');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * Round 3 (Lumen): reviving by status alone left an expired ephemeral row
 * with its old expiry, so listExpiredEphemeral selected it at once and the
 * sweep would have torn the recreated worktree down before any session
 * acquired it. Revival must tell one coherent story: the row describes THIS
 * checkout, is not cleaned or archived, and is not already expired.
 */
describe('revival is coherent (Lumen, PR #692 round 3)', () => {
  it('does not revive a recreated ephemeral worktree directly back into expiry eligibility', async () => {
    const { base, main, actual } = fixture();
    const rows: Record<string, unknown>[] = [];
    const existing: Record<string, unknown> = {
      id: '00000000-0000-4000-8000-000000000777',
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'wren',
      sbId: null,
      slug: 'wren-old-fixture',
      worktreePath: actual,
      repoRoot: main,
      branch: 'wren/fix/old',
      status: 'cleaned',
      ephemeral: true,
      cleanedAt: '2000-01-01T00:00:00.000Z',
      archivedAt: null,
      expiresAt: '2000-01-01T00:00:00.000Z',
      lease: null,
    };
    const dc = composer(rows, existing);
    try {
      const result = await handleCreateStudio(
        {
          sbSlug: 'wren',
          repoRoot: main,
          slug: 'fixture',
          worktreePath: actual,
          branch: 'wren/fix/existing',
          skipGitOperations: true,
        },
        dc
      );
      const payload = JSON.parse(result.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.revived).toBe(true);
      // listExpiredEphemeral's exact filters plus the sweep's vacant-row
      // selection, evaluated on the persisted state; no sweep runs here.
      const immediatelyEligible =
        existing.ephemeral === true &&
        ['active', 'idle'].includes(existing.status as string) &&
        existing.expiresAt !== null &&
        Date.parse(existing.expiresAt as string) <= Date.now() &&
        existing.lease === null;
      expect(immediatelyEligible).toBe(false);
      // The row describes this checkout, and the response is the row as persisted.
      expect(existing.branch).toBe('wren/fix/existing');
      expect(existing.cleanedAt).toBeNull();
      expect(existing.status).toBe('active');
      expect(payload.studio.branch).toBe('wren/fix/existing');
      expect(payload.studio.status).toBe('active');
      // The revived row keeps its own slug, whatever this call asked for, and
      // the response says so: it is the name send_to_inbox routes on
      // (routing spec §v19 C).
      expect(payload.studio.slug).toBe('wren-old-fixture');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
