/**
 * OAuth Service
 *
 * Handles OAuth flows for third-party integrations (Google, etc.)
 * Manages token storage, refresh, and revocation.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  GOOGLE_AUTH_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  parseGoogleCredentialSources,
  type GoogleCredentialSource,
} from '@inklabs/shared';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getRequestContext, getSessionContext } from '../utils/request-context';
import {
  getDesktopGoogleCredentialStore,
  type DesktopGoogleCredentialStore,
} from './google-desktop-credentials';
import { TOKEN_REFRESH_WINDOW_MS } from './oauth-refresh-window';

// OAuth provider configurations
interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    revokeUrl: GOOGLE_REVOKE_URL,
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    // The scope list is shared with `ink google login` (@inklabs/shared), so a
    // desktop credential covers exactly what the cloud connection covers.
    scopes: [...GOOGLE_OAUTH_SCOPES],
  },
};

export interface ConnectedAccount {
  id: string;
  userId: string;
  workspaceId: string | null;
  provider: string;
  providerAccountId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked' | 'error';
  lastError: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope?: string;
}

/**
 * The token getValidAccessToken would refresh with before its next call, or null
 * if it would send the stored access token unchanged.
 *
 * Both halves of the condition matter: without a refresh token there is nothing
 * to refresh with, so that method hands back the stored token and it works right
 * up until expiry. Sharing only the five-minute window left the two methods
 * disagreeing about exactly that case.
 *
 * Returning the token rather than a boolean means the caller that performs the
 * refresh and the caller that describes it read one value, instead of two
 * expressions that have to be kept in step by hand.
 */
function pendingRefreshToken(
  expiresAt: string | null | undefined,
  refreshToken: string | null | undefined
): string | null {
  if (!refreshToken || !expiresAt) return null;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return null;
  return expiry - Date.now() < TOKEN_REFRESH_WINDOW_MS ? refreshToken : null;
}

/**
 * A read-only view of how a provider call would fare right now, derived from
 * stored account state. `reason` is null only when the account is usable as-is.
 */
export interface ProviderAccountHealth {
  /**
   * - `active`: getValidAccessToken would hand back the stored token unchanged.
   * - `refresh_required`: the next call will refresh before using the token —
   *   inside the refresh window AND holding a refresh token to do it with.
   *   Whether that refresh succeeds cannot be known without performing it, and
   *   with Google's testing-mode seven-day expiry this is the state that fails.
   *   An account with no refresh token never reaches here: nothing refreshes it,
   *   so it stays `active` until expiry and is `unusable` after.
   * - `unusable`: no call would succeed.
   * - `missing`: nothing is connected for this provider.
   * - `unknown`: account state could not be read, so there is no verdict.
   */
  state: 'active' | 'refresh_required' | 'unusable' | 'missing' | 'unknown';
  /**
   * Which credential source this verdict describes — the `connected_accounts`
   * row (`cloud`) or a desktop file bound to the user (`desktop`). Null when no
   * source had anything to say (`missing`, `unknown`).
   */
  source: GoogleCredentialSource | null;
  /** The stored account status, when a row exists. */
  accountStatus: 'active' | 'expired' | 'revoked' | 'error' | null;
  reason: string | null;
  lastError: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** When the account row last changed — the age of this evidence. */
  observedAt: string | null;
}

export interface OAuthServiceOptions {
  /** Credential sources in the order they are tried; defaults to GOOGLE_CREDENTIAL_SOURCES. */
  sources?: GoogleCredentialSource[];
  desktopStore?: DesktopGoogleCredentialStore;
}

/** A user's email stays valid for a minute — the binding key for desktop files. */
const USER_EMAIL_CACHE_MS = 60 * 1000;

class OAuthService {
  private supabase: SupabaseClient;
  private readonly sources: GoogleCredentialSource[];
  private readonly desktopStore: DesktopGoogleCredentialStore;
  private readonly userEmails = new Map<string, { email: string | null; at: number }>();

  constructor(options: OAuthServiceOptions = {}) {
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    this.sources = options.sources ?? parseGoogleCredentialSources(env.GOOGLE_CREDENTIAL_SOURCES);
    this.desktopStore = options.desktopStore ?? getDesktopGoogleCredentialStore();
  }

