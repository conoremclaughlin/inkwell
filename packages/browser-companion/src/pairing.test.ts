// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createPairingClient,
  pairingTransport,
  parsePairingRecord,
  type PairingRecord,
} from './pairing';
import { pairingApprovalPath, parsePairingOffer } from './protocol';

const origin = 'https://dashboard.example.test:8443';
const grant = {
  id: '00000000-0000-4000-8000-000000000001',
  secret: 'ink-bc-' + 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(initial?: PairingRecord) {
  let stored = initial;
  const writes: PairingRecord[] = [];
  const store = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (next: PairingRecord) => {
      stored = structuredClone(next);
      writes.push(structuredClone(next));
    }),
  };
  const transport = {
    claim: vi.fn(async (_record: PairingRecord, _code: string) => grant),
    revoke: vi.fn(async (_record: PairingRecord): Promise<void> => undefined),
  };
  const client = createPairingClient(store, transport);
  return {
    client,
    store,
    transport,
    writes,
    get stored() {
      return stored!;
    },
  };
}

describe('pairing state (synthetic storage and network only)', () => {
  it('refuses an invalid stored record rather than silently clearing its receipt', () => {
    expect(() => parsePairingRecord({ phase: 'paired' })).toThrow(
      'Stored pairing state is invalid'
    );
    expect(parsePairingRecord(undefined)).toBeUndefined();
  });
  it('does not return an approval link when Disconnect arrives during preparation persistence', async () => {
    const f = fixture();
    const writing = deferred<void>();
    f.store.write.mockImplementationOnce(() => writing.promise);
    const preparing = f.client.prepare(origin);
    const rejected = expect(preparing).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(f.store.write).toHaveBeenCalledOnce());
    const disconnect = f.client.disconnect();
    writing.resolve();
    await rejected;
    expect((await disconnect).revocation).toBe('confirmed');
  });
  it('generates a public commitment link, never discloses either secret in worker replies', async () => {
    const f = fixture();
    const ready = await f.client.prepare(origin);
    expect(f.stored.commitment).toBe(
      createHash('sha256').update(f.stored.installationSecret!).digest('hex')
    );
    expect(parsePairingOffer(new URL(ready.approvalUrl!).hash)).toEqual({
      installationId: f.stored.installationId,
      installationCommitment: f.stored.commitment,
    });
    expect(JSON.stringify(ready)).not.toContain(f.stored.installationSecret);
    const paired = await f.client.claim('ABCD-EFGH-JKLM');
    expect(paired.phase).toBe('paired');
    expect(f.stored.installationSecret).toBeUndefined();
    expect(JSON.stringify(paired)).not.toContain(grant.secret);
    expect(f.transport.claim).toHaveBeenCalledTimes(1);
  });
  it('reuses a pending approval and refuses origin changes until disconnected', async () => {
    const f = fixture();
    const first = await f.client.prepare(origin);
    expect(await f.client.prepare(origin)).toEqual(first);
    await expect(f.client.prepare('https://other.example.test')).rejects.toThrow(
      'existing pairing'
    );
    expect((await f.client.disconnect()).revocation).toBe('confirmed');
    expect(f.transport.revoke).not.toHaveBeenCalled();
    expect((await f.client.prepare('https://other.example.test')).origin).toBe(
      'https://other.example.test'
    );
  });
  it('fences preparation during a pending permission check', async () => {
    const f = fixture();
    const permission = deferred<boolean>();
    const preparing = f.client.prepare(origin, () => permission.promise);
    await f.client.disconnect();
    permission.resolve(true);
    await expect(preparing).rejects.toThrow('stopped');
    expect((await f.client.status()).phase).toBe('unpaired');
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it('disconnects before a slow claim returns, then revokes the late receipt without pairing', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    const claim = deferred<typeof grant>();
    const revoked = deferred<void>();
    f.transport.claim.mockReturnValue(claim.promise);
    f.transport.revoke.mockReturnValue(revoked.promise);
    const claiming = f.client.claim('ABCDEFGHJKLM');
    await vi.waitFor(() => expect(f.transport.claim).toHaveBeenCalledOnce());
    await expect(f.client.claim('ABCDEFGHJKLM')).rejects.toThrow('cannot be claimed again');
    expect((await f.client.disconnect()).phase).toBe('disconnected');
    expect(f.transport.revoke).not.toHaveBeenCalled();
    claim.resolve(grant);
    expect((await claiming).phase).toBe('disconnected');
    await vi.waitFor(() => expect(f.transport.revoke).toHaveBeenCalledOnce());
    expect(f.writes.some((r) => r.phase === 'paired')).toBe(false);
    revoked.resolve();
    await vi.waitFor(async () => expect((await f.client.status()).revocation).toBe('confirmed'));
    expect(f.stored.grant).toBeUndefined();
  });
  it('does not dispatch if Disconnect arrives during the pre-dispatch storage write', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    const writing = deferred<void>();
    f.store.write.mockImplementationOnce(() => writing.promise);
    const claim = f.client.claim('ABCDEFGHJKLM');
    await vi.waitFor(() => expect(f.store.write).toHaveBeenCalledTimes(2));
    const disconnect = f.client.disconnect();
    writing.resolve();
    await claim;
    expect((await disconnect).revocation).toBe('confirmed');
    expect(f.transport.claim).not.toHaveBeenCalled();
  });
  it('restores a suspended claim as unknown, never retries or invents revocation', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    const restored = fixture({ ...f.stored, phase: 'claiming', installationSecret: undefined });
    expect((await restored.client.status()).phase).toBe('unknown');
    await expect(restored.client.claim('ABCDEFGHJKLM')).rejects.toThrow('cannot be claimed again');
    expect((await restored.client.disconnect()).revocation).toBe('pending');
    expect((await restored.client.retryRevocation()).revocation).toBe('pending');
    expect(restored.transport.claim).not.toHaveBeenCalled();
    expect(restored.transport.revoke).not.toHaveBeenCalled();
  });
  it('retains only retry capability after a revocation outage, including worker restart', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    await f.client.claim('ABCDEFGHJKLM');
    f.transport.revoke.mockRejectedValue(new Error('synthetic outage'));
    await f.client.disconnect();
    await vi.waitFor(() => expect(f.transport.revoke).toHaveBeenCalledOnce());
    expect(f.stored.grant?.secret).toBe(grant.secret);
    const restored = fixture(f.stored);
    const view = await restored.client.status();
    expect(view.phase).toBe('disconnected');
    expect(JSON.stringify(view)).not.toContain(grant.secret);
    await expect(restored.client.prepare(origin)).rejects.toThrow('existing pairing');
    expect((await restored.client.retryRevocation()).revocation).toBe('confirmed');
    expect(restored.transport.revoke.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ grant })
    );
  });
  it('persists ambiguity on a claim outage and never leaks the exception text', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    f.transport.claim.mockRejectedValue(new Error('synthetic private response'));
    const result = await f.client.claim('ABCDEFGHJKLM');
    expect(result.phase).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('synthetic private');
    expect(f.stored.installationSecret).toBeUndefined();
    expect(f.transport.claim).toHaveBeenCalledOnce();
  });
  it('refuses dispatch if the in-flight marker cannot be saved', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    f.store.write.mockRejectedValue(new Error('synthetic storage error'));
    await expect(f.client.claim('ABCDEFGHJKLM')).rejects.toThrow('storage unavailable');
    expect(f.transport.claim).not.toHaveBeenCalled();
    await expect(f.client.claim('ABCDEFGHJKLM')).rejects.toThrow('storage unavailable');
  });
});

