/**
 * Desktop Google credentials — the `desktop` credential source.
 *
 * `ink google login` obtains a refresh token on the operator's machine through
 * a Desktop-app OAuth client and the loopback flow, and writes it as an
 * `authorized_user` file under `~/.ink/google/` (see @inklabs/shared for the
 * shape). This store reads those files and turns them into access tokens for
 * the Google story services, next to the cloud connection in
 * `connected_accounts`.
 *
 * Binding: a file is usable for an Inkwell user ONLY when its `email` matches
 * that user's email. The files live in the server operator's home directory,
 * and this server serves more than one user, so "a file exists" must never
 * mean "everyone may use it".
 *
 * Nothing here blocks the event loop — all file access is fs/promises.
 */

import { createHash } from 'crypto';
import { open, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  DESKTOP_CLIENT_FILENAME,
  GOOGLE_TOKEN_URL,
  normalizeGoogleEmail,
  parseDesktopGoogleCredential,
  resolveDesktopCredentialsDir,
  type DesktopGoogleCredential,
} from '@inklabs/shared';
import { logger } from '../utils/logger';
import { TOKEN_REFRESH_WINDOW_MS } from './oauth-refresh-window';

export interface DesktopCredentialRecord {
  path: string;
  email: string;
  scopes: string[];
  obtainedAt: string | null;
  /** Modification time of the bytes that were parsed — for display only. */
  mtimeMs: number;
  /**
   * Digest of the bytes that were parsed. Cached tokens and refusals are keyed
   * on THIS, not on mtime: a re-login is a new generation whatever its
   * timestamp says, and the same bytes touched again are still the same
   * refused token (Lumen, PR #588: read and stat taken separately could pair
   * old bytes with a new mtime across an atomic rename, pinning the old
   * refusal to the new login).
   */
  generation: string;
  credential: DesktopGoogleCredential;
}

/** A listing that says whether it could be trusted — an unreadable directory is not an empty one. */
export interface DesktopCredentialListing {
  records: DesktopCredentialRecord[];
  /** Why the directory could not be read, when it could not. */
  error: string | null;
  /**
   * Candidate files that could not be read or parsed. Each is a binding this
   * listing could not establish or rule out (Lumen, PR #588 round 3): a file
   * the operator can see but the server cannot open is not "no file".
   */
  unreadable: number;
}

/**
 * A read-only view of how `getAccessToken` would fare right now for one file.
 * Mirrors ProviderAccountHealth's vocabulary so the two sources report alike.
 */
export interface DesktopCredentialVerdict {
  /**
   * - `active`: a cached access token is good for longer than the refresh window.
   * - `refresh_required`: the next call refreshes first, and that refresh may fail.
   * - `unusable`: Google refused the refresh token; nothing works until the file changes.
   */
  state: 'active' | 'refresh_required' | 'unusable';
  reason: string | null;
  /** Expiry of the cached access token, when one exists. */
  expiresAt: string | null;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
  generation: string;
}

interface Refusal {
  reason: string;
  generation: string;
}

export interface DesktopGoogleCredentialStoreOptions {
  /** Directory to read; defaults to INK_GOOGLE_CREDENTIALS_DIR or ~/.ink/google. */
  dir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DesktopGoogleCredentialStore {
  private readonly tokens = new Map<string, CachedAccessToken>();
  private readonly refusals = new Map<string, Refusal>();

  constructor(private readonly options: DesktopGoogleCredentialStoreOptions = {}) {}

  get dir(): string {
    return this.options.dir ?? resolveDesktopCredentialsDir(process.env, homedir());
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Every well-formed credential file in the directory, sorted by name. A
   * malformed file is logged and skipped rather than failing the whole listing —
   * one bad file must not take down the good ones beside it. A directory that
   * does not exist is an empty listing; one that cannot be READ is reported as
   * such, because "nothing is there" and "I could not look" are different
   * claims (Lumen, PR #588).
   */
  async list(): Promise<DesktopCredentialListing> {
    const dir = this.dir;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return { records: [], error: null, unreadable: 0 };
      // Filesystem errors contain local paths; parser errors can quote credential
      // bytes. Neither belongs in the shared server log or a status response.
      logger.warn('Could not read desktop Google credentials directory');
      return {
        records: [],
        error: 'Could not read desktop Google credentials directory',
        unreadable: 0,
      };
    }

    const records: DesktopCredentialRecord[] = [];
    let unreadable = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name === DESKTOP_CLIENT_FILENAME) continue;
      const path = join(dir, name);
      try {
        // Content and metadata come from ONE open handle, i.e. one inode. An
        // atomic re-login (write temp, rename over) swaps the directory entry
        // but not what this handle points at, so the bytes parsed here and
        // the mtime beside them always describe the same generation.
        const handle = await open(path, 'r');
        let raw: string;
        let mtimeMs: number;
        try {
          const [content, info] = await Promise.all([handle.readFile('utf-8'), handle.stat()]);
          raw = content;
          mtimeMs = info.mtimeMs;
        } finally {
          await handle.close();
        }
        const parsed = parseDesktopGoogleCredential(JSON.parse(raw));
        if (!parsed.ok) {
          logger.warn('Ignoring malformed desktop Google credential');
          unreadable += 1;
          continue;
        }
        records.push({
          path,
          email: parsed.value.email,
          scopes: parsed.value.scopes,
          obtainedAt: parsed.value.obtained_at ?? null,
          mtimeMs,
          generation: createHash('sha256').update(raw).digest('hex'),
          credential: parsed.value,
        });
      } catch {
        logger.warn('Ignoring unreadable desktop Google credential');
        unreadable += 1;
      }
    }
    return { records, error: null, unreadable };
  }

