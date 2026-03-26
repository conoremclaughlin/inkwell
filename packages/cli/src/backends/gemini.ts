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

// TODO: Gemini reads MCP headers from .gemini/settings.json, not env vars.
// PCP_CONTEXT_TOKEN + Authorization need to be wired via a generated
// settings.json override (like gemini-runner.ts does server-side).
// See: packages/api/src/services/sessions/gemini-runner.ts:88-102

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
      // Keep prompt adjacent to -p for strict CLI parsers.
      args.push(config.prompt);
    }

    // Resume a specific backend-native Gemini session when available.
    if (config.backendSessionId) {
      args.push('--resume', config.backendSessionId);
    }

    // Auto-approve: skip all permission prompts
    if (config.dangerous) {
      args.push('--yolo');
    }

    // Passthrough flags
    args.push(...config.passthroughArgs);

    return {
      binary: this.binary,
      args,
      // Identity injection via env var — points to our temp file
      env: {
        AGENT_ID: config.agentId,
        GEMINI_SYSTEM_MD: promptFile,
        ...(config.pcpSessionId ? { PCP_SESSION_ID: config.pcpSessionId } : {}),
        ...(config.studioId ? { PCP_STUDIO_ID: config.studioId } : {}),
      },
      cleanup,
    };
  }
}
