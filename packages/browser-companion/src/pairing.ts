import { dashboardOrigin, pairingApprovalPath } from './protocol';

type Phase = 'ready' | 'claiming' | 'unknown' | 'paired' | 'disconnected';
interface Grant {
  id: string;
  secret: string;
  expiresAt: string;
}
/** Worker credential record in trusted-context session storage. The platform
 * trusts other extension pages too; our message API never returns this record. */
export interface PairingRecord {
  origin: string;
  installationId: string;
  commitment: string;
  installationSecret?: string;
  phase: Phase;
  grant?: Grant;
  revocation: 'none' | 'pending' | 'confirmed';
}
export interface PairingView {
  phase: Phase | 'unpaired';
  origin?: string;
  installationId?: string;
  approvalUrl?: string;
  expiresAt?: string;
  revocation?: PairingRecord['revocation'];
  storageUnavailable?: true;
  cleanup?: 'awaiting-receipt' | 'missing-receipt' | 'revocation';
}
export interface PairingStore {
  read(): Promise<PairingRecord | undefined>;
  write(record: PairingRecord): Promise<void>;
}

class RefusedCode extends Error {}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);

export function parsePairingRecord(input: unknown): PairingRecord | undefined {
  if (input === undefined) return undefined;
  const value = object(input);
  const grant = object(value.grant);
  if (
    typeof value.origin !== 'string' ||
    dashboardOrigin(value.origin) !== value.origin ||
    !uuid(value.installationId) ||
    typeof value.commitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.commitment) ||
    !['ready', 'claiming', 'unknown', 'paired', 'disconnected'].includes(String(value.phase)) ||
    !['none', 'pending', 'confirmed'].includes(String(value.revocation)) ||
    (value.phase === 'ready' &&
      (typeof value.installationSecret !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.installationSecret))) ||
    (value.phase === 'paired' && !value.grant) ||
    (value.grant !== undefined &&
      (!uuid(grant.id) ||
        typeof grant.secret !== 'string' ||
        !/^ink-bc-[0-9a-f]{64}$/.test(grant.secret) ||
        typeof grant.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(grant.expiresAt))))
  )
    throw new Error('Stored pairing state is invalid. No pairing action was taken.');
  return {
    origin: value.origin,
    installationId: value.installationId,
    commitment: value.commitment,
    phase: value.phase as Phase,
    revocation: value.revocation as PairingRecord['revocation'],
    ...(value.phase === 'ready' ? { installationSecret: value.installationSecret as string } : {}),
    ...(value.grant !== undefined
      ? {
          grant: {
            id: grant.id as string,
            secret: grant.secret as string,
            expiresAt: grant.expiresAt as string,
          },
        }
      : {}),
  };
}

/** No arbitrary URL, method, headers, cookies, redirects, or dashboard token. */
export function pairingTransport(fetcher: typeof fetch = fetch) {
  async function post(origin: string, path: '/auth/pair-claim' | '/auth/revoke', body: unknown) {
    const response = await fetcher(`${dashboardOrigin(origin)}/api/browser-companion${path}`, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (path === '/auth/pair-claim' && response.status === 401) throw new RefusedCode();
    if (!response.ok) throw new Error('No confirmed browser receipt.');
    const text = await response.text();
    if (text.length > 8192) throw new Error('Invalid browser receipt.');
    return object(JSON.parse(text));
  }
  return {
    async claim(record: PairingRecord, pairingCode: string): Promise<Grant> {
      const result = await post(record.origin, '/auth/pair-claim', {
        pairingCode,
        installationId: record.installationId,
        installationSecret: record.installationSecret,
      });
      if (
        !uuid(result.grantId) ||
        typeof result.pairingSecret !== 'string' ||
        !/^ink-bc-[0-9a-f]{64}$/.test(result.pairingSecret) ||
        result.storage !== 'session' ||
        typeof result.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(result.expiresAt))
      )
        throw new Error('Invalid browser receipt.');
      return { id: result.grantId, secret: result.pairingSecret, expiresAt: result.expiresAt };
    },
    async revoke(record: PairingRecord): Promise<void> {
      if (!record.grant) throw new Error('No revocation credential.');
      const result = await post(record.origin, '/auth/revoke', {
        installationId: record.installationId,
        pairingSecret: record.grant.secret,
      });
      if (result.revoked !== true || result.grantId !== record.grant.id)
        throw new Error('No confirmed revocation receipt.');
    },
  };
}

