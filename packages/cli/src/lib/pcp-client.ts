import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getValidAccessToken } from '../auth/tokens.js';

export interface PcpToolCallResult {
  [key: string]: unknown;
}

export interface PcpAuthConfig {
  userId?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  clientId?: string;
  mcpClientId?: string;
  oauthClientId?: string;
}

interface JsonRpcToolResult {
  content?: Array<{ type?: string; text?: string }>;
  /** MCP's per-call failure flag — set for validation errors, unknown tools, thrown handlers. */
  isError?: boolean;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  result?: JsonRpcToolResult;
  error?: { code?: number; message?: string };
}

let jsonRpcId = 1;

/**
 * Bound every MCP network call so a stalled connection fails fast instead of
 * hanging the whole turn. On a flaky link (e.g. a phone hotspot) a bare
 * `fetch` has no client-side deadline — we observed a single `get_inbox` call
 * hang for ~159s before the OS gave up, stalling the turn behind it. A 30s
 * ceiling turns that silent hang into a fast, retryable error. Override with
 * INK_MCP_TIMEOUT_MS.
 */
const MCP_FETCH_TIMEOUT_MS = parseInt(process.env.INK_MCP_TIMEOUT_MS || '', 10) || 30_000;

/**
 * Tool-call tier — some MCP tools legitimately run for minutes (e.g.
 * setup_audio_transcription downloads ~600MB). Tool execution uses this
 * generous ceiling; auth and metadata calls use MCP_FETCH_TIMEOUT_MS above.
 * Override with INK_MCP_TOOL_TIMEOUT_MS.
 */
const MCP_TOOL_TIMEOUT_MS =
  parseInt(process.env.INK_MCP_TOOL_TIMEOUT_MS || '', 10) || 5 * 60 * 1000;

/**
 * `fetch` with an abort-based deadline. Translates the abort into a clear,
 * actionable error so callers surface "timed out" rather than a raw
 * DOMException. Never overrides a caller-supplied signal.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = MCP_FETCH_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `PCP request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s (network stalled?)`
      );
    }
    throw err;
  }
}

export interface PcpClientOptions {
  /**
   * Lazily builds the x-ink-context token attached to every tool call.
   * Lazy because session identity (sessionId) is established after client
   * construction; the callback reflects current runtime state per call.
   *
   * Without this header, ink-routed tool calls reach the server with NO
   * request identity — workspace derivation for artifact writes fails,
   * session attribution degrades, and trigger context goes missing (the
   * regression Myra hit when wholly-in-ink moved tool calls off the
   * provider's MCP connection, which carried the header via .mcp.json).
   */
  getContextToken?: () => string | null;
}

export class PcpClient {
  private configPath: string;
  private baseUrl: string;
  private config: PcpAuthConfig;
  private options: PcpClientOptions;

  constructor(baseUrl?: string, configPath?: string, options: PcpClientOptions = {}) {
    this.baseUrl = (baseUrl || process.env.INK_SERVER_URL || 'http://localhost:3001').replace(
      /\/+$/,
      ''
    );
    this.configPath = configPath || join(homedir(), '.ink', 'config.json');
    this.config = this.loadConfig();
    this.options = options;
  }

  /** Identity context header for the current call, when the caller provides one. */
  private contextHeader(): Record<string, string> {
    const token = this.options.getContextToken?.();
    return token ? { 'x-ink-context': token } : {};
  }

