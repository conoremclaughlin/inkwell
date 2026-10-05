import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ADMISSION_PROTOCOL } from './command-admission';
import {
  admitLeasedTurn,
  admitTurn,
  mintTenureCapability,
  reconcileTenure,
  recordInvocation,
  registerTenure,
  releaseTenure,
  tenureCapabilityHash,
  TenureAdmissionError,
  type LegacySessionState,
  type TenureHolder,
} from './tenure-admission';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TENURE = '22222222-2222-4222-8222-222222222222';
const COMMAND = '33333333-3333-4333-8333-333333333333';

function clientReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const holder: TenureHolder = {
  tenureId: TENURE,
  capability: 'holder-secret-fixture',
  hostInstanceId: 'host-fixture',
};

describe('tenure capability', () => {
  it('mints a fresh secret each time, with the hash the database stores', () => {
    const a = mintTenureCapability();
    const b = mintTenureCapability();
    expect(a.capability).not.toBe(b.capability);
    expect(a.capability.length).toBeGreaterThanOrEqual(43);
    expect(a.capabilityHash).toBe(tenureCapabilityHash(a.capability));
    expect(a.capabilityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // The database hashes the secret itself, so the digest it stores is not a
  // credential: presenting it proves nothing.
  it('sends the holder secret for the database to hash, never the stored digest', async () => {
    const { client, rpc } = clientReturning({ outcome: 'not_holder' });
    await admitTurn(client, {
      sessionId: SESSION,
      holder,
      expectedPriorEpoch: null,
      epoch: 'epoch-1',
      commandUuid: COMMAND,
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_capability).toBe(holder.capability);
    expect(args).not.toHaveProperty('p_capability_hash');
    expect(JSON.stringify(args)).not.toContain(tenureCapabilityHash(holder.capability));
  });
});

describe('admission RPC failures', () => {
  const call = (client: SupabaseClient) =>
    admitTurn(client, {
      sessionId: SESSION,
      holder,
      expectedPriorEpoch: null,
      epoch: 'epoch-1',
      commandUuid: COMMAND,
    });
  // Everything a transport might say, each echoing the secret.
  const echo = `invalid input near "${holder.capability}"`;

  it('reports an error reply by its class alone, with nothing of the transport', async () => {
    const error = { message: echo, details: echo, hint: echo, code: echo };
    const rejection = await call(clientReturning(null, error).client).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(TenureAdmissionError);
    expect(rejection).toMatchObject({ rpc: 'admit_turn', kind: 'transport_failed' });
    expect((rejection as Error).message).toBe('admit_turn failed');
    expect(JSON.stringify(rejection)).not.toContain(holder.capability);
    expect(String((rejection as Error).stack)).not.toContain(holder.capability);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('reports a rejected call the same way', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error(echo));
    const rejection = await call({ rpc } as unknown as SupabaseClient).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(TenureAdmissionError);
    expect(rejection).toMatchObject({ rpc: 'admit_turn', kind: 'transport_failed' });
    expect((rejection as Error).message).toBe('admit_turn failed');
    expect(String((rejection as Error).stack)).not.toContain(holder.capability);
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('reports a reply outside the contract without quoting it', async () => {
    const rejection = await call(clientReturning({ outcome: echo }).client).catch(
      (e: unknown) => e
    );
    expect(rejection).toMatchObject({ rpc: 'admit_turn', kind: 'reply_outside_contract' });
    expect((rejection as Error).message).not.toContain(holder.capability);
  });
});

describe('registerTenure', () => {
  it('passes the exact expected prior, the host and the protocol', async () => {
    const { client, rpc } = clientReturning({ outcome: 'registered', tenureId: TENURE });
    const { capability } = mintTenureCapability();
    const result = await registerTenure(client, {
      sessionId: SESSION,
      expected: { kind: 'released', tenureId: TENURE },
      mode: 'interactive_wrapper',
      capability,
      host: { instanceId: 'host-fixture', bootId: 'boot-fixture' },
    });
    expect(result).toEqual({ outcome: 'registered', tenureId: TENURE });
    expect(rpc).toHaveBeenCalledWith('register_tenure', {
      p_session_id: SESSION,
      p_expected: { kind: 'released', tenureId: TENURE },
      p_mode: 'interactive_wrapper',
      p_capability: capability,
      p_host: { instanceId: 'host-fixture', bootId: 'boot-fixture' },
      p_owner: null,
      p_endpoint: null,
      p_protocol: ADMISSION_PROTOCOL,
    });
  });

  it('throws on a reply outside the contract', async () => {
    for (const reply of [
      null,
      { outcome: 'registered' },
      { outcome: 'free' },
      { outcome: 'occupied', tenureId: TENURE, state: 'settled' },
    ]) {
      const { client } = clientReturning(reply);
      await expect(
        registerTenure(client, {
          sessionId: SESSION,
          expected: { kind: 'never_owned' },
          mode: 'server_hosted',
          capability: mintTenureCapability().capability,
          host: { instanceId: 'host-fixture' },
        })
      ).rejects.toThrow(/outside its contract/);
    }
  });
});

describe('recordInvocation', () => {
  it('sends the record kind apart from its detail', async () => {
    const { client, rpc } = clientReturning({ outcome: 'recorded', kind: 'process_binding' });
    await recordInvocation(client, {
      sessionId: SESSION,
      holder,
      epoch: 'epoch-1',
      invocationId: 'inv-1',
      record: { kind: 'process_binding', pid: 4242, startIdentity: 'start-fixture' },
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_kind).toBe('process_binding');
    expect(args.p_detail).toEqual({ pid: 4242, startIdentity: 'start-fixture' });
  });
});

describe('releaseTenure', () => {
  it('reads an unresolved refusal and throws on an unknown one', async () => {
    const ok = clientReturning({ outcome: 'unresolved', invocations: 2 });
    expect(
      await releaseTenure(ok.client, { sessionId: SESSION, holder, evidence: 'controller_retired' })
    ).toEqual({ outcome: 'unresolved', invocations: 2 });
    const bad = clientReturning({ outcome: 'released' });
    await expect(
      releaseTenure(bad.client, { sessionId: SESSION, holder, evidence: 'controller_retired' })
    ).rejects.toThrow(/outside its contract/);
  });
});

describe('reconcileTenure', () => {
  const legacy: LegacySessionState = {
    turnEpoch: 'epoch-legacy',
    backendSessionId: 'native-session-fixture',
    lifecycle: 'running',
    cliTurnAt: null,
    cliTurnStoppedAt: null,
    updatedAt: '2026-10-04T12:00:00.123456+00:00',
  };

  it('sends a legacy attestation with the exact state it was bound to', async () => {
    const { client, rpc } = clientReturning({ outcome: 'reconciled', tenureId: TENURE });
    await reconcileTenure(client, {
      sessionId: SESSION,
      expectedTenureId: null,
      evidence: 'legacy_quiescence_attested',
      currentHostId: 'machine-fixture',
      evidenceRef: 'attestation-fixture',
      expectedLegacy: legacy,
      authority: 'reconciler-fixture',
      hostInstanceId: 'host-fixture',
    });
    expect(rpc).toHaveBeenCalledWith('reconcile_tenure', {
      p_session_id: SESSION,
      p_expected_tenure_id: null,
      p_evidence: 'legacy_quiescence_attested',
      p_current_boot_id: null,
      p_current_host_id: 'machine-fixture',
      p_evidence_ref: 'attestation-fixture',
      p_expected_legacy: legacy,
      p_authority: 'reconciler-fixture',
      p_host_instance_id: 'host-fixture',
      p_protocol: ADMISSION_PROTOCOL,
    });
  });

  it('reads the current legacy state from a stale attestation, and fails closed on a changed shape', async () => {
    const changed = { ...legacy, updatedAt: '2026-10-04T12:00:01+00:00' };
    const input = {
      sessionId: SESSION,
      expectedTenureId: null,
      evidence: 'legacy_quiescence_attested' as const,
      currentHostId: 'machine-fixture',
      evidenceRef: 'attestation-fixture',
      expectedLegacy: legacy,
      authority: 'reconciler-fixture',
      hostInstanceId: 'host-fixture',
    };
    const stale = { outcome: 'stale_expectation', tenureId: null, legacy: changed };
    expect(await reconcileTenure(clientReturning(stale).client, input)).toEqual(stale);
    for (const reply of [
      { ...stale, legacy: { ...changed, extra: 'field' } },
      { ...stale, legacy: { ...changed, updatedAt: undefined } },
    ]) {
      await expect(reconcileTenure(clientReturning(reply).client, input)).rejects.toThrow();
    }
  });
});

describe('admitLeasedTurn', () => {
  const input = {
    sessionId: SESSION,
    holder,
    expectedPriorEpoch: null,
    epoch: 'epoch-1',
    commandUuid: COMMAND,
    studioId: TENURE,
  };

  it('sends the named studio with the admission and the holder secret', async () => {
    const { client, rpc } = clientReturning({
      outcome: 'admitted',
      epoch: 'epoch-1',
      restamped: 2,
    });
    expect(await admitLeasedTurn(client, input)).toEqual({
      outcome: 'admitted',
      epoch: 'epoch-1',
      restamped: 2,
    });
    expect(rpc).toHaveBeenCalledWith('admit_leased_turn', {
      p_session_id: SESSION,
      p_tenure_id: TENURE,
      p_capability: holder.capability,
      p_host_instance_id: 'host-fixture',
      p_expected_prior_epoch: null,
      p_epoch: 'epoch-1',
      p_command_uuid: COMMAND,
      p_studio_id: TENURE,
      p_protocol: ADMISSION_PROTOCOL,
    });
  });

  it('reads lease refusals, and fails closed on an admission without its restamp count', async () => {
    for (const reply of [{ outcome: 'lease_lost' }, { outcome: 'forbidden' }]) {
      expect(await admitLeasedTurn(clientReturning(reply).client, input)).toEqual(reply);
    }
    for (const reply of [
      { outcome: 'admitted', epoch: 'epoch-1' },
      { outcome: 'admitted', epoch: 'epoch-1', restamped: -1 },
      { outcome: 'admitted', epoch: 'epoch-1', restamped: 0 },
      { outcome: 'leased' },
    ]) {
      await expect(admitLeasedTurn(clientReturning(reply).client, input)).rejects.toThrow();
    }
  });
});