/** Storage transitions are ordered; network waits are not in that queue. */
export function createPairingClient(store: PairingStore, transport = pairingTransport()) {
  let record: PairingRecord | undefined;
  let loaded = false;
  let stopped = 0;
  let failed = false;
  // A suspended worker cannot receive its old request's result. In this worker,
  // however, Disconnect must not let replacement discard a still-returning grant.
  let claimInFlight = false;
  let tail: Promise<unknown> = Promise.resolve();
  let revoking: Promise<void> | undefined;
  const cleanup = (): PairingView['cleanup'] =>
    record?.phase === 'disconnected' && record.revocation === 'pending'
      ? record.grant
        ? 'revocation'
        : claimInFlight
          ? 'awaiting-receipt'
          : 'missing-receipt'
      : undefined;
  const view = (): PairingView =>
    record
      ? {
          phase: record.phase,
          origin: record.origin,
          installationId: record.installationId,
          ...(record.phase === 'ready'
            ? {
                approvalUrl:
                  record.origin + pairingApprovalPath(record.installationId, record.commitment),
              }
            : {}),
          expiresAt: record.grant?.expiresAt,
          revocation: record.revocation,
          ...(cleanup() ? { cleanup: cleanup() } : {}),
          ...(failed ? { storageUnavailable: true as const } : {}),
        }
      : { phase: 'unpaired' };
  async function save(next: PairingRecord) {
    record = next;
    try {
      await store.write(next);
    } catch {
      failed = true;
      // Keep a known grant for cleanup, never for use. A failed local write
      // cannot undo a server receipt or prevent revoking one that arrives late.
      record = {
        ...next,
        phase: 'disconnected',
        installationSecret: undefined,
        revocation:
          next.revocation === 'confirmed' || next.phase === 'ready' ? 'confirmed' : 'pending',
      };
      throw new Error('Session storage unavailable. Pairing actions are stopped.');
    }
  }
  async function saveCleanup(next: PairingRecord) {
    // The memory fence and warning survive a rejected write. Cleanup does not
    // need persistence permission; opening or claiming a pairing still does.
    await save(next).catch(() => undefined);
  }
  function transition<T>(fn: () => Promise<T> | T, cleanup = false): Promise<T> {
    const work = tail.then(async () => {
      if (failed && !cleanup)
        throw new Error('Session storage unavailable. Pairing actions are stopped.');
      if (!loaded) {
        record = await store.read();
        loaded = true;
        // A worker restart cannot recover the one-time secret from a lost receipt.
        if (record?.phase === 'claiming') {
          const next = { ...record, phase: 'unknown' as const };
          if (cleanup) await saveCleanup(next);
          else await save(next);
        }
      }
      return fn();
    });
    tail = work.catch(() => undefined);
    return work;
  }
  async function revoke() {
    const pending = await transition(
      () =>
        record?.phase === 'disconnected' && record.grant && record.revocation === 'pending'
          ? record
          : undefined,
      true
    );
    if (!pending) return;
    if (revoking) return revoking;
    revoking = (async () => {
      try {
        await transport.revoke(pending);
        await transition(async () => {
          if (record?.installationId === pending.installationId && record.phase === 'disconnected')
            await saveCleanup({ ...record, grant: undefined, revocation: 'confirmed' });
        }, true);
      } catch {
        // Retain the secret solely for an explicit idempotent revocation retry.
        // An outage, invalid credential, or malformed response is not a receipt.
      }
    })().finally(() => {
      revoking = undefined;
    });
    return revoking;
  }
  return {
    status: () => transition(view, true),
    // Worker-only access. Never put this record in a panel response.
    connectionRecord: () =>
      transition(() => {
        if (failed || record?.phase !== 'paired' || record.revocation !== 'none')
          throw new Error('Pair this browser before connecting.');
        return parsePairingRecord(record)!;
      }),
    async prepare(input: string, permitted: () => Promise<boolean> = async () => true) {
      const origin = dashboardOrigin(input);
      const generation = stopped;
      if (!(await permitted())) throw new Error('Grant access to this dashboard first.');
      const installationId = crypto.randomUUID();
      const installationSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');
      const commitment = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installationSecret))
        ),
        (b) => b.toString(16).padStart(2, '0')
      ).join('');
      return transition(async () => {
        if (generation !== stopped) throw new Error('Pairing stopped.');
        if (record?.phase === 'ready' && record.origin === origin) return view();
        if (
          record &&
          !(
            record.phase === 'disconnected' &&
            (record.revocation === 'confirmed' || cleanup() === 'missing-receipt')
          )
        )
          throw new Error('Finish or disconnect the existing pairing first.');
        await save({
          origin,
          installationId,
          installationSecret,
          commitment,
          phase: 'ready',
          revocation: 'none',
        });
        if (generation !== stopped) throw new Error('Pairing stopped.');
        return view();
      });
    },
    async claim(input: string) {
      const code = input.toUpperCase().replace(/[\s-]/g, '');
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(code))
        throw new Error('Enter the 12-character pairing code from Inkwell.');
      const generation = stopped;
      const pending = await transition(async () => {
        if (generation !== stopped || record?.phase !== 'ready' || !record.installationSecret)
          throw new Error('This pairing cannot be claimed again. Check its status.');
        const intent = record;
        await save({ ...record, phase: 'claiming', installationSecret: undefined });
        if (generation !== stopped) {
          await save(intent); // No dispatch occurred; the queued disconnect can confirm that.
          return undefined;
        }
        const response = transport.claim(intent, code);
        claimInFlight = true;
        return { intent, response };
      });
      if (!pending) return transition(view, true);
      try {
        const grant = await pending.response;
        await transition(async () => {
          if (record?.installationId !== pending.intent.installationId)
            throw new Error('Pairing changed.');
          const disconnected = failed || generation !== stopped;
          await saveCleanup({
            ...record,
            grant,
            phase: disconnected ? 'disconnected' : 'paired',
            revocation: disconnected ? 'pending' : 'none',
          });
          claimInFlight = false;
        }, true);
      } catch (error) {
        await transition(async () => {
          if (record?.installationId !== pending.intent.installationId) return;
          if (record.phase === 'disconnected') {
            if (error instanceof RefusedCode)
              await saveCleanup({ ...record, revocation: 'confirmed' });
          } else if (error instanceof RefusedCode) {
            await saveCleanup(pending.intent);
          } else {
            await saveCleanup({ ...record, phase: 'unknown' });
          }
          claimInFlight = false;
        }, true);
        if (error instanceof RefusedCode)
          throw new Error(
            'Code refused or expired. Check the code; nothing will retry automatically.'
          );
      }
      void revoke().catch(() => undefined);
      return transition(view, true);
    },
    async disconnect() {
      ++stopped; // Fence in-flight work immediately, before storage or any network wait.
      await transition(async () => {
        if (!record || record.phase === 'disconnected') return;
        const noDispatch = record.phase === 'ready';
        await saveCleanup({
          ...record,
          phase: 'disconnected',
          installationSecret: undefined,
          revocation: noDispatch ? 'confirmed' : 'pending',
        });
      }, true);
      void revoke().catch(() => undefined);
      return transition(view, true);
    },
    async retryRevocation() {
      await revoke();
      return transition(view, true);
    },
  };
}
