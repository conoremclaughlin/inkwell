/**
 * Gemini CLI Backend Adapter
 *
 * Identity injection via GEMINI_SYSTEM_MD=<tmpfile> env var
 * MCP config via .gemini/settings.json (not yet implemented)
 *
 * Docs: https://geminicli.com/docs/
 */

import { createIdentityPromptFile } from './identity.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

export class GeminiAdapter implements BackendAdapter {
  readonly name = 'gemini';
  readonly binary = 'gemini';

  prepare(config: BackendConfig): PreparedBackend {
    const { promptFile, cleanup } = createIdentityPromptFile(config.agentId);

    const args: string[] = [];

    // Model (only if explicitly specified)
    if (config.model) {
      args.push('-m', config.model);
    }

    // Prompt mode: gemini uses -p for one-shot
    // Interactive is the default (no flag needed)
    if (config.prompt) {
      args.push('-p');
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
      // Identity injection via env var — points to our temp file
      env: {
        AGENT_ID: config.agentId,
        GEMINI_SYSTEM_MD: promptFile,
        ...(config.pcpSessionId ? { PCP_SESSION_ID: config.pcpSessionId } : {}),
      },
      cleanup,
    };
  }
}
