/**
 * Boundary tests for the routing-hold RPCs.
 *
 * These exist because the stamp call drifted out of sync with its RPC
 * signature and every refusal went unstamped in production while the suite
 * stayed green — nothing covered the call site (Lumen, PR #514 round 4).
 *
 * So these assert the EXACT function names and argument keys. That looks
 * brittle and is meant to: the whole failure was a silent mismatch between
 * this call and the migration, and a test that tolerates the shape cannot
 * catch it.
 */

import { describe, expect, it, vi } from 'vitest';
import { stampRoutingHold, clearRoutingHold } from './routing-hold';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function rpcClient(result: { data?: unknown; error?: { message: string } }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc }, rpc };
}

const STAMP = {
  threadId: 't-1',
  userId: 'u-1',
  agentId: 'wren',
  attemptStartedAt: '2026-08-19T02:00:00.000Z',
  detail: { triedCallerRepo: true, callerRepoRoot: '/repos/inkwell' },
  now: '2026-08-19T02:00:05.000Z',
};

describe('stampRoutingHold', () => {
  it('calls stamp_routing_hold with EVERY parameter the function declares', async () => {
    const { client, rpc } = rpcClient({ data: 1 });
    await expect(stampRoutingHold(client, STAMP)).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith('stamp_routing_hold', {
      p_thread_id: 't-1',
      p_user_id: 'u-1',
      p_agent_id: 'wren',
      p_attempt_started: '2026-08-19T02:00:00.000Z',
      p_hold: {
        agentId: 'wren',
        reason: 'no-route',
        // Generation, not just wall-clock: the clear compares this against
        // the successful route's start.
        attemptStartedAt: '2026-08-19T02:00:00.000Z',
        triedCallerRepo: true,
        callerRepoRoot: '/repos/inkwell',
        heldAt: '2026-08-19T02:00:05.000Z',
        recovery: 'route pattern, studioHint, or project affinity',
        occupied: null,
      },
    });
  });

  it('describes an OCCUPIED refusal as occupied, with its own recovery', async () => {
    // A hold that says "no-route" when a studio was in fact found and busy
    // sends the operator after the wrong fix: they go looking for a missing
    // route pattern instead of a lease holder or an overflow failure.
    const { client, rpc } = rpcClient({ data: 1 });
    await expect(
      stampRoutingHold(client, {
        ...STAMP,
        detail: {
          triedCallerRepo: false,
          reason: 'occupied',
          occupied: { studioId: 's-9', holderThreadKey: 'pr:600' },
        },
      })
    ).resolves.toBe(true);

    const hold = rpc.mock.calls[0][1].p_hold;
    expect(hold.reason).toBe('occupied');
    expect(hold.occupied).toEqual({ studioId: 's-9', holderThreadKey: 'pr:600' });
    expect(hold.recovery).toBe(
      'wait for the lease holder to finish, or fix the overflow provisioning failure'
    );
  });

  it('reports failure when the RPC returns an error rather than assuming success', async () => {
    const { client } = rpcClient({ error: { message: 'could not find function' } });
    await expect(stampRoutingHold(client, STAMP)).resolves.toBe(false);
  });

  it('reports false when the stamp was refused by generation (0 rows)', async () => {
    // A newer successful route already recovered the thread — not an error,
    // but not a stamp either.
    const { client } = rpcClient({ data: 0 });
    await expect(stampRoutingHold(client, STAMP)).resolves.toBe(false);
  });

  it('never throws — a stamp failure must not take down trigger handling', async () => {
    const client = {
      rpc: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(stampRoutingHold(client, STAMP)).resolves.toBe(false);
  });

  it('normalises a missing callerRepoRoot to null rather than undefined', async () => {
    const { client, rpc } = rpcClient({ data: 1 });
    await stampRoutingHold(client, { ...STAMP, detail: { triedCallerRepo: false } });
    expect(rpc.mock.calls[0][1].p_hold.callerRepoRoot).toBeNull();
  });
});

describe('clearRoutingHold', () => {
  it('calls clear_routing_hold with EVERY parameter the function declares', async () => {
    const { client, rpc } = rpcClient({ data: 1 });
    await expect(
      clearRoutingHold(client, {
        threadId: 't-1',
        userId: 'u-1',
        agentId: 'wren',
        routedSince: '2026-08-19T02:00:00.000Z',
      })
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith('clear_routing_hold', {
      p_thread_id: 't-1',
      p_user_id: 'u-1',
      p_agent_id: 'wren',
      p_routed_since: '2026-08-19T02:00:00.000Z',
    });
  });

  it('distinguishes "nothing to clear" from "the write failed"', async () => {
    const nothing = rpcClient({ data: 0 });
    await expect(
      clearRoutingHold(nothing.client, {
        threadId: 't-1',
        userId: 'u-1',
        agentId: 'wren',
        routedSince: 'x',
      })
    ).resolves.toBe(false);

    const failed = rpcClient({ error: { message: 'permission denied' } });
    await expect(
      clearRoutingHold(failed.client, {
        threadId: 't-1',
        userId: 'u-1',
        agentId: 'wren',
        routedSince: 'x',
      })
    ).resolves.toBe(false);
    // Both false, but only one logs an error — the log is the operator signal.
  });

  it('never throws', async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(
      clearRoutingHold(client, { threadId: 't', userId: 'u', agentId: 'a', routedSince: 'x' })
    ).resolves.toBe(false);
  });
});

/**
 * Cross-boundary regression (Lumen, PR #565 r1): the clear → refusal → stamp
 * sequence at ONE generation, driven through the real wrapper functions
 * against a fake that implements the RPCs' actual SQL semantics —
 * `clear_routing_hold` advances `routingRecovery[agent]` to
 * GREATEST(routedSince, existing) unconditionally, and `stamp_routing_hold`
 * refuses unless `recovery < attemptStarted` STRICTLY.
 *
 * Why it matters: v18 S3 defers provisioning to spawn admission, so a
 * dispatch can refuse AFTER its routing succeeded. If it had already cleared
 * the hold (recovery = its own routeStartedAt), its refusal stamp — same
 * generation — is refused by the strict guard: the previous hold is gone and
 * the promised one never lands. The trigger handler therefore clears at each
 * mode's TERMINAL only (routeOnly after assignment-complete, inline after the
 * delivery decision, spawn after admission succeeded).
 */
describe('the admission-refusal generation interaction (v18 S3)', () => {
  const T0 = '2026-09-01T10:00:00.000Z'; // an older dispatch's generation
  const T1 = '2026-09-01T11:00:00.000Z'; // this dispatch's routeStartedAt
  const T2 = '2026-09-01T12:00:00.000Z'; // a newer dispatch's generation

  function faithfulRpcFake() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata: Record<string, any> = {};
    const at = (iso: string) => new Date(iso).getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc = vi.fn(async (fn: string, args: any) => {
      if (fn === 'stamp_routing_hold') {
        const recovery = metadata.routingRecovery?.[args.p_agent_id];
        if (recovery !== undefined && !(at(recovery) < at(args.p_attempt_started))) {
          return { data: 0 };
        }
        metadata.routingHold = args.p_hold;
        return { data: 1 };
      }
      if (fn === 'clear_routing_hold') {
        const hold = metadata.routingHold;
        const holdGeneration = hold ? (hold.attemptStartedAt ?? hold.heldAt) : undefined;
        const didClear =
          Boolean(hold) &&
          hold.agentId === args.p_agent_id &&
          at(holdGeneration) <= at(args.p_routed_since);
        if (didClear) delete metadata.routingHold;
        const prev = metadata.routingRecovery?.[args.p_agent_id];
        metadata.routingRecovery = {
          ...(metadata.routingRecovery ?? {}),
          [args.p_agent_id]:
            prev !== undefined && at(prev) > at(args.p_routed_since) ? prev : args.p_routed_since,
        };
        return { data: didClear ? 1 : 0 };
      }
      throw new Error(`unknown rpc ${fn}`);
    });
    return { client: { rpc }, metadata };
  }

  const holdArgs = (attemptStartedAt: string) => ({
    threadId: 't-1',
    userId: 'u-1',
    agentId: 'wren',
    attemptStartedAt,
    detail: { triedCallerRepo: false, reason: 'occupied' as const },
  });

  it('clearing before admission suppresses the refusal stamp AND loses the old hold (the trap)', async () => {
    const { client, metadata } = faithfulRpcFake();
    // An older dispatch held the thread.
    await expect(stampRoutingHold(client, holdArgs(T0))).resolves.toBe(true);

    // The pre-r1 ordering: this dispatch clears after assignment, at its own
    // generation, THEN spawn admission refuses and stamps with that same
    // generation.
    await clearRoutingHold(client, {
      threadId: 't-1',
      userId: 'u-1',
      agentId: 'wren',
      routedSince: T1,
    });
    await expect(stampRoutingHold(client, holdArgs(T1))).resolves.toBe(false);

    // Net effect of the buggy ordering: no hold at all — the previous one was
    // removed and the refusal could not leave its own.
    expect(metadata.routingHold).toBeUndefined();
  });

  it('with the mode-terminal ordering the refusal replaces the old hold, and only real success clears', async () => {
    const { client, metadata } = faithfulRpcFake();
    await expect(stampRoutingHold(client, holdArgs(T0))).resolves.toBe(true);

    // This dispatch does NOT clear pre-admission; admission refuses → its
    // stamp lands (recovery untouched by this dispatch).
    await expect(stampRoutingHold(client, holdArgs(T1))).resolves.toBe(true);
    expect(metadata.routingHold?.attemptStartedAt).toBe(T1);

    // A later dispatch actually delivers → its terminal clear removes the
    // hold and records the recovery.
    await expect(
      clearRoutingHold(client, { threadId: 't-1', userId: 'u-1', agentId: 'wren', routedSince: T2 })
    ).resolves.toBe(true);
    expect(metadata.routingHold).toBeUndefined();
    expect(metadata.routingRecovery?.wren).toBe(T2);
  });

  it('the strict guard still blocks a STALE refusal behind a newer success — that is its real job', async () => {
    const { client, metadata } = faithfulRpcFake();
    // Newer dispatch (T2) succeeded and cleared at its terminal.
    await clearRoutingHold(client, {
      threadId: 't-1',
      userId: 'u-1',
      agentId: 'wren',
      routedSince: T2,
    });
    // An older, slower dispatch's refusal (generation T1 < T2) must not
    // resurrect a hold the newer success already disproved.
    await expect(stampRoutingHold(client, holdArgs(T1))).resolves.toBe(false);
    expect(metadata.routingHold).toBeUndefined();
  });
});
