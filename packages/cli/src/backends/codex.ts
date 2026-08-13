/**
 * Codex CLI Backend Adapter
 *
 * Identity injection via --config model_instructions_file=<tmpfile>
 * PCP session headers via --config mcp_servers.inkwell.env_http_headers (env-var-backed)
 *
 * Docs: https://developers.openai.com/codex/cli/
 */

import { createIdentityPromptFile } from './identity.js';
import { encodeContextToken } from '@inklabs/shared';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';

/**
 * PCP headers to inject as env_http_headers on the "inkwell" MCP server.
 * Each entry maps a header name to the env var that holds its value.
 * Codex resolves env var → value at runtime, so multiple sessions in
 * the same studio each get their own scoped headers.
 *
 * x-ink-context is the consolidated token (preferred). Individual headers
 * are kept for backward compat during migration.
 *
 * Authorization is intentionally NOT here — it goes through codex's
 * `bearer_token_env_var` mechanism instead (see prepare()), which also stops
 * codex from running its own managed OAuth for the server.
 */
const PCP_ENV_HEADERS: Array<{ header: string; envVar: string }> = [
  { header: 'x-ink-context', envVar: 'INK_CONTEXT' },
  { header: 'x-ink-agent-id', envVar: 'AGENT_ID' },
  { header: 'x-ink-session-id', envVar: 'INK_SESSION_ID' },
  { header: 'x-ink-studio-id', envVar: 'INK_STUDIO_ID' },
];

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex';
  readonly binary = 'codex';
  // Prompt rides argv (`codex exec <prompt>`) — bounded by OS ARG_MAX.
  readonly promptTransport = 'argv' as const;

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

    // Ink session headers — Codex resolves env var names to values at runtime.
    // Server key must match what's in .codex/config.toml (mcp_servers.inkwell).
    for (const { header, envVar } of PCP_ENV_HEADERS) {
      args.push('-c', `mcp_servers.inkwell.env_http_headers.${header}="${envVar}"`);
    }

    // Auth: use codex's static-bearer mechanism, NOT an Authorization
    // env_http_header. `bearer_token_env_var` makes codex authenticate with the
    // env var's raw token AND skip its own managed OAuth discovery/refresh for
    // this server — ink already owns a valid token. Without this, codex tries to
    // refresh its independently-cached (keychain) OAuth credential on startup;
    // once that refresh token expires the server returns `invalid_grant` and
    // codex aborts MCP init, even though ink injected a perfectly good bearer.
    // Point at INK_ACCESS_TOKEN (raw) — codex prepends "Bearer " itself.
    args.push('-c', `mcp_servers.inkwell.bearer_token_env_var="INK_ACCESS_TOKEN"`);

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
    // e.g. "ink -b codex mcp login supabase" → codex ... mcp login supabase
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
      // Media injection (spec:provider-media-injection): codex attaches
      // images to the initial prompt natively — an exec-scoped option, so
      // it must sit after `exec`. Codex is stateless per spawn, so media is
      // (re)attached on every spawn of the logical turn. Two parse-safety
      // measures (Lumen, review 4900120086 — variadic `-i <FILE>...`
      // swallows the following positional prompt): the single-value
      // `--image=<path>` binding, plus a `--` options terminator so the
      // prompt can never be consumed as an option value. Non-image media
      // stays on the prompt-text path (paths listed in the attachment
      // block).
      const imageMedia = (config.media ?? []).filter((m) => m.mimeType?.startsWith('image/'));
      for (const m of imageMedia) {
        args.push(`--image=${m.path}`);
      }
      if (imageMedia.length > 0) {
        args.push('--');
      }
      args.push(...promptParts.slice(1));
    } else {
      // Passthrough flags
      args.push(...config.passthroughArgs);
      if (promptParts.length > 0) {
        args.push(...promptParts);
      }
    }

    // Build consolidated context token for x-ink-context header
    const contextToken = encodeContextToken({
      sessionId: config.pcpSessionId || '',
      studioId: config.studioId || '',
      agentId: config.agentId,
      cliAttached: true,
      runtime: 'codex',
    });

    // INK_ACCESS_TOKEN (raw token) is provided at the spawn site via authEnv;
    // the adapter references it by name through bearer_token_env_var above.

    return {
      binary: this.binary,
      args,
      env: {
        AGENT_ID: config.agentId,
        INK_CONTEXT: contextToken,
        ...(config.pcpSessionId ? { INK_SESSION_ID: config.pcpSessionId } : {}),
        ...(config.studioId ? { INK_STUDIO_ID: config.studioId } : {}),
      },
      cleanup,
    };
  }
}