  public getConfig(): PcpAuthConfig {
    return { ...this.config };
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public reloadConfig(): PcpAuthConfig {
    this.config = this.loadConfig();
    return { ...this.config };
  }

  public async callTool(tool: string, args: Record<string, unknown>): Promise<PcpToolCallResult> {
    // Prefer authenticated /mcp JSON-RPC whenever possible.
    const result = await this.callToolJsonRpc(tool, args);
    if (result) {
      return result;
    }

    // callToolJsonRpc returns null in two cases: no access token, or the
    // server doesn't serve /mcp. Surface the auth case directly — falling
    // through to the legacy endpoint just produces a misleading 404.
    this.reloadConfig();
    const hasToken = Boolean(await this.ensureAccessToken());
    if (!hasToken) {
      throw new Error(
        `Not authenticated with PCP server at ${this.baseUrl} (no ~/.ink/auth.json token).\n` +
          `Run: INK_SERVER_URL=${this.baseUrl} ink auth login`
      );
    }

    // Fallback for local/dev flows.
    try {
      return await this.callToolLegacy(tool, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('Cannot POST /api/mcp/call') ||
        message.includes('legacy tool call failed (404)')
      ) {
        throw new Error(
          `PCP server at ${this.baseUrl} does not expose legacy /api/mcp/call.\n` +
            `Run 'ink auth login' and ensure INK_SERVER_URL points to the same server.\n` +
            `Original error: ${message}`
        );
      }
      throw error;
    }
  }

  private loadConfig(): PcpAuthConfig {
    if (!existsSync(this.configPath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8')) as PcpAuthConfig;
    } catch {
      return {};
    }
  }

  private saveConfig(next: PcpAuthConfig): void {
    this.config = next;
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n');
    } catch {
      // Non-fatal: keep in-memory config.
    }
  }

  private getClientId(): string | undefined {
    return this.config.clientId || this.config.mcpClientId || this.config.oauthClientId;
  }

  private isTokenExpiredSkewed(tokenExpiresAt?: string): boolean {
    if (!tokenExpiresAt) return true;
    const expiresAtMs = Date.parse(tokenExpiresAt);
    if (Number.isNaN(expiresAtMs)) return true;
    // Refresh 60s early.
    return expiresAtMs <= Date.now() + 60_000;
  }

  private async ensureAccessToken(): Promise<string | null> {
    // Primary source: ~/.ink/auth.json from ink auth login.
    const authToken = await getValidAccessToken(this.baseUrl);
    if (authToken) {
      return authToken;
    }

    // Secondary source: legacy config.json token fields.
    if (this.config.accessToken && !this.isTokenExpiredSkewed(this.config.tokenExpiresAt)) {
      return this.config.accessToken;
    }

    const refreshed = await this.refreshAccessToken();
    return refreshed?.accessToken || this.config.accessToken || null;
  }

  private async refreshAccessToken(): Promise<{
    accessToken: string;
    tokenExpiresAt: string;
  } | null> {
    if (!this.config.refreshToken) return null;

    const clientId = this.getClientId();
    if (!clientId) return null;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
      client_id: clientId,
    });

