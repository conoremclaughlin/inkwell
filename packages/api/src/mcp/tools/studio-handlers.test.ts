/**
 * Regression: create_studio must seed a new studio's local config from the
 * resolved MAIN worktree root, not from the caller's repoRoot. A linked
 * worktree calling create_studio would otherwise copy its own customised
 * .mcp.json (or nothing at all) into the new studio even when main has the
 * canonical bootstrap files. Mirrors the CLI's canonical-main default
 * (resolveCopySourceRoot).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

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

vi.mock('../../services/studio-settings', () => ({
  ensureStudioSettings: vi.fn(async () => undefined),
}));

// Defaults let the pre-existing bootstrap tests run unchanged: a caller with
// no identifiable session, and a lease that grants. The provenance suite
// below overrides per test.
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
    // The thread home is bound by PRINCIPAL (spec inkmail-thread-scope §3):
    // the agent's identity in its one workspace, resolved at the boundary.
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
import { handleCreateStudio, handleAdoptStudio } from './studio-handlers';
import type { DataComposer } from '../../data/composer';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const MAIN_MCP = JSON.stringify({
  mcpServers: { inkwell: { type: 'http', url: 'http://main-config' } },
});
const LINKED_MCP = JSON.stringify({
  mcpServers: { inkwell: { type: 'http', url: 'http://linked-custom' } },
});

describe('handleCreateStudio bootstrap source', () => {
  let base: string;
  let mainRoot: string;
  let linkedPath: string;

  const studiosCreate = vi.fn(async (input: Record<string, unknown>) => ({
    id: 'studio-test-id',
    status: 'active',
    createdAt: '2026-08-12T00:00:00Z',
    ...input,
  }));

  const dataComposer = {
    getClient: () => ({}),
    repositories: {
      studios: { create: studiosCreate, update: vi.fn(async () => ({})) },
      projects: { findById: vi.fn() },
      activityStream: { logActivity: vi.fn(async () => ({})) },
    },
  } as unknown as DataComposer;

  beforeEach(() => {
    // realpath because git prints resolved worktree paths (macOS tmpdir is a
    // symlink: /var/folders → /private/var/folders) and the handler derives
    // the new studio path from git's output.
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'studio bootstrap-')));
    mainRoot = path.join(base, 'repo');
    mkdirSync(mainRoot);
    git(['init', '-b', 'main'], mainRoot);
    git(['config', 'user.email', 'test@example.com'], mainRoot);
    git(['config', 'user.name', 'Test'], mainRoot);
    writeFileSync(path.join(mainRoot, '.gitignore'), '.mcp.json\n.env.local\n.codex/\n.gemini/\n');
    git(['add', '.gitignore'], mainRoot);
    writeFileSync(path.join(base, 'commit-message.txt'), 'init\n');
    git(['commit', '-F', path.join(base, 'commit-message.txt')], mainRoot);

    // Bootstrap files are gitignored — they exist only as local files in main
    writeFileSync(path.join(mainRoot, '.mcp.json'), MAIN_MCP);
    writeFileSync(path.join(mainRoot, '.env.local'), 'SOURCE=main\n');

    // A linked worktree with a customised .mcp.json and no .env.local
    linkedPath = path.join(base, 'repo--linked');
    git(['worktree', 'add', '-b', 'linked', '--', linkedPath], mainRoot);
    writeFileSync(path.join(linkedPath, '.mcp.json'), LINKED_MCP);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('seeds a studio created from a linked worktree with main config, not the linked copy', async () => {
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot: linkedPath, // caller is inside the linked worktree
        slug: 'fresh',
        baseBranch: 'main',
      },
      dataComposer
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const studioPath = path.join(base, 'repo--fresh');
    expect(existsSync(studioPath)).toBe(true);

    // .mcp.json must come from main, not the linked worktree's customised copy
    expect(readFileSync(path.join(studioPath, '.mcp.json'), 'utf-8')).toBe(MAIN_MCP);
    // .env.local exists only in main — bootstrapping from the linked path
    // would have copied nothing
    expect(readFileSync(path.join(studioPath, '.env.local'), 'utf-8')).toBe('SOURCE=main\n');

    // The studio record is anchored to the resolved main root as well
    expect(studiosCreate).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: mainRoot }));
  });

  it('seeds a studio created from the main root with its own config', async () => {
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot: mainRoot,
        slug: 'direct',
        baseBranch: 'main',
      },
      dataComposer
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const studioPath = path.join(base, 'repo--direct');
    expect(readFileSync(path.join(studioPath, '.mcp.json'), 'utf-8')).toBe(MAIN_MCP);
    expect(readFileSync(path.join(studioPath, '.env.local'), 'utf-8')).toBe('SOURCE=main\n');
  });
});

/**
 * close_studio must rescue before it destroys (Lumen, PR #563 P1).
 *
 * Ephemeral worktrees are detached: a CLEAN tree can hold commits reachable
 * from no branch, and `git worktree remove` deletes them without complaint.
 * The rescue behaviour itself (stash + ink-rescue anchoring) is pinned
 * behaviourally in studio-lease.service.test.ts; what a mock cannot see is
 * whether close_studio actually CALLS it inside the destructive window — so
 * the wiring is pinned in source order, the same way the ActiveRun clear
 * ordering is pinned in interrupt-active-runs.test.ts.
 */
