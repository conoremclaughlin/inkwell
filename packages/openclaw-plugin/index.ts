/**
 * OpenClaw PCP Plugin
 *
 * Integrates Personal Context Protocol with OpenClaw.
 * Auto-injects PCP identity context on agent start and
 * ends PCP sessions on agent completion.
 *
 * Config:
 *   serverUrl     - PCP server URL (default: http://localhost:3001)
 *   accessToken   - PCP access token (or reads from ~/.pcp/auth.json)
 *   agentId       - Agent identity (or reads from ~/.pcp/config.json)
 *   autoBootstrap - Inject identity context before each turn (default: true)
 *   autoSessionEnd - End PCP session on agent_end (default: true)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

// ============================================================================
// Types
// ============================================================================

interface PcpConfig {
  serverUrl: string;
  accessToken?: string;
  agentId?: string;
  autoBootstrap: boolean;
  autoSessionEnd: boolean;
}

interface PcpUserConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
}

interface PcpAuthConfig {
  accessToken?: string;
}

interface BootstrapResponse {
  // Constitution documents (merged: Supabase priority, local fallback)
  identityFiles?: {
    self?: string;
    soul?: string;
    heartbeat?: string;
    values?: string;
    process?: string;
    user?: string;
  };
  // Knowledge summary: budget-constrained, grouped by topic
  knowledgeSummary?: string | null;
  // Topic index: all topics with counts + recency
  topicIndex?: Array<{ topic: string; count: number }> | null;
  // User info including timezone
  user?: { timezone?: string };
}

// ============================================================================
// Config Resolution
// ============================================================================

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function resolveAgentId(pluginAgentId?: string): string | null {
  if (pluginAgentId) return pluginAgentId;

  // Check ~/.pcp/config.json agentMapping
  const config = readJsonFile<PcpUserConfig>(join(homedir(), '.pcp', 'config.json'));
  if (config?.agentMapping?.openclaw) return config.agentMapping.openclaw;

  // Fall back to first mapping
  if (config?.agentMapping) {
    const ids = Object.values(config.agentMapping);
    if (ids.length > 0) return ids[0];
  }

  return null;
}

function resolveAccessToken(pluginToken?: string): string | null {
  if (pluginToken) return pluginToken;

  // Check PCP_ACCESS_TOKEN env var
  if (process.env.PCP_ACCESS_TOKEN) return process.env.PCP_ACCESS_TOKEN;

  // Check ~/.pcp/auth.json
  const auth = readJsonFile<PcpAuthConfig>(join(homedir(), '.pcp', 'auth.json'));
  return auth?.accessToken ?? null;
}

function resolveUserId(): string | null {
  const config = readJsonFile<PcpUserConfig>(join(homedir(), '.pcp', 'config.json'));
  return config?.userId ?? null;
}

// ============================================================================
// PCP API Client
// ============================================================================

class PcpClient {
  constructor(
    private serverUrl: string,
    private accessToken: string
  ) {}

  /**
   * Call a PCP MCP tool via the HTTP transport.
   * Uses the JSON-RPC format expected by the MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const url = `${this.serverUrl}/mcp`;
    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`PCP API error: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    // Handle SSE (Streamable HTTP transport)
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      // Parse last SSE data line containing the result
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('data: ')) {
          const data = JSON.parse(lines[i].slice(6));
          if (data.result?.content?.[0]?.text) {
            return JSON.parse(data.result.content[0].text);
          }
          return data.result;
        }
      }
      return null;
    }

    // Handle plain JSON response
    const data = await response.json();
    if (data.result?.content?.[0]?.text) {
      return JSON.parse(data.result.content[0].text);
    }
    return data.result;
  }
}

// ============================================================================
// Context Formatting
// ============================================================================

function formatBootstrapContext(bootstrap: BootstrapResponse, agentId: string): string {
  const sections: string[] = [];

  sections.push(`<pcp-context agentId="${agentId}">`);

  // Constitution: identity (self), values, soul
  if (bootstrap.identityFiles?.self) {
    sections.push(`<identity>\n${truncate(bootstrap.identityFiles.self, 2000)}\n</identity>`);
  }

  if (bootstrap.identityFiles?.values) {
    sections.push(`<values>\n${truncate(bootstrap.identityFiles.values, 1500)}\n</values>`);
  }

  if (bootstrap.identityFiles?.soul) {
    sections.push(`<soul>\n${truncate(bootstrap.identityFiles.soul, 1000)}\n</soul>`);
  }

  // Knowledge summary (pre-formatted by PCP, grouped by topic)
  if (bootstrap.knowledgeSummary) {
    sections.push(
      `<knowledge-summary>\n${truncate(bootstrap.knowledgeSummary, 3000)}\n</knowledge-summary>`
    );
  }

  if (bootstrap.user?.timezone) {
    sections.push(`<timezone>${bootstrap.user.timezone}</timezone>`);
  }

  sections.push('</pcp-context>');

  return sections.join('\n\n');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

// ============================================================================
// Plugin Entry
// ============================================================================

export default function pcpPlugin(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as Partial<PcpConfig>;

  const serverUrl = pluginConfig.serverUrl ?? 'http://localhost:3001';
  const autoBootstrap = pluginConfig.autoBootstrap ?? true;
  const autoSessionEnd = pluginConfig.autoSessionEnd ?? true;

  const agentId = resolveAgentId(pluginConfig.agentId);
  const accessToken = resolveAccessToken(pluginConfig.accessToken);

  if (!accessToken) {
    api.logger.warn(
      'pcp: no access token found. Set plugins.entries.pcp.config.accessToken, ' +
        "PCP_ACCESS_TOKEN env var, or run 'sb login'. PCP hooks disabled."
    );
    return;
  }

  if (!agentId) {
    api.logger.warn(
      'pcp: no agent ID resolved. Set plugins.entries.pcp.config.agentId ' +
        'or add an openclaw entry to ~/.pcp/config.json agentMapping. PCP hooks disabled.'
    );
    return;
  }

  const userId = resolveUserId();
  const client = new PcpClient(serverUrl, accessToken);

  api.logger.info?.(`pcp: initialized (agent=${agentId}, server=${serverUrl})`);

  // --------------------------------------------------------------------------
  // Hook: auto-bootstrap — inject PCP identity context before each agent turn
  // --------------------------------------------------------------------------

  if (autoBootstrap) {
    api.on('before_prompt_build', async () => {
      try {
        const result = (await client.callTool('bootstrap', {
          ...(userId ? { userId } : {}),
          agentId,
        })) as BootstrapResponse | null;

        if (!result) {
          api.logger.warn('pcp: bootstrap returned no data');
          return;
        }

        const context = formatBootstrapContext(result, agentId);
        api.logger.info?.(`pcp: injected ${context.length} chars of identity context`);

        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`pcp: bootstrap failed: ${String(err)}`);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Hook: auto-session-end — end PCP session when agent turn completes
  // --------------------------------------------------------------------------

  if (autoSessionEnd) {
    api.on('agent_end', async (event) => {
      try {
        await client.callTool('end_session', {
          ...(userId ? { userId } : {}),
          agentId,
          summary: event.success
            ? `Agent turn completed (${event.durationMs ? Math.round(event.durationMs / 1000) + 's' : 'unknown duration'})`
            : `Agent turn failed: ${event.error ?? 'unknown error'}`,
        });
        api.logger.info?.('pcp: session ended');
      } catch (err) {
        // Fire-and-forget — don't block agent completion
        api.logger.warn(`pcp: end_session failed: ${String(err)}`);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Tool: pcp_status — quick check of PCP connectivity and identity
  // --------------------------------------------------------------------------

  api.registerTool({
    name: 'pcp_status',
    label: 'PCP Status',
    description: 'Check PCP server connectivity and your agent identity',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    async execute() {
      try {
        const result = (await client.callTool('get_identity', {
          agentId,
          file: 'identity',
        })) as { content?: string } | null;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  connected: true,
                  server: serverUrl,
                  agentId,
                  identityLoaded: !!result?.content,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  connected: false,
                  server: serverUrl,
                  agentId,
                  error: String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    },
  });
}
