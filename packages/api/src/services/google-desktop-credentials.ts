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

import { readdir, readFile, stat } from 'fs/promises';
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
  /** File modification time — a re-login rewrites the file and resets any refusal. */
  mtimeMs: number;
  credential: DesktopGoogleCredential;
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
  mtimeMs: number;
}

interface Refusal {
  reason: string;
  mtimeMs: number;
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
   * one bad file must not take down the good ones beside it.
   */
  async list(): Promise<DesktopCredentialRecord[]> {
    const dir = this.dir;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logger.warn('Could not read desktop Google credentials directory', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return [];
    }

    const records: DesktopCredentialRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name === DESKTOP_CLIENT_FILENAME) continue;
      const path = join(dir, name);
      try {
        const [raw, info] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
        const parsed = parseDesktopGoogleCredential(JSON.parse(raw));
        if (!parsed.ok) {
          logger.warn('Ignoring malformed desktop Google credential', {
            path,
            reason: parsed.reason,
          });
          continue;
        }
        records.push({
          path,
          email: parsed.value.email,
          scopes: parsed.value.scopes,
          obtainedAt: parsed.value.obtained_at ?? null,
          mtimeMs: info.mtimeMs,
          credential: parsed.value,
        });
      } catch (err) {
        logger.warn('Ignoring unreadable desktop Google credential', {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return records;
  }

  /** The file bound to this email, or null. Matching is case-insensitive. */
  async findForEmail(email: string | null | undefined): Promise<DesktopCredentialRecord | null> {
    if (!email) return null;
    const wanted = normalizeGoogleEmail(email);
    if (!wanted) return null;
    const records = await this.list();
    return records.find((record) => record.email === wanted) ?? null;
  }

  /**
   * Non-mutating twin of getAccessToken: the same checks in the same order, so
   * the verdict describes the decision a real call would make.
   */
  inspect(record: DesktopCredentialRecord): DesktopCredentialVerdict {
    const refusal = this.refusals.get(record.path);
    if (refusal && refusal.mtimeMs === record.mtimeMs) {
      return { state: 'unusable', reason: refusal.reason, expiresAt: null };
    }
    const cached = this.tokens.get(record.path);
    const expiresAt = cached ? new Date(cached.expiresAt).toISOString() : null;
    if (
      cached &&
      cached.mtimeMs === record.mtimeMs &&
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
   * remembered against the file's mtime so every later call fails fast with the
   * same reason instead of asking Google again; a re-login rewrites the file and
   * clears it. Network failures are not remembered — they are not evidence
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
        this.refusals.set(record.path, { reason, mtimeMs: record.mtimeMs });
        this.tokens.delete(record.path);
      }
      logger.warn('Desktop Google credential refresh failed', {
        path: record.path,
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
      mtimeMs: record.mtimeMs,
    });
    this.refusals.delete(record.path);
    logger.info('Refreshed desktop Google credential', { path: record.path, email: record.email });
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
