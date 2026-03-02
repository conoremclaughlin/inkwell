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
  [key: string]: unknown;
}

interface JsonRpcResponse {
  result?: JsonRpcToolResult;
  error?: { code?: number; message?: string };
}

let jsonRpcId = 1;

export class PcpClient {
  private configPath: string;
  private baseUrl: string;
  private config: PcpAuthConfig;

  constructor(baseUrl?: string, configPath?: string) {
    this.baseUrl = (baseUrl || process.env.PCP_SERVER_URL || 'http://localhost:3001').replace(
      /\/+$/,
      ''
    );
    this.configPath = configPath || join(homedir(), '.pcp', 'config.json');
    this.config = this.loadConfig();
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

    // Fallback for local/dev flows.
    try {
      return await this.callToolLegacy(tool, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Cannot POST /api/mcp/call') || message.includes('legacy tool call failed (404)')) {
        throw new Error(
          `PCP server at ${this.baseUrl} does not expose legacy /api/mcp/call.\n` +
            `Run 'sb auth login' and ensure PCP_SERVER_URL points to the same server.\n` +
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
    // Primary source: ~/.pcp/auth.json from sb auth login.
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

  private async refreshAccessToken(): Promise<
    { accessToken: string; tokenExpiresAt: string } | null
  > {
    if (!this.config.refreshToken) return null;

    const clientId = this.getClientId();
    if (!clientId) return null;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
      client_id: clientId,
    });

    const response = await fetch(`${this.baseUrl}/token`, {
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
    const firstText = toolResult?.content?.[0]?.text;
    if (typeof firstText === 'string') {
      try {
        return JSON.parse(firstText) as PcpToolCallResult;
      } catch {
        return { text: firstText };
      }
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
      fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Streamable HTTP MCP servers may require clients to accept both
          // JSON responses and SSE frames.
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: tool, arguments: args },
          id: jsonRpcId++,
        }),
      });

    let response = await call(token);

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
            `Run: PCP_SERVER_URL=${this.baseUrl} sb auth login\n` +
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
    const response = await fetch(`${this.baseUrl}/api/mcp/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ tool, args }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PCP legacy tool call failed (${response.status}): ${text}`);
    }

    return (await response.json()) as PcpToolCallResult;
  }
}
