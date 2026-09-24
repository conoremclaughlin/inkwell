/**
 * OpenClaw Inkwell Plugin
 *
 * Integrates Inkwell with OpenClaw.
 * Auto-injects Inkwell identity context on agent start and
 * ends Inkwell sessions on agent completion.
 *
 * Config:
 *   serverUrl     - Inkwell server URL (default: http://localhost:3001)
 *   accessToken   - Inkwell access token (or reads from ~/.ink/auth.json)
 *   sbSlug       - Agent identity (or reads from ~/.ink/config.json)
 *   autoBootstrap - Inject identity context before each turn (default: true)
 *   autoSessionEnd - End Inkwell session on agent_end (default: true)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

// ============================================================================
// Types
// ============================================================================

interface InkUserConfig {
  serverUrl: string;
  accessToken?: string;
  sbSlug?: string;
  /** Pre-rename name for sbSlug, still present in users' OpenClaw configs. */
  agentId?: string;
  autoBootstrap: boolean;
  autoSessionEnd: boolean;
}

interface InkUserConfig {
  userId?: string;
  email?: string;
  sbMapping?: Record<string, string>;
  /** Pre-rename name for sbMapping. ~/.ink/config.json is the user's file; nothing rewrites it. */
  agentMapping?: Record<string, string>;
}

interface InkAuthConfig {
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

/** Exported so the identity-compat regression exercises THIS resolver, not a copy. */
export function resolveSlug(pluginSlug?: string): string | null {
  if (pluginSlug) return pluginSlug;

  // Check ~/.ink/config.json sbMapping (agentMapping is its pre-rename name)
  const config = readJsonFile<InkUserConfig>(join(homedir(), '.ink', 'config.json'));
  const mapping = config?.sbMapping || config?.agentMapping;
  if (mapping?.openclaw) return mapping.openclaw;

  // Fall back to first mapping
  if (mapping) {
    const ids = Object.values(mapping);
    if (ids.length > 0) return ids[0];
  }

  return null;
}

function resolveAccessToken(pluginToken?: string): string | null {
  if (pluginToken) return pluginToken;

  // Check INK_ACCESS_TOKEN env var
  if (process.env.INK_ACCESS_TOKEN) return process.env.INK_ACCESS_TOKEN;

  // Check ~/.ink/auth.json
  const auth = readJsonFile<InkAuthConfig>(join(homedir(), '.ink', 'auth.json'));
  return auth?.accessToken ?? null;
}

function resolveUserId(): string | null {
  const config = readJsonFile<InkUserConfig>(join(homedir(), '.ink', 'config.json'));
  return config?.userId ?? null;
}

// ============================================================================
// Inkwell API Client
// ============================================================================

class InkClient {
  constructor(
    private serverUrl: string,
    private accessToken: string
  ) {}

  /**
   * Call a Inkwell MCP tool via the HTTP transport.
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
      throw new Error(`Inkwell API error: ${response.status} ${response.statusText}`);
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

function formatBootstrapContext(bootstrap: BootstrapResponse, sbSlug: string): string {
  const sections: string[] = [];

  sections.push(`<inkwell-context sbSlug="${sbSlug}">`);

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

  // Knowledge summary (pre-formatted by Inkwell, grouped by topic)
  if (bootstrap.knowledgeSummary) {
    sections.push(
      `<knowledge-summary>\n${truncate(bootstrap.knowledgeSummary, 3000)}\n</knowledge-summary>`
    );
  }

  if (bootstrap.user?.timezone) {
    sections.push(`<timezone>${bootstrap.user.timezone}</timezone>`);
  }

  sections.push('</inkwell-context>');

  return sections.join('\n\n');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

// ============================================================================
// Plugin Entry
// ============================================================================

export default function inkPlugin(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as Partial<InkUserConfig>;

  const serverUrl = pluginConfig.serverUrl ?? 'http://localhost:3001';
  const autoBootstrap = pluginConfig.autoBootstrap ?? true;
  const autoSessionEnd = pluginConfig.autoSessionEnd ?? true;

  // Accept the pre-rename key: the manifest still declares it because nothing
  // rewrites a user's OpenClaw config, and reading only sbSlug would silently
  // drop a working configured identity (Lumen, PR #635). We only ever WRITE sbSlug.
  const sbSlug = resolveSlug(pluginConfig.sbSlug ?? pluginConfig.agentId);
  const accessToken = resolveAccessToken(pluginConfig.accessToken);

  if (!accessToken) {
    api.logger.warn(
      'inkwell: no access token found. Set plugins.entries.pcp.config.accessToken, ' +
        "INK_ACCESS_TOKEN env var, or run 'sb login'. Inkwell hooks disabled."
    );
    return;
  }

  if (!sbSlug) {
    api.logger.warn(
      'inkwell: no SB slug resolved. Set plugins.entries.pcp.config.sbSlug ' +
        'or add an openclaw entry to ~/.ink/config.json sbMapping. Inkwell hooks disabled.'
    );
    return;
  }

  const userId = resolveUserId();
  const client = new InkClient(serverUrl, accessToken);

  api.logger.info?.(`inkwell: initialized (agent=${sbSlug}, server=${serverUrl})`);

  // --------------------------------------------------------------------------
  // Hook: auto-bootstrap — inject Inkwell identity context before each agent turn
  // --------------------------------------------------------------------------

  if (autoBootstrap) {
    api.on('before_prompt_build', async () => {
      try {
        const result = (await client.callTool('bootstrap', {
          ...(userId ? { userId } : {}),
          sbSlug,
        })) as BootstrapResponse | null;

        if (!result) {
          api.logger.warn('inkwell: bootstrap returned no data');
          return;
        }

        const context = formatBootstrapContext(result, sbSlug);
        api.logger.info?.(`inkwell: injected ${context.length} chars of identity context`);

        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`inkwell: bootstrap failed: ${String(err)}`);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Hook: auto-session-end — end Inkwell session when agent turn completes
  // --------------------------------------------------------------------------

  if (autoSessionEnd) {
    api.on('agent_end', async (event) => {
      try {
        await client.callTool('end_session', {
          ...(userId ? { userId } : {}),
          sbSlug,
          summary: event.success
            ? `Agent turn completed (${event.durationMs ? Math.round(event.durationMs / 1000) + 's' : 'unknown duration'})`
            : `Agent turn failed: ${event.error ?? 'unknown error'}`,
        });
        api.logger.info?.('inkwell: session ended');
      } catch (err) {
        // Fire-and-forget — don't block agent completion
        api.logger.warn(`inkwell: end_session failed: ${String(err)}`);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Tool: ink_status — quick check of Inkwell connectivity and identity
  // --------------------------------------------------------------------------

  api.registerTool({
    name: 'ink_status',
    label: 'Inkwell Status',
    description: 'Check Inkwell server connectivity and your agent identity',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    async execute() {
      try {
        const result = (await client.callTool('get_identity', {
          sbSlug,
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
                  sbSlug,
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
                  sbSlug,
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
