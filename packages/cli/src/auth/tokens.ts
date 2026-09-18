/**
 * PCP Auth Tokens
 *
 * PKCE generation, token storage (~/.ink/auth.json), refresh,
 * and JWT payload decoding for CLI OAuth flow.
 */

import crypto from 'crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  rmdirSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds from issuance
  scope: string;
  issued_at: number; // Date.now() at storage time
}

export interface StoredDelegatedAuth {
  access_token: string;
  expires_in: number; // seconds from issuance
  issued_at: number; // Date.now() at storage time
  scope?: string;
  agent_id: string;
  sb_id?: string;
}

type ExpiringToken = {
  expires_in: number;
  issued_at: number;
};

export interface JwtPayload {
  type: string;
  sub: string; // userId
  email: string;
  scope: string;
  sbSlug?: string;
  identityId?: string;
  exp: number;
  iat: number;
}

// ============================================================================
// Paths
// ============================================================================

const CLIENT_ID = 'sb-cli';

function authFilePath(): string {
  return join(homedir(), '.ink', 'auth.json');
}

function configFilePath(): string {
  return join(homedir(), '.ink', 'config.json');
}

function delegatedAuthDirPath(): string {
  return join(homedir(), '.ink', 'auth', 'agents');
}

function sanitizeSlug(sbSlug: string): string {
  return sbSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function delegatedAuthFilePath(sbSlug: string): string {
  return join(delegatedAuthDirPath(), `${sanitizeSlug(sbSlug)}.json`);
}

// ============================================================================
// PKCE
// ============================================================================

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ============================================================================
// Token Storage
// ============================================================================

export function loadAuth(): StoredAuth | null {
  const path = authFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Cross-process exclusion
// ============================================================================

/** How long to wait for another process to finish its decision. */
const CREDENTIAL_LOCK_WAIT_MS = 2_000;
/** Past this age a lock is assumed to belong to a process that died holding it. */
const CREDENTIAL_LOCK_STALE_MS = 10_000;
/** Gap between attempts. Short: every critical section here is microseconds. */
const CREDENTIAL_LOCK_POLL_MS = 15;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface CredentialLockOptions {
  /** Test seam. Production callers use the module's own budget. */
  lockWaitMs?: number;
}

/**
 * Run `mutate` with exclusive ownership of a credential file, across processes.
 *
 * Atomic writes are not atomic decisions. `~/.ink/auth.json` is shared by every
 * CLI process on the machine, and the interesting operations here are all
 * read-compare-write: delete this file IF it still holds the secret I
 * presented; store this result IF the file has not moved on. Temp-file+rename
 * makes each individual write all-or-nothing, and does nothing whatsoever for
 * the gap between the read and the write — another process rotating in that gap
 * is exactly the case being guarded against, and it lands unnoticed.
 *
 * `mkdir` is the primitive: it either creates the directory or fails with
 * EEXIST, atomically, on every filesystem we run on, with no cleanup ambiguity
 * about a partially-created lock. A holder that dies leaves the directory
 * behind, so a lock older than `CREDENTIAL_LOCK_STALE_MS` is broken rather than
 * waited on forever.
 *
 * Nothing slow happens inside: the network exchange is over before the lock is
 * taken. Waiting is therefore bounded and short, and failing to acquire is
 * reported rather than ignored — `{ held: false }` means the caller's decision
 * was NOT made, which for every caller here means "change nothing", never
 * "assume the worst and delete".
 */
function withCredentialLock<T>(
  path: string,
  mutate: () => T,
  options?: CredentialLockOptions
): { held: true; value: T } | { held: false } {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + (options?.lockWaitMs ?? CREDENTIAL_LOCK_WAIT_MS);

  // The lock lives beside the file it guards, so it needs the same directory —
  // and on a machine that has never logged in, that directory does not exist
  // yet. Creating it here rather than in each caller keeps a first `ink login`
  // from failing on a lock it could not place.
  mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let ageMs: number | null = null;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // It vanished between the failed mkdir and the stat: the holder just
        // released it. Try again immediately.
      }

      if (ageMs !== null && ageMs > CREDENTIAL_LOCK_STALE_MS) {
        try {
          rmdirSync(lockPath);
        } catch {
          // Another process broke it first. Either way it is gone; retry.
        }
        continue;
      }

      if (Date.now() >= deadline) return { held: false };
      sleepSync(CREDENTIAL_LOCK_POLL_MS);
    }
  }

  try {
    return { held: true, value: mutate() };
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // Best-effort: a lock we cannot remove ages out as stale.
    }
  }
}

