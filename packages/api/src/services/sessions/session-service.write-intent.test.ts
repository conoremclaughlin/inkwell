/**
 * Phase 6b — acquisition on intent (task c82daba1 rules 2–3; Lumen #517 r1
 * blockers 5–6).
 *
 * Isolated from session-service.test.ts because these tests mock the
 * StudioLeaseService and ThreadKeyService MODULES, and file-level vi.mock
 * would leak into the 150+ tests there.
 *
 * Intent is resolved ONCE, before routing (blocker 5): one resolution feeds
 * both the occupancy gate and the lease gate. Discussion templates
 * (thread/spec/issue/debug) are LIVE presence as of 2026-08-24 — they bind
 * without the lock and execute; write-typed threads (pr/branch/task/deploy)
 * still acquire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const acquireMock = vi.fn();
vi.mock('../studio-lease.service.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    StudioLeaseService: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.acquire = acquireMock;
      this.getLease = vi.fn().mockResolvedValue(null);
      this.logEvent = vi.fn();
    }),
  };
});

// The registry and the thread are workspace-scoped (spec inkmail-thread-scope
// §1b): the workspace comes from the session's identity, else the user's
// personal one. Fixed here so these tests stay about the resolution.
vi.mock('../principals.js', () => ({
  workspaceOfSb: vi.fn().mockResolvedValue('ws-1'),
  personalWorkspaceOf: vi.fn().mockResolvedValue('ws-1'),
}));

const typeBehaviorMock = vi.fn();
vi.mock('../thread-key/thread-key.service.js', () => ({
  ThreadKeyService: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.typeBehavior = typeBehaviorMock;
  }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SessionService } from './session-service.js';
import type { Session } from './types.js';
import { workspaceOfSb } from '../principals.js';

function threadChain(result: { data?: unknown; error?: { message: string } | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: Record<string, any> = {};
  for (const m of ['select', 'eq', 'not', 'is', 'neq', 'in', 'order', 'limit']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  const terminal = () =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  c.maybeSingle = vi.fn().mockImplementation(terminal);
  c.single = vi.fn().mockImplementation(terminal);
  c.then = (resolve: (v: unknown) => unknown) => terminal().then(resolve);
  return c;
}

function serviceWith(threadRow: { data?: unknown; error?: { message: string } | null }) {
  const supabase = {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        table === 'inbox_threads' ? threadChain(threadRow) : threadChain({ data: null })
      ),
  };
  const repository = {
    update: vi
      .fn()
      .mockImplementation((id: string, patch: Record<string, unknown>) =>
        Promise.resolve({ ...SESSION, ...patch })
      ),
  };
  const service = new SessionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { addEntry: vi.fn() } as any,
    { defaultWorkingDirectory: '/test', mcpConfigPath: '/test/.mcp.json' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase as any
  );
  return { service, repository };
}

const SESSION: Session = {
  id: 'sess-1',
  userId: 'user-1',
  sbSlug: 'wren',
  studioId: 'studio-1',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const ROUTING = { studioId: 'studio-1', tier: 'route-pattern', occupancyChecked: true } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runLease(
  service: SessionService,
  writeIntent: 'write' | 'presence'
): Promise<Session> {
  // withStudioLease is private; this suite tests the gate at its boundary.
  // Intent arrives via ctx — resolved once, before routing (blocker 5).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).withStudioLease(SESSION, ROUTING, {
    userId: 'user-1',
    sbSlug: 'wren',
    threadKey: 'spec:some-design',
    writeIntent,
  });
}

describe('Phase 6b — lease gate consumes the pre-resolved intent', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue({ acquired: true, lease: {} });
    typeBehaviorMock.mockReset();
  });

  it('presence binds the studio WITHOUT acquiring', async () => {
    const { service } = serviceWith({ data: null });
    const result = await runLease(service, 'presence');
    expect(result.studioId).toBe('studio-1'); // bound…
    expect(acquireMock).not.toHaveBeenCalled(); // …without the write lock
  });

  it('write acquires exactly as before', async () => {
    const { service } = serviceWith({ data: null });
    await runLease(service, 'write');
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it('occupied + overflow unavailable HOLDS — throws occupied, never clears to the default cwd', async () => {
    // Blocker 6: the cleared binding executed from defaultWorkingDirectory,
    // which is routinely the SAME occupied root. divertToOverflow fails here
    // (no overflow service wiring in this harness), so the fallback must
    // throw the occupied hold.
    acquireMock.mockResolvedValue({
      acquired: false,
      holder: { threadKey: 'pr:OTHER', sessionId: 'sess-foreign' },
    });
    const { service, repository } = serviceWith({ data: null });
    await expect(runLease(service, 'write')).rejects.toMatchObject({
      code: 'ROUTING_REFUSED',
      detail: { reason: 'occupied', occupied: { holderThreadKey: 'pr:OTHER' } },
    });
    // And the binding was NOT cleared to studioless.
    expect(repository.update).not.toHaveBeenCalledWith('sess-1', { studioId: null });
  });
});

describe('Phase 6b — resolveThreadBehavior (the single pre-routing resolution)', () => {
  beforeEach(() => {
    typeBehaviorMock.mockReset();
  });

  const resolve = (service: SessionService) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).resolveThreadBehavior('user-1', null, 'spec:some-design') as Promise<{
      writeIntent: string;
      studioPolicy: string;
      project: unknown;
    }>;

  it('resolves intent AND policy from the STORED pinned key_type via the registry', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'presence', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: 'spec' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'presence',
      studioPolicy: 'reuse-only',
      project: null,
    });
    // Resolved in the WORKSPACE, never under the user (§1b).
    expect(typeBehaviorMock).toHaveBeenCalledWith('ws-1', 'spec');
  });

  it('a provision type carries its policy through', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'provision' });
    const { service } = serviceWith({ data: { key_type: 'pr' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'provision',
      project: null,
    });
  });

  it('an untyped thread resolves through the registry default (write + reuse-only)', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: null } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: null,
    });
    expect(typeBehaviorMock).toHaveBeenCalledWith('ws-1', null);
  });

  it('a thread-row lookup ERROR fails toward write + reuse-only', async () => {
    // Write: failing toward presence would mutate an unleased tree.
    // Reuse-only: a worktree built off a failed lookup is pure waste.
    const { service } = serviceWith({ error: { message: 'db down' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: null,
    });
  });

  it('a registry THROW fails toward write + reuse-only', async () => {
    typeBehaviorMock.mockRejectedValue(new Error('registry down'));
    const { service } = serviceWith({ data: { key_type: 'spec' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: null,
    });
  });
});

describe('resolveThreadBehavior — the pinned project and its repo (task b5c71bc3)', () => {
  /*
   * The same single pre-routing resolution now also carries the project the
   * key was pinned to (inbox_threads.key_project) and the repo that project
   * names, read by (workspace_id, slug). It is what routing scopes every
   * inferred rung to, so the contract here is what keeps a project-prefixed
   * thread out of another project's checkout.
   */
  beforeEach(() => {
    typeBehaviorMock.mockReset();
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'provision' });
  });

  function serviceWithTables(tables: {
    inbox_threads: { data?: unknown; error?: { message: string } | null };
    projects?: { data?: unknown; error?: { message: string } | null };
  }) {
    const chains: Record<string, ReturnType<typeof threadChain>> = {};
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        const row =
          table === 'inbox_threads'
            ? tables.inbox_threads
            : table === 'projects'
              ? (tables.projects ?? { data: null })
              : { data: null };
        chains[table] = threadChain(row);
        return chains[table];
      }),
    };
    const service = new SessionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { update: vi.fn() } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { addEntry: vi.fn() } as any,
      { defaultWorkingDirectory: '/test', mcpConfigPath: '/test/.mcp.json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any
    );
    return { service, supabase, chains };
  }

  const resolve = (service: SessionService, key = 'inktrade:pr:1') =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).resolveThreadBehavior('user-1', null, key) as Promise<unknown>;

  it('resolves the pinned project to its repo by (workspace_id, slug)', async () => {
    const { service, chains } = serviceWithTables({
      inbox_threads: { data: { key_type: 'pr', key_project: 'inktrade' } },
      projects: { data: { slug: 'inktrade', repo_root: '/repos/inktrade' } },
    });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'provision',
      project: { slug: 'inktrade', repoRoot: '/repos/inktrade' },
    });
    expect(chains.projects.eq).toHaveBeenCalledWith('workspace_id', 'ws-1');
    expect(chains.projects.eq).toHaveBeenCalledWith('slug', 'inktrade');
  });

  it('names the cause when the project has no repo, is gone, or cannot be read', async () => {
    const cases = [
      [{ data: { slug: 'inktrade', repo_root: null } }, 'unset'],
      [{ data: null }, 'unresolved'],
      [{ error: { message: 'projects down' } }, 'unreadable'],
    ] as const;
    for (const [projects, cause] of cases) {
      const { service } = serviceWithTables({
        inbox_threads: { data: { key_type: 'pr', key_project: 'inktrade' } },
        projects,
      });
      await expect(resolve(service)).resolves.toMatchObject({
        project: { slug: 'inktrade', repoRoot: null, cause },
      });
    }
  });

  it('an unprefixed key carries no project and never reads the projects table', async () => {
    const { service, supabase } = serviceWithTables({
      inbox_threads: { data: { key_type: 'pr', key_project: null } },
    });
    await expect(resolve(service, 'pr:1')).resolves.toMatchObject({ project: null });
    expect(supabase.from).not.toHaveBeenCalledWith('projects');
  });

  it('an unreadable thread row holds a key that MAY carry a prefix, and degrades a two-segment key', async () => {
    // Routing an unreadable `inktrade:pr:1` by the sender's repo is the
    // mis-repo outcome; `pr:1` has no prefix to lose and keeps the degrade.
    const { service: prefixed } = serviceWithTables({
      inbox_threads: { error: { message: 'db down' } },
    });
    await expect(resolve(prefixed)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: { slug: 'inktrade', repoRoot: null, cause: 'unreadable' },
    });
    const { service: plain } = serviceWithTables({
      inbox_threads: { error: { message: 'db down' } },
    });
    await expect(resolve(plain, 'pr:1')).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: null,
    });
  });

  it('a workspace lookup THROW holds a key that may carry a prefix; a null workspace keeps the degrade', async () => {
    // A failed scope lookup is not proof that a pin cannot exist (Lumen,
    // #681 round 1): one transient exception must not route `inktrade:pr:1`
    // by the sender's repo. An identity with NO workspace is a positive
    // answer — no thread row can have been pinned in one — and degrades.
    vi.mocked(workspaceOfSb).mockRejectedValueOnce(new Error('transient lookup failure'));
    const { service: thrown } = serviceWithTables({
      inbox_threads: { data: { key_type: 'pr', key_project: 'inktrade' } },
      projects: { data: { slug: 'inktrade', repo_root: '/repos/inktrade' } },
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (thrown as any).resolveThreadBehavior('user-1', 'sb-1', 'inktrade:pr:1')
    ).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: { slug: 'inktrade', repoRoot: null, cause: 'unreadable' },
    });

    vi.mocked(workspaceOfSb).mockResolvedValueOnce(null);
    const { service: none } = serviceWithTables({
      inbox_threads: { data: { key_type: 'pr', key_project: 'inktrade' } },
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (none as any).resolveThreadBehavior('user-1', 'sb-1', 'inktrade:pr:1')
    ).resolves.toEqual({ writeIntent: 'write', studioPolicy: 'reuse-only', project: null });
  });

  it('a registry THROW degrades intent and policy but keeps the readable pin', async () => {
    // The placement probe's key has no registered type and its registry
    // read throws; that is a behaviour degrade, not an unreadable pin.
    typeBehaviorMock.mockRejectedValue(new Error('registry down'));
    const { service } = serviceWithTables({
      inbox_threads: { data: { key_type: 'pr', key_project: 'inktrade' } },
      projects: { data: { slug: 'inktrade', repo_root: '/repos/inktrade' } },
    });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
      project: { slug: 'inktrade', repoRoot: '/repos/inktrade' },
    });
  });
});

describe('Phase 6b — occupancy gate is intent-aware (blocker 5)', () => {
  it('presence bypasses gateOccupancy entirely — no lease read, no divert', async () => {
    acquireMock.mockReset();
    const { service } = serviceWith({ data: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decision = await (service as any).gateOccupancy('studio-1', 'route-pattern', {
      userId: 'user-1',
      sbSlug: 'wren',
      threadKey: 'spec:some-design',
      writeIntent: 'presence',
    });
    expect(decision).toMatchObject({ studioId: 'studio-1', occupancyChecked: false });
    // The mocked lease service's getLease was never consulted.
    expect(acquireMock).not.toHaveBeenCalled();
  });
});
