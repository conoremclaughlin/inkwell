/**
 * Phase 6b — acquisition on intent (task c82daba1 rules 2–3).
 *
 * Isolated from session-service.test.ts because these tests mock the
 * StudioLeaseService and ThreadKeyService MODULES, and file-level vi.mock
 * would leak into the 150+ tests there.
 *
 * MECHANISM tests: until 6e every template is write, so production behavior
 * is unchanged — these prove the gate exists and fails toward write.
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
const CTX = { userId: 'user-1', agentId: 'wren', threadKey: 'spec:some-design' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runLease(service: SessionService): Promise<Session> {
  // withStudioLease is private; this suite tests the gate at its boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).withStudioLease(SESSION, ROUTING, CTX);
}

describe('Phase 6b — acquisition gated on stored write intent', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue({ acquired: true, lease: {} });
    typeBehaviorMock.mockReset();
  });

  it('a presence-typed thread binds the studio WITHOUT acquiring', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'presence', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: 'spec' } });

    const result = await runLease(service);

    expect(result.studioId).toBe('studio-1'); // bound…
    expect(acquireMock).not.toHaveBeenCalled(); // …without the write lock
  });

  it('a write-typed thread acquires exactly as before', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'provision' });
    const { service } = serviceWith({ data: { key_type: 'pr' } });

    await runLease(service);
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it('an untyped thread (no key_type) FAILS TOWARD WRITE', async () => {
    typeBehaviorMock.mockResolvedValue({ writeIntent: 'write', studioPolicy: 'reuse-only' });
    const { service } = serviceWith({ data: { key_type: null } });

    await runLease(service);
    expect(typeBehaviorMock).toHaveBeenCalledWith('user-1', null);
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it('a thread-row lookup ERROR fails toward write', async () => {
    const { service } = serviceWith({ error: { message: 'db down' } });
    await runLease(service);
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it('a registry THROW fails toward write', async () => {
    typeBehaviorMock.mockRejectedValue(new Error('registry down'));
    const { service } = serviceWith({ data: { key_type: 'spec' } });
    await runLease(service);
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });
});