describe('close_studio rescues before removal (source order)', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'studio-handlers.ts'),
    'utf-8'
  );
  const removalAt = source.indexOf("['worktree', 'remove', '--', studio.worktreePath]");

  it('captures with rescue enabled between the claim check and the removal', () => {
    const claimCheckAt = source.lastIndexOf('verifyClaim', removalAt);
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    expect(removalAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(claimCheckAt);
    // The capture in that window runs with rescue enabled.
    expect(source.slice(captureAt, removalAt)).toContain('rescue: true');
  });

  it('fails closed: an unsuccessful rescue aborts with the studio intact', () => {
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    const gate = source.slice(captureAt, removalAt);
    expect(gate).toContain('rescueSucceeded');
    expect(gate).toContain('abortKeepingStudioUsable');
  });

  it('tolerates an already-absent worktree instead of failing its close', () => {
    const captureAt = source.lastIndexOf('captureWorktreeState', removalAt);
    const guard = source.slice(source.lastIndexOf('worktreePresent', captureAt), captureAt);
    expect(guard).toContain('worktreePresent');
  });
});

// ── Provenance: who made a studio, and why (studio-model piece 1) ──

describe('create_studio / adopt_studio provenance', () => {
  const SESSION = '22222222-2222-4222-8222-222222222222';
  const STUDIO = '11111111-1111-4111-8111-111111111111';
  let repoRoot: string;

  function composer() {
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      id: 'studio-1',
      status: 'active',
      createdAt: '2026-09-10T00:00:00Z',
      routePatterns: null,
      ...input,
    }));
    const update = vi.fn(async (id: string, input: Record<string, unknown>) => ({ id, ...input }));
    const logActivity = vi.fn(async () => ({}));
    const existing = {
      id: STUDIO,
      slug: 'old-studio',
      worktreePath: path.join(repoRoot, 'old'),
      branch: 'wren/feat/old',
      purpose: 'an old studio',
      routePatterns: ['pr:*'],
      status: 'active',
      sbSlug: 'wren',
      userId: '00000000-0000-0000-0000-000000000001',
    };
    const findById = vi.fn(async () => existing);
    const linkSession = vi.fn(async (id: string, sessionId: string) => ({
      ...existing,
      sessionId,
    }));
    const getSession = vi.fn(async (id: string) => ({
      id,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'wren',
      sbId: 'sb-1',
      contactId: undefined,
    }));
    const dc = {
      getClient: () => ({}),
      repositories: {
        studios: { create, update, findById, linkSession },
        projects: { findById: vi.fn() },
        activityStream: { logActivity },
        memory: { getSession },
      },
    } as unknown as DataComposer;
    return { dc, create, update, logActivity, findById, linkSession, getSession, existing };
  }

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'studio-provenance-')));
    git(['init', '-b', 'main'], repoRoot);
    git(['config', 'user.email', 'test@example.com'], repoRoot);
    git(['config', 'user.name', 'Test'], repoRoot);
    writeFileSync(path.join(repoRoot, 'commit-message.txt'), 'init\n');
    git(['commit', '--allow-empty', '-F', path.join(repoRoot, 'commit-message.txt')], repoRoot);
    acquireMock.mockClear().mockResolvedValue({ acquired: true, lease: {} });
    callerMock.mockClear().mockResolvedValue({ sbSlug: 'wren', sbId: 'sb-1' });
    // The resolver only ever returns the caller's own session; the row carries
    // its identity, which the handler now verifies before using it.
    implicitMock.mockClear().mockResolvedValue({
      session: { id: 'sess-1', sbSlug: 'wren', sbId: 'sb-1' },
      via: 'context',
    });
    findOrCreateThreadMock.mockClear().mockResolvedValue({ id: 'thread-1', isNew: true });
    assignMock.mockClear().mockResolvedValue({
      sessionId: 'sess-1',
      rerouted: false,
      boundVia: 'explicit-anchor',
      stampPersisted: true,
    });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('with a threadKey: records provenance, seeds the creator lease, and routes the thread here', async () => {
    const { dc, create, update, logActivity } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'review-600',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:600',
        purpose: 'review PR 600',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    // The row: thread-scoped ground is ephemeral, expiring, owned by the creator session.
    const created = create.mock.calls[0][0];
    expect(created).toMatchObject({ threadKey: 'pr:600', ephemeral: true, sessionId: 'sess-1' });
    expect(typeof created.expiresAt).toBe('string');
    expect(created.metadata).toEqual({ createdVia: 'create_studio', createdBySessionId: 'sess-1' });
    // Routing: the exact key becomes a route pattern on this studio.
    expect(update).toHaveBeenCalledWith('studio-1', {
      threadKey: 'pr:600',
      routePatterns: ['pr:600'],
    });
    // Occupancy: the creator's lease carries the thread, so replies converge on it.
    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: 'studio-1',
        sessionId: 'sess-1',
        threadKey: 'pr:600',
        sbSlug: 'wren',
        reason: 'create_studio',
      })
    );
    // The record: who, from which session, why — in the activity log.
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = logActivity.mock.calls[0][0];
    expect(entry).toMatchObject({
      type: 'state_change',
      subtype: 'studio_created',
      sessionId: 'sess-1',
      sbId: 'sb-1',
      sbSlug: 'wren',
    });
    expect(entry.content).toContain('for pr:600');
    expect(entry.content).toContain('review PR 600');
    expect(entry.payload).toMatchObject({
      studioId: 'studio-1',
      threadKey: 'pr:600',
      via: 'create_studio',
    });
    expect(payload.lease).toEqual({ acquired: true, threadKey: 'pr:600' });
    expect(payload.ephemeral).toBe(true);
    expect(payload.provenance).toMatchObject({ sessionId: 'sess-1', logged: true });
    // Delivery: the thread gets a home — this agent's participant row points at
    // the creator's session, through the sanctioned writer, as an explicit anchor.
    expect(findOrCreateThreadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        threadKey: 'pr:600',
        creator: expect.objectContaining({ kind: 'sb', sbId: 'sb-1', sbSlug: 'wren' }),
        participants: [expect.objectContaining({ sbId: 'sb-1' })],
      })
    );
    expect(assignMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'thread-1',
        sbId: 'sb-1',
        candidateSessionId: 'sess-1',
        explicitAnchor: true,
        source: 'create_studio',
      })
    );
    expect(payload.routing).toEqual({
      threadKey: 'pr:600',
      patternInstalled: true,
      home: {
        threadId: 'thread-1',
        threadCreated: true,
        sessionId: 'sess-1',
        boundVia: 'explicit-anchor',
        persisted: true,
      },
    });
    expect(payload.warnings).toEqual([]);
    expect(entry.payload.routing).toMatchObject({
      patternInstalled: true,
      home: { sessionId: 'sess-1' },
    });
  });

  it('a route-pattern failure is surfaced, not hidden behind success (Lumen, PR #605 P2)', async () => {
    const { dc, update, logActivity } = composer();
    update.mockRejectedValue(new Error('route update failed'));
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'noroute',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:9',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true); // the studio exists
    expect(payload.routing).toMatchObject({
      threadKey: 'pr:9',
      patternInstalled: false,
      patternError: 'route update failed',
    });
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('route pattern for pr:9 was NOT installed')])
    );
    expect(logActivity.mock.calls[0][0].payload.routing).toMatchObject({
      patternInstalled: false,
      patternError: 'route update failed',
    });
  });

  it('a home-binding failure is surfaced too', async () => {
    assignMock.mockRejectedValue(new Error('participant stamp failed'));
    const { dc } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'nohome',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:10',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.routing).toMatchObject({
      patternInstalled: true,
      home: null,
      homeError: 'participant stamp failed',
    });
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('thread home for pr:10 was NOT bound')])
    );
  });

  it("an explicit sessionId that is not the caller's is refused before any side effect (Lumen, PR #605 P1)", async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: 'sb-1',
      agentBound: true,
      contactId: null,
    });
    const { dc, create, logActivity, getSession } = composer();
    getSession.mockResolvedValue({
      id: SESSION,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'lumen',
      sbId: 'other-sb',
      contactId: undefined,
    });
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'foreign',
        baseBranch: 'main',
        skipGitOperations: true,
        sessionId: SESSION,
        threadKey: 'pr:11',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to another identity');
    expect(getSession).toHaveBeenCalledWith(SESSION);
    expect(create).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('adopt_studio refuses a foreign sessionId before linking, leasing, or logging', async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: 'sb-1',
      agentBound: true,
      contactId: null,
    });
    const { dc, linkSession, logActivity, getSession } = composer();
    getSession.mockResolvedValue({
      id: SESSION,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'lumen',
      sbId: 'other-sb',
      contactId: undefined,
    });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:12' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to another identity');
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('an sbSlug that is not the authenticated identity is refused before any side effect (Lumen, PR #605 r2)', async () => {
    // Lumen's credential, typed as wren, naming Lumen's OWN valid session:
    // session authorization passes, and without the acting-identity check
    // wren's thread home would be stamped with Lumen's session under wren's name.
    callerMock.mockResolvedValue({
      sbSlug: 'lumen',
      sbId: 'sb-lumen',
      agentBound: true,
      contactId: null,
    });
    const { dc, create, logActivity, getSession } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'claimed',
        baseBranch: 'main',
        skipGitOperations: true,
        sessionId: SESSION,
        threadKey: 'pr:13',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('not the authenticated identity (lumen)');
    expect(getSession).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('adopt_studio refuses an sbSlug that is not the authenticated identity', async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'lumen',
      sbId: 'sb-lumen',
      agentBound: true,
      contactId: null,
    });
    const { dc, linkSession, logActivity, getSession } = composer();
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:13' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('not the authenticated identity (lumen)');
    expect(getSession).not.toHaveBeenCalled();
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("a user token acting as wren may not name another agent's session as the creator (explicit mismatch)", async () => {
    // Same-user authorization passes for a user token; the session is still
    // lumen's, and the thread home would be written under wren's key.
    callerMock.mockResolvedValue({ sbSlug: 'wren', agentBound: false });
    const { dc, create, logActivity, getSession } = composer();
    getSession.mockResolvedValue({
      id: SESSION,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'lumen',
      sbId: 'sb-lumen',
      contactId: undefined,
    });
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'mismatch',
        baseBranch: 'main',
        skipGitOperations: true,
        sessionId: SESSION,
        threadKey: 'pr:14',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to agent lumen, not wren');
    expect(getSession).toHaveBeenCalledWith(SESSION);
    expect(create).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('adopt_studio: the same explicit mismatch is refused before linking', async () => {
    callerMock.mockResolvedValue({ sbSlug: 'wren', agentBound: false });
    const { dc, linkSession, logActivity, getSession } = composer();
    getSession.mockResolvedValue({
      id: SESSION,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'lumen',
      sbId: 'sb-lumen',
      contactId: undefined,
    });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:14' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to agent lumen, not wren');
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("an implicit session that is not the acting identity's is not used: no creator session, lease, or home, and the response says why", async () => {
    callerMock.mockResolvedValue({ sbSlug: 'wren', agentBound: false });
    implicitMock.mockResolvedValue({
      session: { id: 'sess-lumen', sbSlug: 'lumen', sbId: 'sb-lumen' },
      via: 'context',
    });
    const { dc, create, logActivity } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'ambient',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:15',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.provenance.sessionId).toBeNull();
    expect(payload.provenance.sessionReason).toContain('identity-mismatch');
    expect(payload.provenance.sessionReason).toContain('belongs to agent lumen, not wren');
    expect(payload.warnings.join('\n')).toContain('identity-mismatch');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ sbSlug: 'wren' });
    expect(create.mock.calls[0][0].sessionId).toBeUndefined();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0][0]).toMatchObject({ sbSlug: 'wren' });
    expect(logActivity.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it('the canonical id decides when both sides carry one: same slug, other identity, no creator session', async () => {
    // "wren" in another workspace is a different identity wearing the same name.
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: 'sb-1',
      agentBound: true,
      contactId: null,
    });
    implicitMock.mockResolvedValue({
      session: { id: 'sess-twin', sbSlug: 'wren', sbId: 'sb-twin' },
      via: 'lookup',
    });
    const { dc, create } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'twin',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:17',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.provenance.sessionId).toBeNull();
    expect(payload.provenance.sessionReason).toContain('belongs to another identity (sb-twin)');
    expect(create.mock.calls[0][0].sessionId).toBeUndefined();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("adopt_studio refuses another agent's studio before linking, leasing, or logging", async () => {
    const { dc, findById, linkSession, logActivity, existing } = composer();
    findById.mockResolvedValue({ ...existing, sbSlug: 'lumen' });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:16' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to lumen, not wren');
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("create carries the credential's canonical id onto the studio row and into the lease (Lumen, PR #605 r3)", async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: 'sb-1',
      agentBound: true,
      contactId: null,
    });
    const { dc, create } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'canon',
        baseBranch: 'main',
        skipGitOperations: true,
        sessionId: SESSION,
        threadKey: 'pr:18',
      },
      dc
    );
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(create.mock.calls[0][0]).toMatchObject({ sbSlug: 'wren', sbId: 'sb-1' });
    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({ sbSlug: 'wren', sbId: 'sb-1', sessionId: SESSION })
    );
  });

  it('adopt_studio refuses ground owned by another identity wearing the same slug', async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: 'sb-1',
      agentBound: true,
      contactId: null,
    });
    const { dc, findById, linkSession, logActivity, existing } = composer();
    findById.mockResolvedValue({ ...existing, sbSlug: 'wren', sbId: 'sb-twin' });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:19' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to identity sb-twin (wren), not to wren (sb-1)');
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('a canonical owner is matched only by a canonical caller: a credential without one cannot adopt, even when the row names no slug', async () => {
    callerMock.mockResolvedValue({
      sbSlug: 'wren',
      sbId: undefined,
      agentBound: true,
      contactId: null,
    });
    const { dc, findById, linkSession, existing, getSession } = composer();
    getSession.mockResolvedValue({
      id: SESSION,
      userId: '00000000-0000-0000-0000-000000000001',
      sbSlug: 'wren',
      sbId: undefined,
      contactId: undefined,
    });
    findById.mockResolvedValue({ ...existing, sbSlug: null, sbId: 'sb-1' });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:19' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('belongs to identity sb-1 (another agent)');
    expect(payload.error).toContain('no canonical identity on this credential');
    expect(linkSession).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("a user token is held to the slug: it may adopt the user's own studio whichever canonical id the row carries", async () => {
    callerMock.mockResolvedValue({ sbSlug: 'wren', agentBound: false });
    const { dc, findById, linkSession, existing } = composer();
    findById.mockResolvedValue({ ...existing, sbSlug: 'wren', sbId: 'sb-twin' });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:20' },
      dc
    );
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(linkSession).toHaveBeenCalledWith(STUDIO, SESSION);
    // No canonical claim to carry: the lease resolves the slug as before.
    expect(acquireMock).toHaveBeenCalledWith(expect.objectContaining({ sbId: undefined }));
  });

  it("adopt_studio does not confirm another user's studio exists", async () => {
    const { dc, findById, linkSession, logActivity, existing } = composer();
    findById.mockResolvedValue({ ...existing, userId: '00000000-0000-0000-0000-000000000002' });
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:16' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('Studio not found');
    expect(linkSession).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('without a threadKey: a durable home studio, leased to the session itself, still logged', async () => {
    const { dc, create, update, logActivity } = composer();
    const result = await handleCreateStudio(
      { sbSlug: 'wren', repoRoot, slug: 'home', baseBranch: 'main', skipGitOperations: true },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(create.mock.calls[0][0]).toMatchObject({
      threadKey: null,
      ephemeral: false,
      expiresAt: null,
    });
    expect(update).not.toHaveBeenCalled();
    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: 'session:sess-1' })
    );
    expect(logActivity.mock.calls[0][0].subtype).toBe('studio_created');
    expect(payload.ephemeral).toBe(false);
  });

  it('durable: true keeps a thread-scoped studio past the ephemeral expiry', async () => {
    const { dc, create } = composer();
    await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'kept',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:7',
        durable: true,
      },
      dc
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      threadKey: 'pr:7',
      ephemeral: false,
      expiresAt: null,
    });
  });

  it('no identifiable caller session: no lease, provenance still logged, and the response says why', async () => {
    implicitMock.mockResolvedValue({ session: null, reason: 'ambiguous', candidateCount: 2 });
    const { dc, logActivity } = composer();
    const result = await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'nobody',
        baseBranch: 'main',
        skipGitOperations: true,
        threadKey: 'pr:8',
      },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(acquireMock).not.toHaveBeenCalled();
    const entry = logActivity.mock.calls[0][0];
    expect(entry.sessionId).toBeUndefined();
    expect(entry.payload).toMatchObject({ sessionId: null, sessionReason: 'ambiguous' });
    expect(payload.lease).toBeNull();
    expect(payload.provenance).toMatchObject({
      sessionId: null,
      sessionReason: 'ambiguous',
      logged: true,
    });
  });

  it('an explicit sessionId wins and the implicit resolver is not consulted', async () => {
    const { dc, create } = composer();
    await handleCreateStudio(
      {
        sbSlug: 'wren',
        repoRoot,
        slug: 'explicit',
        baseBranch: 'main',
        skipGitOperations: true,
        sessionId: SESSION,
      },
      dc
    );
    expect(implicitMock).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({ sessionId: SESSION });
    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, threadKey: `session:${SESSION}` })
    );
  });

  it('adopt_studio: logs the adoption, seeds the lease, and never steals a held studio', async () => {
    acquireMock.mockResolvedValue({
      acquired: false,
      holder: { sessionId: 'other', threadKey: 'pr:1' },
    });
    const { dc, update, logActivity, linkSession } = composer();
    const result = await handleAdoptStudio(
      { sbSlug: 'wren', sessionId: SESSION, studioId: STUDIO, threadKey: 'pr:601' },
      dc
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(linkSession).toHaveBeenCalledWith(STUDIO, SESSION);
    // The thread key joins the existing patterns instead of replacing them.
    expect(update).toHaveBeenCalledWith(STUDIO, {
      threadKey: 'pr:601',
      routePatterns: ['pr:*', 'pr:601'],
    });
    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: STUDIO,
        sessionId: SESSION,
        threadKey: 'pr:601',
        reason: 'adopt_studio',
      })
    );
    const entry = logActivity.mock.calls[0][0];
    expect(entry).toMatchObject({
      type: 'state_change',
      subtype: 'studio_adopted',
      sessionId: SESSION,
    });
    expect(entry.content).toContain('Adopted studio old-studio for pr:601');
    // Held by someone else: reported, not taken.
    expect(payload.lease).toEqual({
      acquired: false,
      threadKey: 'pr:601',
      holder: { sessionId: 'other', threadKey: 'pr:1' },
    });
  });
});
