/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { buildIdentityPrompt } from './identity.js';
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
    } else if (config.pcpSessionId) {
      // Keep Claude session ID aligned with PCP session ID when possible
      args.push('--session-id', config.pcpSessionId);
    }

    // MCP config (if present in CWD)
    const mcpConfig = join(process.cwd(), '.mcp.json');
    if (existsSync(mcpConfig)) {
      args.push('--mcp-config', mcpConfig);
    }

    // Passthrough flags
    args.push(...config.passthroughArgs);

    // Prompt as a single string after -p
    if (config.prompt) {
      args.push(config.prompt);
    }

    return {
      binary: this.binary,
      args,
      env: {
        AGENT_ID: config.agentId,
        ...(config.pcpSessionId ? { PCP_SESSION_ID: config.pcpSessionId } : {}),
      },
      cleanup: () => {}, // No temp file, no cleanup needed
    };
  }
}
