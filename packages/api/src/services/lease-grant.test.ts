import { beforeEach, describe, expect, it, vi } from 'vitest';
import { grantStudioLease, studioPathConflict } from './lease-grant';
import { logger } from '../utils/logger';
import type { StudioLease } from './studio-lease.service';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function rpcClient(result: { data?: unknown; error?: { message: string } }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc }, rpc };
}

const LEASE: StudioLease = {
  sessionId: 'sess-1',
  threadKey: 'pr:900',
  sbSlug: 'wren',
  acquiredAt: '2026-08-20T09:00:00.000Z',
  heartbeatAt: '2026-08-20T09:00:00.000Z',
};

describe('grantStudioLease', () => {
  it('calls grant_studio_lease with EVERY parameter the function declares', async () => {
    // Exact-shape on purpose: an RPC call site's failure mode is a silent
    // signature mismatch (PR #514 round 4 — every refusal went unstamped
    // behind a green suite).
    const { client, rpc } = rpcClient({ data: { outcome: 'granted' } });
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({ outcome: 'granted' });

    expect(rpc).toHaveBeenCalledWith('grant_studio_lease', {
      p_studio_id: 's-1',
      p_user_id: 'u-1',
      p_lease: LEASE,
      p_expected_prior: null,
    });
  });

  it('passes the exact prior lease for handover grants', async () => {
    const prior: StudioLease = { ...LEASE, sessionId: 'claim-token' };
    const { client, rpc } = rpcClient({ data: { outcome: 'granted' } });
    await grantStudioLease(client, {
      studioId: 's-1',
      userId: 'u-1',
      lease: LEASE,
      expectedPrior: prior,
    });
    expect(rpc).toHaveBeenCalledWith('grant_studio_lease', {
      p_studio_id: 's-1',
      p_user_id: 'u-1',
      p_lease: LEASE,
      p_expected_prior: prior,
    });
  });

  it('maps path-conflict with the sibling holder attached', async () => {
    const holder = { ...LEASE, threadKey: 'pr:OTHER' };
    const { client } = rpcClient({
      data: { outcome: 'path-conflict', conflictStudioId: 's-2', conflictHolder: holder },
    });
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({
      outcome: 'path-conflict',
      conflictStudioId: 's-2',
      conflictHolder: holder,
    });
  });

  it('FAILS CLOSED: an RPC error is lost, never granted', async () => {
    const { client } = rpcClient({ error: { message: 'could not find function' } });
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({ outcome: 'lost' });
  });

  it('FAILS CLOSED: an unexpected payload is lost, never granted', async () => {
    const { client } = rpcClient({ data: { something: 'else' } });
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({ outcome: 'lost' });
  });

  it('FAILS CLOSED: a thrown RPC is lost, never granted', async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error('network')) };
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({ outcome: 'lost' });
  });
});

/**
 * The three tests above pin that every refusal RETURNS `lost`. They do not ask
 * whether a reader can tell afterwards WHICH refusal it was, and until #662 the
 * answer was no: two sinks logged and the third returned silently.
 *
 * That third sink is the one the DB actually uses. grant_studio_lease returns
 * exactly granted | path-conflict | lost (migration 20260820191613), so a
 * deliberate refusal — a vacant CAS finding `lease IS NOT NULL` — arrives as
 * `{outcome:'lost'}`, matches neither branch, and falls through. On #662's
 * post-merge run that surfaced as `0 granted / 1 conflict` in a concurrency
 * assertion with nothing anywhere naming the cause, and cost three agents
 * ninety minutes. studioPathConflict had logged its analogous branch all along.
 */
