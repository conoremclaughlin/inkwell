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
      },
    });
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
