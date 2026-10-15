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
  let tail: Promise<unknown> = Promise.resolve();
  let revoking: Promise<void> | undefined;
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
        }
      : { phase: 'unpaired' };
  async function save(next: PairingRecord) {
    record = next;
    try {
      await store.write(next);
    } catch {
      failed = true;
      throw new Error('Session storage unavailable. Pairing actions are stopped.');
    }
  }
  function transition<T>(fn: () => Promise<T> | T): Promise<T> {
    const work = tail.then(async () => {
      if (failed) throw new Error('Session storage unavailable. Pairing actions are stopped.');
      if (!loaded) {
        record = await store.read();
        // A worker restart cannot recover the one-time secret from a lost receipt.
        if (record?.phase === 'claiming') await save({ ...record, phase: 'unknown' });
        loaded = true;
      }
      return fn();
    });
    tail = work.catch(() => undefined);
    return work;
  }
  async function revoke() {
    const pending = await transition(() =>
      record?.phase === 'disconnected' && record.grant && record.revocation === 'pending'
        ? record
        : undefined
    );
    if (!pending) return;
    if (revoking) return revoking;
    revoking = (async () => {
      try {
        await transport.revoke(pending);
        await transition(async () => {
          if (record?.installationId === pending.installationId && record.phase === 'disconnected')
            await save({ ...record, grant: undefined, revocation: 'confirmed' });
        });
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
    status: () => transition(view),
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
        if (record && !(record.phase === 'disconnected' && record.revocation === 'confirmed'))
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
        return { intent, response: transport.claim(intent, code) };
      });
      if (!pending) return transition(view);
      try {
        const grant = await pending.response;
        await transition(async () => {
          if (record?.installationId !== pending.intent.installationId)
            throw new Error('Pairing changed.');
          await save({
            ...record,
            grant,
            phase: generation === stopped ? 'paired' : 'disconnected',
            revocation: generation === stopped ? 'none' : 'pending',
          });
        });
        if (generation !== stopped) void revoke().catch(() => undefined);
      } catch (error) {
        await transition(async () => {
          if (record?.installationId !== pending.intent.installationId) return;
          if (record.phase === 'disconnected') {
            if (error instanceof RefusedCode) await save({ ...record, revocation: 'confirmed' });
          } else if (error instanceof RefusedCode) {
            await save(pending.intent);
          } else {
            await save({ ...record, phase: 'unknown' });
          }
        });
        if (error instanceof RefusedCode)
          throw new Error(
            'Code refused or expired. Check the code; nothing will retry automatically.'
          );
      }
      return transition(view);
    },
    async disconnect() {
      ++stopped; // Fence in-flight work immediately, before storage or any network wait.
      await transition(async () => {
        if (!record || record.phase === 'disconnected') return;
        const noDispatch = record.phase === 'ready';
        await save({
          ...record,
          phase: 'disconnected',
          installationSecret: undefined,
          revocation: noDispatch ? 'confirmed' : 'pending',
        });
      });
      void revoke().catch(() => undefined);
      return transition(view);
    },
    async retryRevocation() {
      await revoke();
      return transition(view);
    },
  };
}
