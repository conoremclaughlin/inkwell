/**
 * OAuth connection state shared by the admin routes and the app's Connectors
 * routes (routes/admin-connectors.ts), and the app's connection attempts.
 *
 * Both live in memory, like the OAuth state always has: a restart or a second
 * instance loses them. An attempt that can't be found reads as `unknown`, and
 * the app then says it couldn't confirm the connection, never that it worked.
 *
 * An attempt is settled only by the OAuth callback for its own state, with the
 * id of the account row that callback saved, whether the save made a new row
 * or updated one already there. A row that already existed never settles an
 * attempt: only the callback does.
 */
import crypto from 'crypto';
import { env } from '../config/env';

export interface OAuthStateEntry {
  userId: string;
  workspaceId: string;
  provider: string;
  expiresAt: number;
  /** Set for a connection started from the app: the attempt it settles. */
  appAttemptId?: string;
}

/** OAuth `state` → who started the flow. In memory (in production, use Redis or similar). */
export const oauthStateStore = new Map<string, OAuthStateEntry>();

/** How long a state, and the attempt it carries, can wait for its callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The redirect URI the provider sends people back to, for every flow (the
 * dashboard's authorize and upgrade, the app's start, and the callback's code
 * exchange). OAUTH_REDIRECT_BASE_URL is either an origin (the callback path is
 * appended) or a full redirect URI. It is used exactly as configured: an origin
 * ending in '/' still gives '//', as before, because the URI registered with
 * the provider must match it character for character.
 */
export function oauthRedirectUri(provider: string): string {
  const configuredUrl = env.OAUTH_REDIRECT_BASE_URL;
  const defaultPath = `/api/admin/oauth/${provider}/callback`;
  if (configuredUrl) {
    const url = new URL(configuredUrl);
    return url.pathname !== '/' ? configuredUrl : `${configuredUrl}${defaultPath}`;
  }
  return `http://localhost:${env.MCP_HTTP_PORT}${defaultPath}`;
}

export type AttemptStatus = 'pending' | 'connected' | 'denied' | 'expired' | 'failed';

interface Attempt {
  userId: string;
  provider: string;
  status: AttemptStatus;
  accountId: string | null;
  /** When the attempt is forgotten. */
  forgetAt: number;
}

/** Settled attempts are kept a while after their state expires, for the app to read. */
const KEEP_MS = 30 * 60 * 1000;
const attempts = new Map<string, Attempt>();

function prune(now: number) {
  for (const [id, attempt] of attempts) if (attempt.forgetAt <= now) attempts.delete(id);
  for (const [state, entry] of oauthStateStore) {
    if (entry.expiresAt + KEEP_MS <= now) oauthStateStore.delete(state);
  }
}

/** Starts an attempt for the app, with the OAuth state that will settle it. */
export function startAppAttempt(
  userId: string,
  workspaceId: string,
  provider: string,
  now = Date.now()
): { attemptId: string; state: string } {
  prune(now);
  const attemptId = crypto.randomBytes(16).toString('hex');
  const state = crypto.randomBytes(32).toString('hex');
  oauthStateStore.set(state, {
    userId,
    workspaceId,
    provider,
    expiresAt: now + OAUTH_STATE_TTL_MS,
    appAttemptId: attemptId,
  });
  attempts.set(attemptId, {
    userId,
    provider,
    status: 'pending',
    accountId: null,
    forgetAt: now + OAUTH_STATE_TTL_MS + KEEP_MS,
  });
  return { attemptId, state };
}

/** Records how an attempt ended. Only the callback for its own state calls this. */
export function settleAttempt(
  attemptId: string | undefined,
  status: Exclude<AttemptStatus, 'pending'>,
  accountId: string | null = null
): void {
  if (!attemptId) return;
  const attempt = attempts.get(attemptId);
  if (!attempt || attempt.status !== 'pending') return;
  attempt.status = status;
  attempt.accountId = status === 'connected' ? accountId : null;
}

/**
 * How the person's own attempt stands: `unknown` if there is no such attempt
 * for them (another person's, a restart, or long ago); `expired` if its state
 * ran out with no callback.
 */
export function attemptStatus(
  userId: string,
  attemptId: string,
  now = Date.now()
): { status: AttemptStatus | 'unknown'; accountId: string | null } {
  const attempt = attempts.get(attemptId);
  if (!attempt || attempt.userId !== userId || attempt.forgetAt <= now) {
    return { status: 'unknown', accountId: null };
  }
  if (attempt.status === 'pending' && now > attempt.forgetAt - KEEP_MS) {
    return { status: 'expired', accountId: null };
  }
  return { status: attempt.status, accountId: attempt.accountId };
}

/** Test seam. */
export function resetOAuthAttempts(): void {
  attempts.clear();
  oauthStateStore.clear();
}