/**
 * Write a credential file so a concurrent reader sees all of it or none of it.
 *
 * `writeFileSync` on an existing path truncates and then writes, so a second
 * process reading in between gets a partial file. `loadAuth` answers a parse
 * failure with null, which its callers read as "not logged in" — a race that
 * logs the CLI out of a perfectly good session. Writing a sibling temp file and
 * renaming makes the swap atomic: `rename(2)` within a directory either has
 * happened or has not.
 *
 * Orthogonal to the lock above, and neither replaces the other: this one makes
 * a single write indivisible to a READER, the lock makes a read-compare-write
 * indivisible to another WRITER.
 */
function writeCredentialFileAtomically(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; the rename failure is what matters.
    }
    throw err;
  }
  chmodSync(path, 0o600);
}

function writeAuthFile(auth: StoredAuth): void {
  const dir = join(homedir(), '.ink');
  mkdirSync(dir, { recursive: true });
  writeCredentialFileAtomically(authFilePath(), JSON.stringify(auth, null, 2) + '\n');
}

/**
 * Store a credential unconditionally — for `ink login`, which is a person
 * deciding what this machine's credential should now be.
 *
 * Takes the lock so it cannot land in the middle of another process's
 * compare-and-write, but writes anyway if it cannot get it. A login that
 * silently did nothing because some background command held a lock would be a
 * worse failure than the one being prevented.
 */
export function saveAuth(auth: StoredAuth, options?: CredentialLockOptions): void {
  const outcome = withCredentialLock(authFilePath(), () => writeAuthFile(auth), options);
  if (!outcome.held) writeAuthFile(auth);
}

/** What a conditional store did, which is never simply "worked" or "failed". */
export type CredentialSaveOutcome =
  /** The file held the expected secret and now holds the new one. */
  | 'saved'
  /** The file has moved to a generation this result does not follow from. */
  | 'superseded'
  /** There is no credential file. Something logged this machine out. */
  | 'absent'
  /** Another process holds the lock; no decision was made and nothing written. */
  | 'contended';

/**
 * Store a rotation's result only if the file still holds the secret it rotated.
 *
 * A token exchange takes as long as the network does, and the file can change
 * completely while one is in flight. Writing the result unconditionally on the
 * way back is how a slow response rolls the machine backwards:
 *
 *   - the file has moved on to a later generation, and our write reinstates an
 *     older secret that the server has already replaced — the next command
 *     presents a dead token and the user is logged out;
 *   - the user ran `ink logout` while we were waiting, and our write recreates
 *     the credential they just destroyed.
 *
 * Both are prevented by the same comparison, and the comparison is only worth
 * anything because it happens under the lock: read and write are one decision
 * with respect to every other process doing the same thing.
 */
export function saveAuthIfUnchanged(
  expectedRefreshToken: string,
  next: StoredAuth,
  options?: CredentialLockOptions
): CredentialSaveOutcome {
  const outcome = withCredentialLock(
    authFilePath(),
    (): CredentialSaveOutcome => {
      const current = loadAuth();
      if (!current) return 'absent';
      if (current.refresh_token !== expectedRefreshToken) return 'superseded';
      writeAuthFile(next);
      return 'saved';
    },
    options
  );

  return outcome.held ? outcome.value : 'contended';
}