  /** The credential sources this service tries for Google, in order. */
  getCredentialSources(): GoogleCredentialSource[] {
    return [...this.sources];
  }

  private usesDesktopSource(provider: string): boolean {
    return provider === 'google' && this.sources.includes('desktop');
  }

  /**
   * The email a desktop credential must carry to be used for this user. A
   * lookup FAILURE is reported as such and never cached: for access it binds
   * nothing (guessing would hand one person's mailbox to another), and for
   * health it must read as "could not look", not "nothing there" (Lumen, PR
   * #588). A successful lookup — including a user with no email — is cached.
   */
  private async lookupUserEmail(
    userId: string
  ): Promise<{ email: string | null; error: string | null }> {
    const cached = this.userEmails.get(userId);
    if (cached && Date.now() - cached.at < USER_EMAIL_CACHE_MS) {
      return { email: cached.email, error: null };
    }
    let failure: string;
    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .maybeSingle();
      if (!error) {
        const email = (data?.email as string | null | undefined) ?? null;
        this.userEmails.set(userId, { email, at: Date.now() });
        return { email, error: null };
      }
      failure = error.message;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    logger.warn('Could not resolve user email for desktop Google credential binding', {
      userId,
      error: failure,
    });
    return { email: null, error: `Could not resolve the user's email: ${failure}` };
  }

  private resolveWorkspaceId(workspaceId?: string | null): string | null | undefined {
    if (workspaceId !== undefined) return workspaceId;
    return getRequestContext()?.workspaceId ?? getSessionContext()?.workspaceId;
  }

