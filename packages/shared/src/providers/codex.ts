/**
 * Codex CLI Backend Adapter
 *
 * Identity injection via --config model_instructions_file=<tmpfile>
 * Inkwell session headers via --config mcp_servers.inkwell.env_http_headers (env-var-backed)
 *
 * Docs: https://developers.openai.com/codex/cli/
 */

import { mkdir } from 'fs/promises';
import { createIdentityPromptFile } from './identity-prompt.js';
import { encodeContextToken } from '../runner/mcp-config.js';
import { runProbe, type ProbeFailure } from '../runner/probe.js';
import { INK_ENV_HEADERS } from './codex-env-headers.js';
import { judgeCodexMcpList } from './codex-mcp-list.js';
import type {
  BackendAdapter,
  BackendConfig,
  BackendHost,
  EffectiveConfigCheck,
  PreparedBackend,
} from './types.js';

export { INK_ENV_HEADERS };

/**
 * Why a `codex mcp list --json` probe could not answer, from its failure
 * kind alone: an exit code, a signal or an errno code, never the child's
 * output, which prints static header values in the clear.
 */
export function codexProbeFailureReason(failure: ProbeFailure): string {
  const cannot = '`codex mcp list --json` could not check the Codex MCP configuration';
  switch (failure.kind) {
    case 'no-time':
      return `${cannot}: no time was left for it before the run's deadline`;
    case 'timeout':
      return `${cannot}: it did not finish in time`;
    case 'aborted':
      return `${cannot}: the turn was aborted`;
    case 'overflow':
      return `${cannot}: it printed more than a listing should`;
    case 'exit':
      return `${cannot}: it exited with code ${failure.exitCode}`;
    case 'signal':
      return `${cannot}: it was ended by ${failure.signal}`;
    case 'spawn':
      return `${cannot}: it could not start (${failure.code})`;
  }
}

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex';
  readonly binary = 'codex';
  // Prompt rides argv (`codex exec <prompt>`) — bounded by OS ARG_MAX.
  readonly promptTransport = 'argv' as const;

  /**
   * Codex's own view of its merged MCP config, judged before the spawn
   * (codex-mcp-list.ts). The listing runs on the probe env, which carries
   * none of the session's credentials and nothing the spawn would not get,
   * and its output goes only to the judge.
   */
  async checkEffectiveConfig(check: EffectiveConfigCheck): Promise<string | undefined> {
    const listing = await runProbe(check.binary, ['mcp', 'list', '--json'], {
      env: check.probeEnv,
      cwd: check.cwd,
      signal: check.signal,
      timeoutMs: check.timeoutMs,
    });
    if (!listing.ok) return codexProbeFailureReason(listing.failure);
    return judgeCodexMcpList(listing.stdout, {
      inkwellMcpUrl: check.inkwellMcpUrl,
      sessionEnvNames: check.sessionEnvNames,
    });
  }

  async prepare(config: BackendConfig, host: BackendHost): Promise<PreparedBackend> {
    const identity = await createIdentityPromptFile(
      host.paths.tempDir,
      config.sbSlug,
      config.startupContextBlock,
      config.systemPromptOverride
    );
    // A prepare that rejects leaves nothing behind (PreparedBackend.cleanup).
    try {
      return await this.prepareWith(config, host, identity);
    } catch (error) {
      await identity.cleanup();
      throw error;
    }
  }

  private async prepareWith(
    config: BackendConfig,
    host: BackendHost,
    { promptFile, cleanup }: { promptFile: string; cleanup: () => Promise<void> }
  ): Promise<PreparedBackend> {
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

    // Ephemeral-studio root (spec:studio-materialization v8): writable
    // alongside the workspace. --add-dir exists on both the root command and
    // the resume subcommand, and this push lands after `resume` when
    // resuming, so both shapes carry the grant. Created if missing.
    const inkStudiosDir = host.paths.studiosRoot;
    // Non-fatal — worst case the grant is a no-op until the dir exists.
    await mkdir(inkStudiosDir, { recursive: true }).catch(() => undefined);
    args.push('--add-dir', inkStudiosDir);

    // Ink session headers — Codex resolves env var names to values at runtime.
    // Server key must match what's in .codex/config.toml (mcp_servers.inkwell).
    for (const { header, envVar } of INK_ENV_HEADERS) {
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
      sessionId: config.inkSessionId || '',
      studioId: config.studioId || '',
      sbSlug: config.sbSlug,
      cliAttached: config.cliAttached,
      runtime: 'codex',
    });

    // INK_ACCESS_TOKEN (raw token) is provided at the spawn site via authEnv;
    // the adapter references it by name through bearer_token_env_var above.

    return {
      binary: this.binary,
      args,
      env: {
        SB_SLUG: config.sbSlug,
        AGENT_ID: config.sbSlug,
        INK_CONTEXT: contextToken,
        ...(config.inkSessionId ? { INK_SESSION_ID: config.inkSessionId } : {}),
        ...(config.studioId ? { INK_STUDIO_ID: config.studioId } : {}),
      },
      cleanup,
    };
  }
}
