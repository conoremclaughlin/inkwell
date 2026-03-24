/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildIdentityPrompt } from './identity.js';
import { buildMergedMcpConfig } from '../lib/skill-mcp.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

/**
 * Check if the PCP channel plugin is registered in .mcp.json.
 * If present, Claude Code should be started with --dangerously-load-development-channels
 * so it accepts push notifications from the channel.
 */
function hasPcpChannelPlugin(cwd: string): boolean {
  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) return false;
  try {
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    return Boolean(config?.mcpServers?.['pcp-channel']);
  } catch {
    return false;
  }
}

export class ClaudeAdapter implements BackendAdapter {
  readonly name = 'claude';
  readonly binary = 'claude';

  prepare(config: BackendConfig): PreparedBackend {
    const identityPrompt = buildIdentityPrompt(config.agentId);

    const args: string[] = [];

    // Prompt mode vs interactive
    if (config.prompt) {
      args.push('-p');
      // Claude expects print prompt immediately after -p/--print.
      args.push(config.prompt);
    }

    // Model (only if explicitly specified)
    if (config.model) {
      args.push('--model', config.model);
    }

    // Identity (inline text, no temp file needed)
    args.push('--append-system-prompt', identityPrompt);

    // Session routing
    if (config.backendSessionId) {
      args.push('--resume', config.backendSessionId);
    } else if (config.backendSessionSeedId) {
      args.push('--session-id', config.backendSessionSeedId);
    }

    // MCP config: merge project .mcp.json with skill-provided MCP servers.
    // Pass pcpSessionId/studioId explicitly — process.env doesn't have them yet
    // (they're set in the spawn env below, not in the sb CLI's own env).
    const { mcpConfigPath, cleanup: mcpCleanup } = buildMergedMcpConfig(process.cwd(), {
      pcpSessionId: config.pcpSessionId,
      studioId: config.studioId,
    });
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    // Auto-approve: skip all permission prompts
    if (config.dangerous) {
      args.push('--dangerously-skip-permissions');
    }

    // PCP channel plugin: enable real-time inbox push notifications.
    // The channel plugin is a stdio MCP server that bridges PCP's HTTP
    // inbox to Claude Code's channel notification system.
    if (hasPcpChannelPlugin(process.cwd())) {
      args.push('--dangerously-load-development-channels', 'server:pcp-channel');
    }

    // Passthrough flags
    args.push(...config.passthroughArgs);

    return {
      binary: this.binary,
      args,
      env: {
        AGENT_ID: config.agentId,
        ...(config.pcpSessionId ? { PCP_SESSION_ID: config.pcpSessionId } : {}),
        ...(config.studioId ? { PCP_STUDIO_ID: config.studioId } : {}),
      },
      cleanup: mcpCleanup,
    };
  }
}