export function clearAuth(): void {
  const path = authFilePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Delete the stored credential only if it is still the one the caller was
 * holding.
 *
 * `~/.ink/auth.json` is shared by every CLI process on the machine, and a
 * refresh rotates it. A caller whose own refresh failed cannot conclude the
 * file is dead: another process may have rotated the grant a moment earlier, in
 * which case the file now holds a working secret that is none of this caller's
 * business to delete. Comparing before unlinking keeps a lost race from logging
 * the winner out.
 *
 * The compare and the unlink are ONE decision, under the lock. Without it they
 * are two operations with a gap, and a rotation landing in the gap is deleted
 * by a caller that had already decided it was safe to — the comparison would
 * say "unchanged" about a file that was no longer the file being deleted.
 *
 * Failing to acquire the lock returns false and deletes nothing. Another
 * process is mid-decision about this exact file; a credential is not something
 * to destroy because we could not get a turn.
 *
 * @returns whether the file was removed
 */
export function clearAuthIfUnchanged(
  refreshToken: string,
  options?: CredentialLockOptions
): boolean {
  const outcome = withCredentialLock(
    authFilePath(),
    () => {
      const current = loadAuth();
      if (!current) return false;
      if (current.refresh_token !== refreshToken) return false;
      clearAuth();
      return true;
    },
    options
  );

  return outcome.held ? outcome.value : false;
}

export function loadDelegatedAuth(sbSlug: string): StoredDelegatedAuth | null {
  const path = delegatedAuthFilePath(sbSlug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveDelegatedAuth(sbSlug: string, auth: StoredDelegatedAuth): void {
  const dir = delegatedAuthDirPath();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort only; some environments may not support chmod.
  }

  writeCredentialFileAtomically(
    delegatedAuthFilePath(sbSlug),
    JSON.stringify(auth, null, 2) + '\n'
  );
}

export function clearDelegatedAuth(sbSlug: string): void {
  const path = delegatedAuthFilePath(sbSlug);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ============================================================================
// JWT Decode (no verification — server-issued, trusted locally)
// ============================================================================

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ============================================================================
// Token Expiry
// ============================================================================

export function isTokenExpired(auth: ExpiringToken, bufferSeconds = 300): boolean {
  const expiresAtMs = auth.issued_at + auth.expires_in * 1000;
  return Date.now() + bufferSeconds * 1000 >= expiresAtMs;
}

// ============================================================================
// Token Refresh
// ============================================================================

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

/**
 * The OAuth error codes that mean the grant itself is finished.
 *
 * RFC 6749 §5.2 gives `invalid_grant` exactly this meaning — invalid, expired
 * or revoked — and it is the only signal that justifies destroying the
 * credential on disk. `invalid_client` and `unauthorized_client` are terminal
 * for the same practical reason: this client will not be served with this
 * grant, however many times it asks.
 *
 * Everything outside this set is retryable BY DEFAULT, including codes we do
 * not recognize. An unknown refusal from a newer server must not be read as
 * permission to log the machine out.
 */
const TERMINAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/**
 * A refresh that did not produce a token, and whether that says anything about
 * the grant.
 *
 * The distinction is the whole class of bug: a failed exchange used to mean one
 * thing to this module — delete the credential — and the great majority of
 * failed exchanges do not mean that. A timeout, a reset socket, a 502 from a
 * proxy, an HTML error page where JSON was expected, the server being restarted:
 * in every one of them the grant is untouched and probably fine, and the only
 * thing lost is this attempt.
 */
export class RefreshFailure extends Error {
  /** True only when the server said the grant is invalid, expired or revoked. */
  readonly terminal: boolean;
  readonly oauthError?: string;
  readonly httpStatus?: number;

  constructor(
    message: string,
    details: { terminal: boolean; oauthError?: string; httpStatus?: number }
  ) {
    super(message);
    this.name = 'RefreshFailure';
    this.terminal = details.terminal;
    this.oauthError = details.oauthError;
    this.httpStatus = details.httpStatus;
  }
}

/** Anything that is not a RefreshFailure is, by construction, not terminal. */
export function isTerminalRefreshFailure(err: unknown): boolean {
  return err instanceof RefreshFailure && err.terminal;
}

export async function refreshAccessToken(serverUrl: string, auth: StoredAuth): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: CLIENT_ID,
  });

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // The request never got an answer. Nothing at all is known about the grant.
    throw new RefreshFailure(
      `Token refresh could not reach ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
      { terminal: false }
    );
  }

  // A body that will not parse is a failure of the transport or of something in
  // front of the server, never a statement about the grant.
  let data: TokenResponse | null = null;
  try {
    data = (await response.json()) as TokenResponse;
  } catch {
    data = null;
  }

  if (!response.ok || data?.error) {
    const oauthError = data?.error;
    const terminal =
      (response.status === 400 || response.status === 401) &&
      oauthError !== undefined &&
      TERMINAL_OAUTH_ERRORS.has(oauthError);

    throw new RefreshFailure(
      data?.error_description || oauthError || `Token refresh failed (HTTP ${response.status})`,
      { terminal, oauthError, httpStatus: response.status }
    );
  }

  if (!data?.access_token) {
    throw new RefreshFailure('Token refresh returned no access token', {
      terminal: false,
      httpStatus: response.status,
    });
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || auth.refresh_token,
    expires_in: data.expires_in,
    scope: data.scope || auth.scope,
    issued_at: Date.now(),
  };
}

// ============================================================================
// High-Level: Get Valid Access Token
// ============================================================================

/**
 * True when a token is a decodable JWT whose exp is in the past (with buffer).
 * Opaque/undecodable tokens return false — we only skip tokens we can PROVE
 * are expired.
 */
export function isJwtProvablyExpired(token: string, bufferSeconds = 60): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 <= Date.now() + bufferSeconds * 1000;
}

export async function getValidAccessToken(
  serverUrl: string,
  options?: { allowEnvToken?: boolean }
): Promise<string | null> {
  const allowEnvToken = options?.allowEnvToken !== false;
  if (allowEnvToken) {
    const envToken = process.env.INK_ACCESS_TOKEN?.trim();
    // Skip a provably-expired env token instead of returning it blindly.
    // Long-lived agent sessions inherit INK_ACCESS_TOKEN injected at session
    // start; once it expires, every spawned CLI command would 401 forever —
    // even after a fresh `ink login` — because the env token short-circuits
    // the auth.json path below.
    if (envToken && !isJwtProvablyExpired(envToken)) {
      return envToken;
    }
  }

  const auth = loadAuth();
  if (!auth) return null;

  if (!isTokenExpired(auth)) {
    return auth.access_token;
  }

  // Attempt refresh
  try {
    const refreshed = await refreshAccessToken(serverUrl, auth);

    // Store it only if the file is still the one we rotated. Our access token
    // is valid regardless of whether it gets stored — the exchange succeeded —
    // so a file that has moved on costs this command nothing.
    if (saveAuthIfUnchanged(auth.refresh_token, refreshed) === 'absent') {
      // Logged out while we were in flight. The credential is not recreated,
      // and this command does not get to act on a session the user ended.
      return null;
    }
    return refreshed.access_token;
  } catch (err) {
    // A failed exchange is not proof the grant is dead, and there are two
    // separate reasons it might not be.
    //
    // The server may have refused us terminally — `invalid_grant`, the grant
    // revoked or past its deadline — which is the one answer that justifies
    // deleting the credential. Or the attempt may simply not have landed: a
    // timeout, a 5xx, a proxy's HTML error page. Those say nothing whatsoever
    // about the grant, and treating them as a refusal logs a machine out every
    // time the server restarts.
    //
    // And even a terminal refusal is only about the secret WE presented.
    // `~/.ink/auth.json` is shared by every CLI process here, and the grant
    // rotates: if another process refreshed while we were in flight, the value
    // we presented is the one IT retired — correctly refused — while the file
    // already holds the live successor. So the delete is conditional on the
    // file still holding what we sent, decided in one locked comparison.
    if (isTerminalRefreshFailure(err) && clearAuthIfUnchanged(auth.refresh_token)) {
      return null;
    }

    // Either someone else won the rotation, or we learned nothing. Both are
    // answered by what is on disk now — but only if it has actually changed.
    // Retrying the same secret that just failed achieves nothing.
    const current = loadAuth();
    if (!current) return null;
    if (current.refresh_token === auth.refresh_token) return null;
    if (!isTokenExpired(current)) return current.access_token;
    try {
      const refreshed = await refreshAccessToken(serverUrl, current);
      // Their secret is not ours, so this store is conditional on THEIR value,
      // not the one we started with.
      if (saveAuthIfUnchanged(current.refresh_token, refreshed) === 'absent') return null;
      return refreshed.access_token;
    } catch {
      // Their secret failed too, but it is still not ours to delete — we never
      // held it, and a third process may be mid-rotation with it right now.
      return null;
    }
  }
}

export function getValidDelegatedAccessToken(
  sbSlug: string,
  options?: { bufferSeconds?: number }
): string | null {
  const auth = loadDelegatedAuth(sbSlug);
  if (!auth) return null;
  if (isTokenExpired(auth, options?.bufferSeconds ?? 300)) return null;
  return auth.access_token;
}

// ============================================================================
// Config Helpers
// ============================================================================

export function updateConfigEmail(email: string, userId?: string): void {
  const path = configFilePath();
  const dir = join(homedir(), '.ink');
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Overwrite unparseable config
    }
  }

  existing.email = email;
  if (userId) existing.userId = userId;
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
}

export { CLIENT_ID };