  /**
   * Get the required scopes for a provider.
   * Used by the frontend to compare against user's current scopes.
   */
  getRequiredScopes(provider: string): string[] {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown OAuth provider: ${provider}`);
    }
    return [...config.scopes];
  }

  /**
   * Check if the user's current scopes are missing any required scopes.
   * Returns the list of missing scopes, or empty array if all scopes are present.
   */
  getMissingScopes(provider: string, currentScopes: string[]): string[] {
    const requiredScopes = this.getRequiredScopes(provider);
    const currentSet = new Set(currentScopes);
    return requiredScopes.filter((scope) => !currentSet.has(scope));
  }

  /**
   * Generate OAuth authorization URL for a provider
   */
  getAuthorizationUrl(
    provider: string,
    redirectUri: string,
    state: string,
    additionalScopes?: string[]
  ): string {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown OAuth provider: ${provider}`);
    }

    if (!config.clientId) {
      throw new Error(`OAuth not configured for ${provider}: missing client ID`);
    }

    const scopes = [...config.scopes, ...(additionalScopes || [])];
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      access_type: 'offline', // Request refresh token
      prompt: 'consent', // Always show consent screen to get refresh token
    });

    return `${config.authUrl}?${params.toString()}`;
  }

  /**
   * Get an OAuth URL for upgrading scopes (incremental authorization).
   * Uses Google's include_granted_scopes to keep existing permissions.
   */
  getUpgradeScopesUrl(
    provider: string,
    redirectUri: string,
    state: string,
    existingScopes: string[],
    loginHint?: string
  ): string {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown OAuth provider: ${provider}`);
    }

    if (!config.clientId) {
      throw new Error(`OAuth not configured for ${provider}: missing client ID`);
    }

    // Only request the missing scopes
    const missingScopes = this.getMissingScopes(provider, existingScopes);
    if (missingScopes.length === 0) {
      throw new Error('No missing scopes to upgrade');
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: missingScopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true', // Keep existing scopes
    });

    // Add login_hint to pre-select the account
    if (loginHint) {
      params.set('login_hint', loginHint);
    }

    return `${config.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(provider: string, code: string, redirectUri: string): Promise<TokenResponse> {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown OAuth provider: ${provider}`);
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('OAuth token exchange failed:', { provider, error });
      throw new Error(`Failed to exchange code: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
      scope?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  /**
   * Refresh an expired access token
   */
  async refreshAccessToken(provider: string, refreshToken: string): Promise<TokenResponse> {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      throw new Error(`Unknown OAuth provider: ${provider}`);
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('OAuth token refresh failed:', { provider, error });
      throw new Error(`Failed to refresh token: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
      scope?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Google doesn't always return new refresh token
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  /**
   * Fetch user info from provider
   */
  async getUserInfo(
    provider: string,
    accessToken: string
  ): Promise<{ id: string; email?: string; name?: string; picture?: string }> {
    if (provider === 'google') {
      const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch user info');
      }

      const data = (await response.json()) as {
        id: string;
        email?: string;
        name?: string;
        picture?: string;
      };
      return {
        id: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture,
      };
    }

    throw new Error(`getUserInfo not implemented for ${provider}`);
  }

  /**
   * Save or update a connected account
   */
  async saveConnectedAccount(
    userId: string,
    provider: string,
    tokens: TokenResponse,
    userInfo: { id: string; email?: string; name?: string; picture?: string },
    workspaceId?: string | null
  ): Promise<ConnectedAccount> {
    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null;

    const scopes = tokens.scope?.split(' ') || [];
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);

    let existingQuery = this.supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('provider_account_id', userInfo.id);

    if (resolvedWorkspaceId === null) {
      existingQuery = existingQuery.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      existingQuery = existingQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data: existing, error: existingError } = await existingQuery
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      logger.error('Failed to look up connected account before save:', existingError);
      throw new Error('Failed to save connected account');
    }

    const payload = {
      user_id: userId,
      provider,
      provider_account_id: userInfo.id,
      email: userInfo.email || null,
      display_name: userInfo.name || null,
      avatar_url: userInfo.picture || null,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken || null,
      token_type: tokens.tokenType,
      expires_at: expiresAt,
      scopes,
      status: 'active',
      last_error: null,
      updated_at: new Date().toISOString(),
      ...(resolvedWorkspaceId !== undefined ? { workspace_id: resolvedWorkspaceId } : {}),
    };

    const saveQuery = existing
      ? this.supabase.from('connected_accounts').update(payload).eq('id', existing.id)
      : this.supabase.from('connected_accounts').insert(payload);

    const { data, error } = await saveQuery.select().single();

    if (error) {
      logger.error('Failed to save connected account:', error);
      throw new Error('Failed to save connected account');
    }

    return this.mapToConnectedAccount(data);
  }

  /**
   * Get all connected accounts for a user
   */
  async getConnectedAccounts(
    userId: string,
    workspaceId?: string | null
  ): Promise<ConnectedAccount[]> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (resolvedWorkspaceId === null) {
      query = query.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get connected accounts:', error);
      throw new Error('Failed to get connected accounts');
    }

    return (data || []).map(this.mapToConnectedAccount);
  }

  /**
   * Get a specific connected account
   */
  async getConnectedAccount(
    userId: string,
    provider: string,
    workspaceId?: string | null
  ): Promise<ConnectedAccount | null> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('status', 'active');

    if (resolvedWorkspaceId === null) {
      query = query.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('Failed to get connected account:', error);
      throw new Error('Failed to get connected account');
    }

    return data ? this.mapToConnectedAccount(data) : null;
  }

  /**
   * Inspect stored account state without refreshing tokens or calling the
   * provider. The non-mutating twin of getValidAccessToken: it mirrors that
   * method's account selection, so the answer describes the account a real call
   * would actually use rather than any row that happens to exist.
   *
   * Never throws — a lookup failure reports as 'unknown' with a reason, because
   * a health check that explodes is worse than one that says "I can't tell".
   * 'unknown' is deliberately distinct from 'missing': "I could not read the
   * account table" is not the same claim as "nothing is connected".
   */
  async inspectAccountHealth(
    userId: string,
    provider: string,
    workspaceId?: string | null
  ): Promise<ProviderAccountHealth> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    if (!this.usesDesktopSource(provider)) {
      return this.inspectCloudAccountHealth(userId, provider, resolvedWorkspaceId);
    }

    // Same order as getValidAccessToken: the first source that would be tried
    // and looks usable is the one the next call depends on. When none is, the
    // most informative failure wins — a refusal over a blank, a blank over an
    // unreadable table — and with nothing anywhere, the cloud verdict keeps
    // its long-standing wording.
    const verdicts = new Map<GoogleCredentialSource, ProviderAccountHealth>();
    for (const source of this.sources) {
      const verdict =
        source === 'cloud'
          ? await this.inspectCloudAccountHealth(userId, provider, resolvedWorkspaceId)
          : await this.inspectDesktopAccountHealth(userId);
      if (verdict.state === 'active' || verdict.state === 'refresh_required') return verdict;
      verdicts.set(source, verdict);
    }
    const all = [...verdicts.values()];
    return (
      all.find((v) => v.state === 'unusable') ??
      all.find((v) => v.state === 'unknown') ??
      verdicts.get('cloud') ??
      all[0]
    );
  }

  /** The desktop file bound to this user, described in the same vocabulary as the cloud row. */
  private async inspectDesktopAccountHealth(userId: string): Promise<ProviderAccountHealth> {
    const blank: Omit<ProviderAccountHealth, 'state' | 'source' | 'reason'> = {
      accountStatus: null,
      lastError: null,
      expiresAt: null,
      lastUsedAt: null,
      observedAt: null,
    };
    const lookup = await this.lookupUserEmail(userId);
    if (lookup.error) return { ...blank, state: 'unknown', source: null, reason: lookup.error };
    const found = await this.desktopStore.findForEmail(lookup.email);
    if (found.error) return { ...blank, state: 'unknown', source: null, reason: found.error };
    const record = found.record;
    if (!record) {
      return {
        ...blank,
        state: 'missing',
        source: null,
        reason: lookup.email
          ? `No desktop Google credential for ${lookup.email} in ${this.desktopStore.dir}`
          : 'No desktop Google credential can be bound: the user has no email',
      };
    }
    const verdict = this.desktopStore.inspect(record);
    return {
      state: verdict.state,
      source: 'desktop',
      accountStatus: null,
      reason: verdict.reason,
      lastError: verdict.state === 'unusable' ? verdict.reason : null,
      expiresAt: verdict.expiresAt,
      lastUsedAt: null,
      observedAt: new Date(record.mtimeMs).toISOString(),
    };
  }

  private async inspectCloudAccountHealth(
    userId: string,
    provider: string,
    resolvedWorkspaceId: string | null | undefined
  ): Promise<ProviderAccountHealth> {
    let query = this.supabase
      .from('connected_accounts')
      .select('status, last_error, expires_at, last_used_at, updated_at, refresh_token')
      .eq('user_id', userId)
      .eq('provider', provider);

    if (resolvedWorkspaceId === null) {
      query = query.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data: rows, error } = await query.order('updated_at', { ascending: false });

    if (error) {
      return {
        state: 'unknown',
        source: null,
        accountStatus: null,
        reason: `Could not read account state: ${error.message}`,
        lastError: null,
        expiresAt: null,
        lastUsedAt: null,
        observedAt: null,
      };
    }

    if (!rows || rows.length === 0) {
      return {
        state: 'missing',
        source: null,
        accountStatus: null,
        reason: `No ${provider} account has been connected`,
        lastError: null,
        expiresAt: null,
        lastUsedAt: null,
        observedAt: null,
      };
    }

    // getValidAccessToken filters on status='active', so an active row is the one
    // a real call would pick. Only when none is active does the newest failed row
    // explain why — matching the "No active <provider> account found" it throws.
    const active = rows.find((row) => row.status === 'active');
    const row = active ?? rows[0];

    const base = {
      source: 'cloud' as const,
      accountStatus: row.status as ProviderAccountHealth['accountStatus'],
      lastError: row.last_error ?? null,
      expiresAt: row.expires_at ?? null,
      lastUsedAt: row.last_used_at ?? null,
      observedAt: row.updated_at ?? null,
    };

    if (!active) {
      return {
        ...base,
        state: 'unusable',
        reason: `No active ${provider} account found (stored status: ${row.status})`,
      };
    }

    // These branches mirror getValidAccessToken exactly, in its order.
    //
    // It refreshes if and only if pendingRefreshToken returns one. The stored
    // token is then not what the next call sends, and a refresh can fail, so no
    // usable token can be promised without performing one.
    if (pendingRefreshToken(row.expires_at, row.refresh_token)) {
      return {
        ...base,
        state: 'refresh_required',
        reason: `Access token expires at ${row.expires_at}; the next call must refresh it first, and that refresh may fail`,
      };
    }

    // Otherwise it hands back the stored token untouched — which works right up
    // until expiry, and is rejected by the provider after it.
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
    if (expiresAt !== null && expiresAt <= Date.now()) {
      return {
        ...base,
        state: 'unusable',
        reason: 'Access token expired and no refresh token is stored',
      };
    }

    return { ...base, state: 'active', reason: null };
  }

  /**
   * Get a valid access token, refreshing if necessary.
   *
   * For Google, the configured credential sources are tried in order and the
   * first one that yields a token wins. A source with nothing bound to the user
   * is silently skipped; a source that HAD a credential and failed is named in
   * the error, so "the cloud row expired and the desktop file was refused" reads
   * as exactly that. A user with no desktop file sees the message they always
   * saw.
   */
  async getValidAccessToken(
    userId: string,
    provider: string,
    workspaceId?: string | null
  ): Promise<string> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    if (!this.usesDesktopSource(provider)) {
      const cloud = await this.getCloudAccessToken(userId, provider, resolvedWorkspaceId);
      if (cloud.token !== null) return cloud.token;
      throw new Error(cloud.reason);
    }

    const failures: string[] = [];
    let cloudReason: string | null = null;
    for (const source of this.sources) {
      if (source === 'cloud') {
        const cloud = await this.getCloudAccessToken(userId, provider, resolvedWorkspaceId);
        if (cloud.token !== null) return cloud.token;
        cloudReason = cloud.reason;
        failures.push(`cloud: ${cloud.reason}`);
      } else {
        const desktop = await this.getDesktopAccessToken(userId);
        if (desktop.token !== null) return desktop.token;
        if (desktop.reason) failures.push(`desktop: ${desktop.reason}`);
      }
    }
    if (failures.length === 1 && cloudReason) throw new Error(cloudReason);
    if (failures.length === 0) throw new Error(`No active ${provider} account found`);
    throw new Error(`No usable ${provider} credential — ${failures.join('; ')}`);
  }

  /**
   * The desktop file bound to this user, as a token — or why not. A null reason
   * means nothing was bound; a failed lookup or unreadable storage binds
   * nothing too (fail closed) and is logged rather than named here, because
   * naming it would change the message users without a desktop file see.
   */
  private async getDesktopAccessToken(
    userId: string
  ): Promise<{ token: string } | { token: null; reason: string | null }> {
    const lookup = await this.lookupUserEmail(userId);
    if (lookup.error) return { token: null, reason: null };
    const found = await this.desktopStore.findForEmail(lookup.email);
    if (found.error || !found.record) return { token: null, reason: null };
    try {
      return { token: await this.desktopStore.getAccessToken(found.record) };
    } catch (err) {
      return { token: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Desktop credentials bound to this user — the ones a call could actually
   * use. Files for other emails are not listed: they belong to other people.
   */
  async describeDesktopCredentials(userId: string): Promise<{
    dir: string;
    email: string | null;
    /** Why the listing could not be trusted, when it could not (lookup or storage failure). */
    error: string | null;
    credentials: Array<{
      email: string;
      path: string;
      scopes: string[];
      obtainedAt: string | null;
      state: 'active' | 'refresh_required' | 'unusable';
      reason: string | null;
      expiresAt: string | null;
    }>;
  }> {
    const lookup = await this.lookupUserEmail(userId);
    if (lookup.error) {
      return { dir: this.desktopStore.dir, email: null, error: lookup.error, credentials: [] };
    }
    const found = await this.desktopStore.findForEmail(lookup.email);
    const record = found.record;
    const credentials = record
      ? [
          {
            email: record.email,
            path: record.path,
            scopes: record.scopes,
            obtainedAt: record.obtainedAt,
            ...this.desktopStore.inspect(record),
          },
        ]
      : [];
    return { dir: this.desktopStore.dir, email: lookup.email, error: found.error, credentials };
  }

  private async getCloudAccessToken(
    userId: string,
    provider: string,
    resolvedWorkspaceId: string | null | undefined
  ): Promise<{ token: string; reason?: undefined } | { token: null; reason: string }> {
    interface CloudAccountRow {
      id: string;
      access_token: string;
      refresh_token: string | null;
      expires_at: string | null;
    }
    let query = this.supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('status', 'active');

    if (resolvedWorkspaceId === null) {
      query = query.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const result = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const account = result.data as CloudAccountRow | null;

    if (result.error || !account) {
      return { token: null, reason: `No active ${provider} account found` };
    }

    // Shared with inspectAccountHealth so the health verdict describes the same
    // decision this call actually makes.
    const refreshToken = pendingRefreshToken(account.expires_at, account.refresh_token);

    if (!refreshToken) {
      // Nothing to refresh with. A stored token past its expiry is not a
      // token — handing it back would fail at the provider AND stop the next
      // credential source from being tried, while inspectAccountHealth calls
      // this row unusable (Lumen, PR #588). Mark it so the dashboard agrees.
      const expiry = account.expires_at ? new Date(account.expires_at).getTime() : null;
      if (expiry !== null && !Number.isNaN(expiry) && expiry <= Date.now()) {
        const reason = 'Access token expired and no refresh token is stored';
        await this.supabase
          .from('connected_accounts')
          .update({ status: 'expired', last_error: reason, updated_at: new Date().toISOString() })
          .eq('id', account.id);
        return { token: null, reason };
      }
    }

    if (refreshToken) {
      logger.info(`Refreshing ${provider} token for user ${userId}`);

      try {
        const tokens = await this.refreshAccessToken(provider, refreshToken);

        // Update stored tokens
        const newExpiresAt = tokens.expiresIn
          ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
          : null;

        await this.supabase
          .from('connected_accounts')
          .update({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken || account.refresh_token,
            expires_at: newExpiresAt,
            status: 'active',
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', account.id);

        return { token: tokens.accessToken };
      } catch (err) {
        // Mark account as expired
        await this.supabase
          .from('connected_accounts')
          .update({
            status: 'expired',
            last_error: err instanceof Error ? err.message : 'Token refresh failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', account.id);

        return { token: null, reason: `Failed to refresh ${provider} token` };
      }
    }

    // Update last used
    await this.supabase
      .from('connected_accounts')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', account.id);

    return { token: account.access_token };
  }

  /**
   * Disconnect (revoke) a connected account
   */
  async disconnectAccount(
    accountId: string,
    userId: string,
    workspaceId?: string | null
  ): Promise<void> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);

    // First get the account to revoke the token
    let accountQuery = this.supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId);

    if (resolvedWorkspaceId === null) {
      accountQuery = accountQuery.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      accountQuery = accountQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data: account } = await accountQuery.single();

    if (!account) {
      throw new Error('Account not found');
    }

    // Try to revoke the token at the provider
    const config = OAUTH_PROVIDERS[account.provider];
    if (config?.revokeUrl && account.access_token) {
      try {
        await fetch(`${config.revokeUrl}?token=${account.access_token}`, {
          method: 'POST',
        });
      } catch (err) {
        logger.warn(`Failed to revoke token at provider:`, err);
        // Continue even if revocation fails
      }
    }

    // Delete the account record
    let deleteQuery = this.supabase
      .from('connected_accounts')
      .delete()
      .eq('id', accountId)
      .eq('user_id', userId);

    if (resolvedWorkspaceId === null) {
      deleteQuery = deleteQuery.is('workspace_id', null);
    } else if (resolvedWorkspaceId) {
      deleteQuery = deleteQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { error } = await deleteQuery;

    if (error) {
      throw new Error('Failed to disconnect account');
    }
  }

  /**
   * Check if a provider is configured
   */
  isProviderConfigured(provider: string): boolean {
    const config = OAUTH_PROVIDERS[provider];
    return !!(config && config.clientId && config.clientSecret);
  }

  /**
   * Get list of supported providers
   */
  getSupportedProviders(): string[] {
    return Object.keys(OAUTH_PROVIDERS);
  }

  private mapToConnectedAccount(row: Record<string, unknown>): ConnectedAccount {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      workspaceId: (row.workspace_id as string) ?? null,
      provider: row.provider as string,
      providerAccountId: row.provider_account_id as string,
      email: row.email as string | null,
      displayName: row.display_name as string | null,
      avatarUrl: row.avatar_url as string | null,
      scopes: (row.scopes as string[]) || [],
      status: row.status as 'active' | 'expired' | 'revoked' | 'error',
      lastError: row.last_error as string | null,
      lastUsedAt: row.last_used_at as string | null,
      expiresAt: row.expires_at as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// Singleton instance
let oauthService: OAuthService | null = null;

export function getOAuthService(): OAuthService {
  if (!oauthService) {
    oauthService = new OAuthService();
  }
  return oauthService;
}

/** Test seam: replace the process-wide service. */
export function setOAuthService(next: OAuthService | null): void {
  oauthService = next;
}

export { OAuthService };