  /**
   * The file bound to this email, or null — and whether the answer can be
   * trusted. Matching is case-insensitive.
   *
   * A readable file bound to the email is the answer even if other files in
   * the directory are bad — one person's broken file must not take down
   * another's login. But "no file for this email" is only an answer when every
   * candidate could be read: otherwise the binding is unestablished, and the
   * error says how many files were unreadable without naming them (they may
   * belong to other people).
   */
  async findForEmail(
    email: string | null | undefined
  ): Promise<{ record: DesktopCredentialRecord | null; error: string | null }> {
    if (!email) return { record: null, error: null };
    const wanted = normalizeGoogleEmail(email);
    if (!wanted) return { record: null, error: null };
    const listing = await this.list();
    if (listing.error) return { record: null, error: listing.error };
    const record = listing.records.find((candidate) => candidate.email === wanted) ?? null;
    if (record) return { record, error: null };
    if (listing.unreadable > 0) {
      return {
        record: null,
        error:
          `${listing.unreadable} credential file(s) in ${this.dir} could not be read or parsed, ` +
          `so no binding for ${wanted} could be established`,
      };
    }
    return { record: null, error: null };
  }

  /**
   * Non-mutating twin of getAccessToken: the same checks in the same order, so
   * the verdict describes the decision a real call would make.
   */
  inspect(record: DesktopCredentialRecord): DesktopCredentialVerdict {
    const refusal = this.refusals.get(record.path);
    if (refusal && refusal.generation === record.generation) {
      return { state: 'unusable', reason: refusal.reason, expiresAt: null };
    }
    const cached = this.tokens.get(record.path);
    const expiresAt = cached ? new Date(cached.expiresAt).toISOString() : null;
    if (
      cached &&
      cached.generation === record.generation &&
      cached.expiresAt - this.now() > TOKEN_REFRESH_WINDOW_MS
    ) {
      return { state: 'active', reason: null, expiresAt };
    }
    return {
      state: 'refresh_required',
      reason: `The next call must refresh an access token from ${record.path} first, and that refresh may fail`,
      expiresAt,
    };
  }

  /**
   * A usable access token for this file, refreshing through Google's token
   * endpoint with the file's own client when the cached one is inside the
   * refresh window. A permanent refusal (invalid_grant, invalid_client) is
   * remembered against the parsed bytes' generation so every later call fails
   * fast with the same reason instead of asking Google again; a re-login is a
   * new generation and is tried afresh. Network failures are not remembered — they are not evidence
   * about the credential.
   */
  async getAccessToken(record: DesktopCredentialRecord): Promise<string> {
    const verdict = this.inspect(record);
    if (verdict.state === 'unusable')
      throw new Error(verdict.reason ?? 'desktop credential unusable');
    if (verdict.state === 'active') {
      const cached = this.tokens.get(record.path);
      if (cached) return cached.accessToken;
    }

    const { client_id, client_secret, refresh_token } = record.credential;
    const body = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: 'refresh_token',
    });
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new Error(
        `Desktop Google credential ${record.path} could not be refreshed (network): ` +
          (err instanceof Error ? err.message : String(err))
      );
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      const reason = `Google refused the desktop credential ${record.path} (${response.status}): ${text}`;
      // 400 invalid_grant (expired/revoked refresh token — Google's testing-mode
      // seven-day expiry lands here) and 401 invalid_client are permanent for
      // this file. Anything else is Google's problem for the moment.
      if (response.status === 400 || response.status === 401) {
        this.refusals.set(record.path, { reason, generation: record.generation });
        this.tokens.delete(record.path);
      }
      logger.warn('Desktop Google credential refresh failed', {
        status: response.status,
      });
      throw new Error(reason);
    }

    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error(`Google returned no access token for the desktop credential ${record.path}`);
    }
    const expiresAt = this.now() + (data.expires_in ?? 3600) * 1000;
    this.tokens.set(record.path, {
      accessToken: data.access_token,
      expiresAt,
      generation: record.generation,
    });
    this.refusals.delete(record.path);
    logger.info('Refreshed desktop Google credential');
    return data.access_token;
  }
}

let store: DesktopGoogleCredentialStore | null = null;

export function getDesktopGoogleCredentialStore(): DesktopGoogleCredentialStore {
  if (!store) store = new DesktopGoogleCredentialStore();
  return store;
}

/** Test seam: replace the process-wide store. */
export function setDesktopGoogleCredentialStore(next: DesktopGoogleCredentialStore | null): void {
  store = next;
}