describe('grantStudioLease — a refusal records which refusal it was', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  /**
   * winston's LeveledLogMethod resolves to a one-argument overload under
   * vi.mocked, so the (message, meta) pair the whole logger is called with is
   * not indexable without this cast. One cast, here, rather than per assertion.
   */
  function warnCalls(): Array<[string, Record<string, unknown> | undefined]> {
    return vi.mocked(logger.warn).mock.calls as unknown as Array<
      [string, Record<string, unknown> | undefined]
    >;
  }

  /** (message, rpcOutcome) per warn call, in order — the reader's whole view. */
  function warnSignatures(): Array<{ message: unknown; rpcOutcome: unknown }> {
    return warnCalls().map(([message, meta]) => ({ message, rpcOutcome: meta?.rpcOutcome }));
  }

  it("records the RPC's OWN lost verdict, carrying the outcome it returned", async () => {
    const { client } = rpcClient({ data: { outcome: 'lost' } });
    await expect(
      grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
    ).resolves.toEqual({ outcome: 'lost' });

    expect(warnSignatures()).toHaveLength(1);
    expect(warnCalls()[0][1]).toMatchObject({
      studioId: 's-1',
      rpcOutcome: 'lost',
    });
  });

  it('distinguishes an unparseable payload from the DB deciding lost', async () => {
    // Same return value, different cause: one is the database refusing, the
    // other is this boundary failing to understand the answer. A single
    // undifferentiated `lost` sent the #662 investigation at the wire when the
    // refusal was a stale lease.
    for (const data of [{ something: 'else' }, null, 'garbage']) {
      vi.mocked(logger.warn).mockClear();
      const { client } = rpcClient({ data });
      await grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE });
      expect(warnSignatures()).toEqual([
        { message: expect.stringContaining('[LeaseGrant]'), rpcOutcome: null },
      ]);
    }
  });

  it('leaves all three lost causes separable from the log alone', async () => {
    // The contract, not the wording: a reader holding only the log can tell a
    // DB refusal from a wire error from a throw. Three causes, three distinct
    // signatures — which is exactly what "no [LeaseGrant] warning in the job"
    // was able to rule out once the third one existed.
    const cases: Array<[string, { data?: unknown; error?: { message: string } } | 'throw']> = [
      ['db refused', { data: { outcome: 'lost' } }],
      [
        'wire error',
        { error: { message: 'An invalid response was received from the upstream server' } },
      ],
      ['threw', 'throw'],
    ];

    const seen: string[] = [];
    for (const [, result] of cases) {
      vi.mocked(logger.warn).mockClear();
      const client =
        result === 'throw'
          ? { rpc: vi.fn().mockRejectedValue(new Error('socket hang up')) }
          : rpcClient(result).client;
      await expect(
        grantStudioLease(client, { studioId: 's-1', userId: 'u-1', lease: LEASE })
      ).resolves.toEqual({ outcome: 'lost' });

      const sigs = warnSignatures();
      expect(sigs).toHaveLength(1);
      seen.push(JSON.stringify(sigs[0]));
    }

    expect(new Set(seen).size).toBe(3);
  });
});

describe('studioPathConflict', () => {
  it('calls studio_path_conflict with the exact argument keys', async () => {
    const { client, rpc } = rpcClient({ data: { conflict: false } });
    await expect(studioPathConflict(client, { studioId: 's-1', userId: 'u-1' })).resolves.toEqual({
      conflict: false,
    });
    expect(rpc).toHaveBeenCalledWith('studio_path_conflict', {
      p_studio_id: 's-1',
      p_user_id: 'u-1',
    });
  });

  it('maps a conflict with the sibling holder attached', async () => {
    const holder = { ...LEASE, threadKey: 'pr:OTHER' };
    const { client } = rpcClient({
      data: { conflict: true, conflictStudioId: 's-2', conflictHolder: holder },
    });
    await expect(studioPathConflict(client, { studioId: 's-1', userId: 'u-1' })).resolves.toEqual({
      conflict: true,
      conflictStudioId: 's-2',
      conflictHolder: holder,
    });
  });

  it('FAILS CLOSED: null, missing, or non-boolean payloads report conflict (r3 P0-4)', async () => {
    // Only an EXPLICIT conflict:false is a clear tree. "Could not verify"
    // must never authorize a rescue.
    for (const data of [null, {}, { conflict: 'nope' }, { conflict: 0 }, 'garbage']) {
      const { client } = rpcClient({ data });
      await expect(
        studioPathConflict(client, { studioId: 's-1', userId: 'u-1' })
      ).resolves.toMatchObject({ conflict: true });
    }
  });

  it('FAILS CLOSED: an error or throw reports conflict — never a clear tree', async () => {
    // "Could not verify the tree is ours to rescue" must never authorize a
    // rescue that could stomp a live sibling writer.
    const { client } = rpcClient({ error: { message: 'db down' } });
    await expect(
      studioPathConflict(client, { studioId: 's-1', userId: 'u-1' })
    ).resolves.toMatchObject({ conflict: true });
    const throwing = { rpc: vi.fn().mockRejectedValue(new Error('network')) };
    await expect(
      studioPathConflict(throwing, { studioId: 's-1', userId: 'u-1' })
    ).resolves.toMatchObject({ conflict: true });
  });
});
