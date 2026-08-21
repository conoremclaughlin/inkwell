/**
 * Phase 6b — acquisition on intent (task c82daba1 rules 2–3; Lumen #517 r1
 * blockers 5–6).
 *
 * Isolated from session-service.test.ts because these tests mock the
 * StudioLeaseService and ThreadKeyService MODULES, and file-level vi.mock
 * would leak into the 150+ tests there.
 *
 * Intent is resolved ONCE, before routing (blocker 5): one resolution feeds
 * both the occupancy gate and the lease gate. MECHANISM tests: until 6e
 * every template is write, so production behavior is unchanged.
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
  agentId: 'wren',
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
    agentId: 'wren',
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
    (service as any).resolveThreadBehavior('user-1', 'spec:some-design') as Promise<{
      writeIntent: string;
      studioPolicy: string;
    }>;

  it('resolves intent AND policy from the STORED pinned key_type via the registry', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'presence', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: 'spec' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'presence',
      studioPolicy: 'reuse-only',
    });
    expect(typeBehaviorMock).toHaveBeenCalledWith('user-1', 'spec');
  });

  it('a provision type carries its policy through', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'provision' });
    const { service } = serviceWith({ data: { key_type: 'pr' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'provision',
    });
  });

  it('an untyped thread resolves through the registry default (write + reuse-only)', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: null } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
    });
    expect(typeBehaviorMock).toHaveBeenCalledWith('user-1', null);
  });

  it('a thread-row lookup ERROR fails toward write + reuse-only', async () => {
    // Write: failing toward presence would mutate an unleased tree.
    // Reuse-only: a worktree built off a failed lookup is pure waste.
    const { service } = serviceWith({ error: { message: 'db down' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
    });
  });

  it('a registry THROW fails toward write + reuse-only', async () => {
    typeBehaviorMock.mockRejectedValue(new Error('registry down'));
    const { service } = serviceWith({ data: { key_type: 'spec' } });
    await expect(resolve(service)).resolves.toEqual({
      writeIntent: 'write',
      studioPolicy: 'reuse-only',
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
      agentId: 'wren',
      threadKey: 'spec:some-design',
      writeIntent: 'presence',
    });
    expect(decision).toMatchObject({ studioId: 'studio-1', occupancyChecked: false });
    // The mocked lease service's getLease was never consulted.
    expect(acquireMock).not.toHaveBeenCalled();
  });
});
