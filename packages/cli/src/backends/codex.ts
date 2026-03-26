/**
 * Codex CLI Backend Adapter
 *
 * Identity injection via --config model_instructions_file=<tmpfile>
 * PCP session headers via --config mcp_servers.pcp.env_http_headers (env-var-backed)
 *
 * Docs: https://developers.openai.com/codex/cli/
 */

import { createIdentityPromptFile } from './identity.js';
import { encodeContextToken } from '@personal-context/shared';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

/**
 * PCP headers to inject as env_http_headers on the "pcp" MCP server.
 * Each entry maps a header name to the env var that holds its value.
 * Codex resolves env var → value at runtime, so multiple sessions in
 * the same studio each get their own scoped headers.
 *
 * x-pcp-context is the consolidated token (preferred). Individual headers
 * are kept for backward compat during migration.
 */
const PCP_ENV_HEADERS: Array<{ header: string; envVar: string }> = [
  { header: 'x-pcp-context', envVar: 'PCP_CONTEXT_TOKEN' },
  { header: 'Authorization', envVar: 'PCP_AUTH_BEARER' },
  { header: 'x-pcp-agent-id', envVar: 'AGENT_ID' },
  { header: 'x-pcp-session-id', envVar: 'PCP_SESSION_ID' },
  { header: 'x-pcp-studio-id', envVar: 'PCP_STUDIO_ID' },
];

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex';
  readonly binary = 'codex';

  prepare(config: BackendConfig): PreparedBackend {
    const { promptFile, cleanup } = createIdentityPromptFile(
      config.agentId,
      config.startupContextBlock
    );

    const args: string[] = [];

    // Resume MUST come before --config flags. Codex treats `resume` as a
    // subcommand with its own `-c` flag — config flags before `resume`
    // are root-level and don't apply to the resumed session.
    if (config.backendSessionId) {
      args.push('resume', config.backendSessionId);
    }

    // Identity injection via config override (uses -c which works both
    // as root --config and as resume's -c flag)
    args.push('-c', `model_instructions_file=${promptFile}`);

    // PCP session headers — Codex resolves env var names to values at runtime
    for (const { header, envVar } of PCP_ENV_HEADERS) {
      args.push('-c', `mcp_servers.pcp.env_http_headers.${header}="${envVar}"`);
    }

    // Model (only if explicitly specified by user)
    if (config.model) {
      args.push('--model', config.model);
    }
    // NOTE:
    // Codex does not currently expose a reliable "set session id on first run"
    // equivalent to Claude's --session-id seeding flow, so we only pass resume
    // when a backend-native id is already known.

    // Auto-approve: skip all permission prompts and sandbox restrictions
    if (config.dangerous) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    // Positional args spread individually so subcommands work
    // e.g. "sb -b codex mcp login supabase" → codex ... mcp login supabase
    //
    // Codex has subcommand-scoped flags (notably for `exec`) such as:
    //   --skip-git-repo-check, --color, --json
    // Those must come AFTER `exec`, not before it.
    //
    // Preserve general behavior for non-exec prompt parts, but when promptParts
    // starts with `exec`, place passthrough args immediately after `exec`.
    const promptParts = config.promptParts || [];
    if (promptParts.length > 0 && promptParts[0]?.toLowerCase() === 'exec') {
      args.push(promptParts[0]);
      args.push(...config.passthroughArgs);
      args.push(...promptParts.slice(1));
    } else {
      // Passthrough flags
      args.push(...config.passthroughArgs);
      if (promptParts.length > 0) {
        args.push(...promptParts);
      }
    }

    // Build consolidated context token for x-pcp-context header
    const contextToken = encodeContextToken({
      sessionId: config.pcpSessionId || '',
      studioId: config.studioId || '',
      agentId: config.agentId,
      cliAttached: true,
      runtime: 'codex',
    });

    // PCP_AUTH_BEARER is constructed at the spawn site from PCP_ACCESS_TOKEN
    // (set via authEnv). The adapter declares the header mapping; the spawn
    // site provides the env var value.

    return {
      binary: this.binary,
      args,
      env: {
        AGENT_ID: config.agentId,
        PCP_CONTEXT_TOKEN: contextToken,
        ...(config.pcpSessionId ? { PCP_SESSION_ID: config.pcpSessionId } : {}),
        ...(config.studioId ? { PCP_STUDIO_ID: config.studioId } : {}),
      },
      cleanup,
    };
  }
}
