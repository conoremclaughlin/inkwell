import { describe, expect, it, vi } from 'vitest';
import { grantStudioLease, studioPathConflict } from './lease-grant';
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
  agentId: 'wren',
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