describe('fixed-path fetch transport (mocked, not native browser acceptance)', () => {
  it.each(['chrome-extension:', 'moz-extension:'])(
    'explicitly omits cookies in the %s adapter contract',
    async (protocol) => {
      // The adapter has no dependency on browser defaults or the extension scheme.
      const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
        expect(options).toMatchObject({
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          method: 'POST',
        });
        expect(options?.headers).toEqual({ 'Content-Type': 'application/json' });
        return new Response(
          JSON.stringify({
            grantId: grant.id,
            pairingSecret: grant.secret,
            expiresAt: grant.expiresAt,
            storage: 'session',
          })
        );
      });
      vi.stubGlobal('location', { protocol });
      try {
        const f = fixture();
        await f.client.prepare(origin);
        await pairingTransport(fetcher).claim(f.stored, 'ABCDEFGHJKLM');
        expect(fetcher.mock.calls[0]?.[0]).toBe(origin + '/api/browser-companion/auth/pair-claim');
        expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );
  it.each([500, 503])('treats HTTP %s as unknown, not invalidity', async (status) => {
    const f = fixture();
    await f.client.prepare(origin);
    const client = createPairingClient(
      f.store,
      pairingTransport(vi.fn(async () => new Response('{}', { status })))
    );
    expect((await client.claim('ABCDEFGHJKLM')).phase).toBe('unknown');
  });
  it('allows an explicit new code after a definite refusal, never an automatic retry', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = createPairingClient(f.store, pairingTransport(fetcher));
    await expect(client.claim('ABCDEFGHJKLM')).rejects.toThrow('Code refused');
    expect((await client.status()).phase).toBe('ready');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not call a malformed receipt a pairing or a mismatched revoke a confirmation', async () => {
    const f = fixture();
    await f.client.prepare(origin);
    const client = createPairingClient(
      f.store,
      pairingTransport(vi.fn(async () => new Response('{"storage":"local"}')))
    );
    expect((await client.claim('ABCDEFGHJKLM')).phase).toBe('unknown');
    const transport = pairingTransport(
      vi.fn(async () => new Response(JSON.stringify({ revoked: true, grantId: 'different' })))
    );
    await expect(transport.revoke({ ...f.stored, grant })).rejects.toThrow(
      'No confirmed revocation'
    );
  });
});

describe('public pairing offer parsing', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const path = pairingApprovalPath(id, 'f'.repeat(64));
  it('uses only a fragment for the public installation and commitment', () => {
    const url = new URL(path, origin);
    expect(url.search).toBe('');
    expect(parsePairingOffer(url.hash)).toEqual({
      installationId: id,
      installationCommitment: 'f'.repeat(64),
    });
  });
  it.each([
    '',
    '#installationId=bad',
    new URL(path, origin).hash + '&installationId=' + id,
    new URL(path, origin).hash + '&secret=synthetic',
  ])('refuses malformed, repeated, or extra fields: %s', (hash) => {
    expect(parsePairingOffer(hash)).toBeNull();
  });
});
