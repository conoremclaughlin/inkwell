/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { buildIdentityPrompt } from './identity.js';
import { buildMergedMcpConfig } from '../lib/skill-mcp.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

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
