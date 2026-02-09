/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt <tmpfile>
 * MCP config via --mcp-config <path>
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { createIdentityPromptFile } from './identity.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

export class ClaudeAdapter implements BackendAdapter {
  readonly name = 'claude';
  readonly binary = 'claude';

  prepare(config: BackendConfig): PreparedBackend {
    const { promptFile, cleanup } = createIdentityPromptFile(config.agentId);

    const args: string[] = [];

    // Prompt mode vs interactive
    if (config.prompt) {
      args.push('-p');
    }

    // Model + identity
    args.push('--model', config.model);
    args.push('--append-system-prompt', promptFile);

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
      env: { AGENT_ID: config.agentId },
      cleanup,
    };
  }
}
