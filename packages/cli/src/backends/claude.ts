/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { encodeContextToken } from '@inklabs/shared';
import { buildIdentityPrompt } from './identity.js';
import { buildMergedMcpConfig } from '../lib/skill-mcp.js';
import type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';
import type { BackendStreamParser } from './stream.js';
import { ClaudeStreamParser } from './claude-stream.js';

/**
 * Check if the PCP channel plugin is registered in .mcp.json.
 * If present, Claude Code should be started with --dangerously-load-development-channels
 * so it accepts push notifications from the channel.
 */
/**
 * Once-per-process probe for `--include-partial-messages` support. This runs
 * in the ink CLI process (never the API server), so a brief sync probe just
 * before spawning a multi-second backend turn is acceptable.
 */
let partialMessagesSupport: boolean | null = null;
function supportsPartialMessages(): boolean {
  if (partialMessagesSupport === null) {
    try {
      const help = execFileSync('claude', ['--help'], { encoding: 'utf-8', timeout: 5000 });
      partialMessagesSupport = help.includes('--include-partial-messages');
    } catch {
      partialMessagesSupport = false;
    }
  }
  return partialMessagesSupport;
}

function hasPcpInboxPlugin(cwd: string): boolean {
  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) return false;
  try {
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    return Boolean(config?.mcpServers?.['inkmail']);
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

    // Prompt mode vs interactive. The prompt is passed via stdin (not argv):
    // transcripts can exceed the OS argv limit (~256KB on macOS), which
    // makes spawn fail with E2BIG. `claude -p` reads the prompt from piped
    // stdin when no positional prompt is given.
    if (config.prompt) {
      args.push('-p');
    }

    // Structured streaming output. Lets ink parse Claude's turn incrementally —
    // for live CLI/website updates AND a token-flow idle timeout — instead of a
    // buffered blob. `--verbose` is required by Claude to combine `-p` with
    // stream-json. Parsed by ClaudeStreamParser (see createStreamParser).
    if (config.stream) {
      args.push('--output-format', 'stream-json', '--verbose');
      // Partial-message deltas drive paragraph-by-paragraph TUI rendering.
      // Probed (not assumed) so an older claude binary doesn't fail every
      // turn on an unknown flag; absence degrades to block-level streaming.
      if (supportsPartialMessages()) {
        args.push('--include-partial-messages');
      }
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

    // Attachment directories: grant read access so files attached to the
    // turn (--attach-file paths referenced in the prompt) are readable
    // without permission prompts. Claude Code's Read renders images
    // natively, so this is the full multimodal path for CLI spawns.
    for (const dir of config.attachmentDirs ?? []) {
      args.push('--add-dir', dir);
    }

    // Inkwell media directory: always grant read access so agents can
    // read downloaded attachments (email, Telegram, etc.) via the native
    // Read tool. This is Inkwell's own directory, not arbitrary fs access.
    const inkFilesDir = join(homedir(), '.ink', 'files');
    if (existsSync(inkFilesDir)) {
      args.push('--add-dir', inkFilesDir);
    }

    // PCP channel plugin: enable real-time inbox push notifications.
    // The channel plugin is a stdio MCP server that bridges PCP's HTTP
    // inbox to Claude Code's channel notification system.
    if (hasPcpInboxPlugin(process.cwd())) {
      args.push('--dangerously-load-development-channels', 'server:inkmail');
    }

    // Passthrough flags
    args.push(...config.passthroughArgs);

    // Consolidated context token for x-ink-context header. The `.mcp.json`
    // generated by buildMergedMcpConfig references ${INK_CONTEXT}; this env
    // var is what Claude Code resolves at MCP connect time.
    const contextToken = encodeContextToken({
      sessionId: config.pcpSessionId || '',
      studioId: config.studioId || '',
      agentId: config.agentId,
      cliAttached: true,
      runtime: 'claude',
    });

    return {
      binary: this.binary,
      args,
      env: {
        AGENT_ID: config.agentId,
        INK_CONTEXT: contextToken,
        ...(config.pcpSessionId ? { INK_SESSION_ID: config.pcpSessionId } : {}),
        ...(config.studioId ? { INK_STUDIO_ID: config.studioId } : {}),
      },
      cleanup: mcpCleanup,
      ...(config.prompt ? { stdinData: config.prompt } : {}),
    };
  }

  createStreamParser(): BackendStreamParser {
    return new ClaudeStreamParser();
  }
}
