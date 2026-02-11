/**
 * Codex CLI Backend Adapter
 *
 * Identity injection via --config model_instructions_file=<tmpfile>
 * MCP config via --config mcp_servers (TOML format, not yet implemented)
 *
 * Docs: https://developers.openai.com/codex/cli/
 */

import { createIdentityPromptFile } from './identity.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex';
  readonly binary = 'codex';

  prepare(config: BackendConfig): PreparedBackend {
    const { promptFile, cleanup } = createIdentityPromptFile(config.agentId);

    const args: string[] = [];

    // Identity injection via config override
    args.push('--config', `model_instructions_file=${promptFile}`);

    // Model (only if explicitly specified by user)
    if (config.model) {
      args.push('--model', config.model);
    }

    // Passthrough flags
    args.push(...config.passthroughArgs);

    // Positional args spread individually so subcommands work
    // e.g. "sb -b codex mcp login supabase" → codex ... mcp login supabase
    if (config.promptParts.length > 0) {
      args.push(...config.promptParts);
    }

    return {
      binary: this.binary,
      args,
      env: { AGENT_ID: config.agentId },
      cleanup,
    };
  }
}