    const response = await fetchWithTimeout(`${this.baseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!payload.access_token) {
      return null;
    }

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const next: PcpAuthConfig = {
      ...this.config,
      accessToken: payload.access_token,
      tokenExpiresAt,
      refreshToken: payload.refresh_token || this.config.refreshToken,
    };
    this.saveConfig(next);

    return { accessToken: payload.access_token, tokenExpiresAt };
  }

  private parseJsonRpcToolPayload(payload: JsonRpcResponse): PcpToolCallResult {
    if (payload.error) {
      throw new Error(`PCP tool error (${payload.error.code}): ${payload.error.message}`);
    }

    const toolResult = payload.result;
    const firstText = toolResult?.content?.find((item) => typeof item.text === 'string')?.text;
    if (typeof firstText === 'string') {
      try {
        return JSON.parse(firstText) as PcpToolCallResult;
      } catch {
        // Unparseable text on an isError result is a protocol-level failure —
        // argument validation, an unknown tool, a thrown handler. The server
        // reports these as `isError` with a bare message rather than the usual
        // JSON envelope, and returning `{ text }` here made them indistinguishable
        // from success: callers read a result object with no `sessions` key and
        // concluded there were no sessions. Throw so a failed call fails.
        //
        // Structured `{"success":false,...}` bodies deliberately do NOT come
        // through here — they parse as JSON above and keep their existing
        // contract, because callers inspect `success` and expect to.
        if (toolResult?.isError) {
          throw new Error(`PCP tool call failed: ${firstText}`);
        }
        return { text: firstText };
      }
    }

    // CallToolResult content is not restricted to text. Preserve the failure
    // boundary even when an error contains only media (or no content at all),
    // rather than returning the raw isError object as a successful result.
    if (toolResult?.isError) {
      throw new Error('PCP tool call failed without a text error message');
    }

    return (toolResult as PcpToolCallResult) || {};
  }

  private parseSseJsonRpcResponse(raw: string): JsonRpcResponse {
    const lines = raw.split(/\r?\n/);
    const events: string[] = [];
    let currentData: string[] = [];

    const flush = () => {
      if (currentData.length > 0) {
        events.push(currentData.join('\n'));
        currentData = [];
      }
    };

    for (const line of lines) {
      if (line.trim() === '') {
        flush();
        continue;
      }
      if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trimStart());
      }
    }
    flush();

    for (let i = events.length - 1; i >= 0; i -= 1) {
      const chunk = events[i]?.trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        return JSON.parse(chunk) as JsonRpcResponse;
      } catch {
        // Keep scanning previous events.
      }
    }

    const preview = raw.replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`Unable to parse JSON-RPC response from SSE payload: ${preview}`);
  }

  private parseJsonRpcResponse(raw: string): JsonRpcResponse {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Empty JSON-RPC response body');
    }

    // Some streamable HTTP servers return SSE framing for POST responses.
    if (
      trimmed.startsWith('event:') ||
      trimmed.startsWith('data:') ||
      /\n\s*event:/.test(trimmed) ||
      /\n\s*data:/.test(trimmed)
    ) {
      return this.parseSseJsonRpcResponse(trimmed);
    }

    return JSON.parse(trimmed) as JsonRpcResponse;
  }

  private async callToolJsonRpc(
    tool: string,
    args: Record<string, unknown>
  ): Promise<PcpToolCallResult | null> {
    // Pick up user/email and any legacy token updates.
    this.reloadConfig();
    const token = await this.ensureAccessToken();
    if (!token) return null;

    const call = async (accessToken: string): Promise<Response> =>
      fetchWithTimeout(
        `${this.baseUrl}/mcp`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Streamable HTTP MCP servers may require clients to accept both
            // JSON responses and SSE frames.
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${accessToken}`,
            ...this.contextHeader(),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: tool, arguments: args },
            id: jsonRpcId++,
          }),
        },
        MCP_TOOL_TIMEOUT_MS
      );

    let response = await call(token);

    // If the first credential was the injected env token and it was rejected,
    // retry with the local auth.json token before giving up (mirrors the
    // fallback in hooks.ts callPcpTool). Stale env tokens outlive their expiry
    // in long-running agent sessions and would otherwise 401 forever.
    if (response.status === 401 && process.env.INK_ACCESS_TOKEN?.trim() === token) {
      const localToken = await getValidAccessToken(this.baseUrl, { allowEnvToken: false });
      if (localToken && localToken !== token) {
        try {
          await response.text();
        } catch {
          // Best-effort body drain before retry.
        }
        response = await call(localToken);
      }
    }

    if (response.status === 401 && this.config.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed?.accessToken) {
        response = await call(refreshed.accessToken);
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const bodySnippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `PCP MCP auth failed (${response.status}) at ${this.baseUrl}/mcp.\n` +
            `Run: INK_SERVER_URL=${this.baseUrl} ink auth login\n` +
            (bodySnippet ? `Server response: ${bodySnippet}` : '')
        );
      }

      // Fall back to legacy endpoint only when /mcp is unavailable.
      if (response.status === 404 || response.status === 405) {
        return null;
      }

      throw new Error(
        `PCP MCP call failed (${response.status}) at ${this.baseUrl}/mcp` +
          (bodySnippet ? `: ${bodySnippet}` : '')
      );
    }

    const rawBody = await response.text();
    const payload = this.parseJsonRpcResponse(rawBody);
    return this.parseJsonRpcToolPayload(payload);
  }

  private async callToolLegacy(
    tool: string,
    args: Record<string, unknown>
  ): Promise<PcpToolCallResult> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/mcp/call`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.contextHeader(),
        },
        body: JSON.stringify({ tool, args }),
      },
      MCP_TOOL_TIMEOUT_MS
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PCP legacy tool call failed (${response.status}): ${text}`);
    }

    return (await response.json()) as PcpToolCallResult;
  }
}
