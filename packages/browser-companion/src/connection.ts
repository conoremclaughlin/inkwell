import { parsePairingRecord, type PairingRecord } from './pairing';

/** Installation identity only. Neither a thread grant nor permission to read a page. */
export interface ConnectionView {
  origin: string;
  grantId: string;
  installationId: string;
  workspaceId: string;
  userId: string;
  grantExpiresAt: string;
  pageAuthority: 'none';
}

export class ConnectionError extends Error {
  constructor(
    readonly code: 'closed' | 'expired' | 'refused' | 'unavailable' | 'invalid-response'
  ) {
    super(`Browser connection ${code}.`);
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
const invalid = () => new ConnectionError('invalid-response');

/** Read a bounded body, not an unbounded response.text() followed by a size check. */
async function readJson(response: Response, signal: AbortSignal) {
  if (!response.headers.get('content-type')?.match(/^application\/json(?:\s*;|$)/i))
    throw invalid();
  if (Number(response.headers.get('content-length')) > 8192 || !response.body) throw invalid();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) throw invalid();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch (error) {
    cancel();
    if (signal.aborted) throw signal.reason;
    throw error instanceof ConnectionError ? error : invalid();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Inert until refresh() is explicitly called by an admitted panel connection.
 * The owner supplies that panel document's in-memory intent signal and aborts
 * it synchronously on Disconnect/close. Stored pairing is NOT connection intent.
 * This module does not authenticate panel senders or settle multiple-panel intent;
 * those are required at the worker boundary before production registration.
 * No storage, timers that mint, arbitrary authenticated fetch, or bearer replies.
 */
export function createBrowserConnection(
  input: PairingRecord,
  intent: AbortSignal,
  { fetcher = fetch, now = Date.now }: { fetcher?: typeof fetch; now?: () => number } = {}
) {
  let record: PairingRecord | undefined;
  try {
    record = parsePairingRecord(input);
  } catch {
    throw new ConnectionError('refused');
  }
  if (record?.phase !== 'paired' || record.revocation !== 'none' || !record.grant)
    throw new ConnectionError('refused');
  // The parser creates a private copy; later caller mutations cannot retarget it.
  const { origin, installationId, grant } = record;
  const grantExpiry = Date.parse(grant.expiresAt);
  const lifetime = new AbortController();
  let bearer: { value: string; expiresAt: number } | undefined;
  let checked: ConnectionView | undefined;
  let identity: Pick<ConnectionView, 'workspaceId' | 'userId'> | undefined;
  let pending: Promise<ConnectionView> | undefined;

  function stop(reason: ConnectionError) {
    bearer = undefined;
    checked = undefined;
    lifetime.abort(reason);
    intent.removeEventListener('abort', close);
  }
  function close() {
    stop(new ConnectionError('closed'));
  }
  intent.addEventListener('abort', close, { once: true });
  if (intent.aborted) close();

  function guard(signal?: AbortSignal) {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (now() >= grantExpiry) {
      const reason = new ConnectionError('expired');
      stop(reason);
      throw reason;
    }
  }
  const current = (): ConnectionView | undefined => {
    if (lifetime.signal.aborted || now() >= grantExpiry || !bearer || now() >= bearer.expiresAt) {
      bearer = undefined;
      checked = undefined;
    }
    return checked ? { ...checked } : undefined;
  };

  async function verify(signal: AbortSignal): Promise<ConnectionView> {
    async function request(path: '/auth/token' | '/session', token?: string) {
      guard(signal);
      const url = `${origin}/api/browser-companion${path}`;
      const response = await fetcher(url, {
        method: path === '/auth/token' ? 'POST' : 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers:
          path === '/auth/token'
            ? { 'Content-Type': 'application/json' }
            : { Authorization: `Bearer ${token}` },
        ...(path === '/auth/token'
          ? {
              body: JSON.stringify({ installationId, pairingSecret: grant.secret }),
            }
          : {}),
        signal,
      });
      guard(signal);
      if (response.redirected || (response.url && response.url !== url)) throw invalid();
      if (response.status === 401 || response.status === 403) throw new ConnectionError('refused');
      if (response.status !== 200) throw new ConnectionError('unavailable');
      const result = await readJson(response, signal);
      guard(signal);
      return result;
    }

    guard(signal);
    let candidate = bearer;
    if (!candidate || candidate.expiresAt <= now() + 30_000) {
      const started = now();
      const token = await request('/auth/token');
      if (
        typeof token.accessToken !== 'string' ||
        token.accessToken.length > 4096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.accessToken) ||
        token.tokenType !== 'Bearer' ||
        typeof token.expiresIn !== 'number' ||
        !Number.isInteger(token.expiresIn) ||
        token.expiresIn < 1 ||
        token.expiresIn > 300 ||
        date(token.grantExpiresAt) !== grantExpiry
      )
        throw invalid();
      candidate = {
        value: token.accessToken,
        // Conservative: count from dispatch and account for JWT second rounding.
        expiresAt: Math.min(grantExpiry, started + token.expiresIn * 1000 - 1000),
      };
    }
    if (now() >= candidate.expiresAt) throw new ConnectionError('expired');
    const session = await request('/session', candidate.value);
    if (
      session.grantId !== grant.id ||
      session.installationId !== installationId ||
      !uuid(session.workspaceId) ||
      !uuid(session.userId) ||
      date(session.grantExpiresAt) !== grantExpiry ||
      session.grantRevokedAt !== null ||
      session.pageAuthority !== 'none' ||
      (identity &&
        (session.workspaceId !== identity.workspaceId || session.userId !== identity.userId))
    )
      throw invalid();
    guard(signal);
    if (now() >= candidate.expiresAt) throw new ConnectionError('expired');
    identity = { workspaceId: session.workspaceId, userId: session.userId };
    checked = {
      origin,
      installationId,
      grantId: grant.id,
      ...identity,
      grantExpiresAt: grant.expiresAt,
      pageAuthority: 'none',
    };
    bearer = candidate;
    return { ...checked };
  }

  function refresh(): Promise<ConnectionView> {
    if (pending) return pending;
    try {
      guard();
    } catch (error) {
      return Promise.reject(error);
    }
    checked = undefined;
    const operation = new AbortController();
    const abort = () => operation.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => operation.abort(new ConnectionError('unavailable')), 15_000);
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(operation.signal.reason);
      operation.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    pending = (async () => {
      try {
        const result = await Promise.race([verify(operation.signal), cancelled]);
        guard(operation.signal);
        return result;
      } catch (error) {
        bearer = undefined;
        checked = undefined;
        if (error instanceof ConnectionError) throw error;
        // Fetch errors can carry private response text or credentials. Never echo them.
        throw new ConnectionError('unavailable');
      } finally {
        clearTimeout(timer);
        lifetime.signal.removeEventListener('abort', abort);
        operation.signal.removeEventListener('abort', rejectAbort);
        operation.abort(); // Also cancel unconsumed error bodies; never keep a request alive.
        pending = undefined;
      }
    })();
    return pending;
  }
  return { current, refresh, close };
}
