/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { encodeContextToken } from '@inklabs/shared';
import { buildIdentityPrompt } from './identity.js';
import { buildMergedMcpConfig } from '../lib/skill-mcp.js';
import type { BackendAdapter, BackendConfig, PreparedBackend, TurnMedia } from './types.js';
import type { BackendStreamParser } from './stream.js';
import { ClaudeStreamParser } from './claude-stream.js';

/**
 * Image types claude accepts as base64 content blocks (the Anthropic API
 * set). Anything else — documents, audio, heic — stays on the native-read
 * fallback until it has an injection story.
 */
const CLAUDE_INJECTABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Size guards for injected media, mirroring provider request limits. Files
 * over the cap (or past the running total) are NOT dropped — they fall back
 * to the native-read path, and the --tools gate accounts for them.
 */
export const MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 25 * 1024 * 1024;

export interface MediaInjectionPlan {
  /** Media that will be embedded as base64 image content blocks. */
  inject: TurnMedia[];
  /** Media left to the native-read fallback (wrong type, too big, unstatable). */
  fallback: TurnMedia[];
}

/**
 * Decide which media can be injected. Pure given a size probe so the
 * mime/size policy is unit-testable without multi-megabyte fixtures.
 */
export function planMediaInjection(
  media: TurnMedia[],
  fileSize: (path: string) => number | null
): MediaInjectionPlan {
  const plan: MediaInjectionPlan = { inject: [], fallback: [] };
  let totalBytes = 0;
  for (const m of media) {
    if (!CLAUDE_INJECTABLE_MIME.has(m.mimeType ?? '')) {
      plan.fallback.push(m);
      continue;
    }
    const size = fileSize(m.path);
    if (size === null || size > MAX_MEDIA_FILE_BYTES || totalBytes + size > MAX_MEDIA_TOTAL_BYTES) {
      plan.fallback.push(m);
      continue;
    }
    totalBytes += size;
    plan.inject.push(m);
  }
  return plan;
}

function statSizeSync(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

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

export class ClaudeAdapter implements BackendAdapter {
  readonly name = 'claude';
  readonly binary = 'claude';
  readonly injectsMedia = true;

  prepare(config: BackendConfig): PreparedBackend {
    const identityPrompt = buildIdentityPrompt(config.agentId);

    const args: string[] = [];

    // Media injection (spec:provider-media-injection): embed images as
    // base64 content blocks in a stream-json user message instead of having
    // the provider pull them via native Read. Requires prompt mode (the
    // message rides stdin). Files that can't be injected (non-image, too
    // big, unreadable at encode time) fall back to native read and keep the
    // --tools gate open below.
    const media = config.media ?? [];
    const plan = config.prompt ? planMediaInjection(media, statSizeSync) : undefined;
    const imageBlocks: Array<Record<string, unknown>> = [];
    let injectedCount = 0;
    if (plan) {
      for (const m of plan.inject) {
        try {
          imageBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: m.mimeType,
              data: readFileSync(m.path).toString('base64'),
            },
          });
          injectedCount += 1;
        } catch {
          // Vanished between stat and read — native-read fallback covers it.
        }
      }
    }
    const injecting = injectedCount > 0;

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
    //
    // Ink-owned routing (wholly-in-ink): tool-bearing servers are withheld
    // structurally. `--allowedTools ''` cannot do this — it is a permission
    // auto-approve list, nullified by --dangerously-skip-permissions — so the
    // provider must never see the servers at all. `--strict-mcp-config` is
    // essential: without it claude merges user/project-scope MCP configs on
    // its own, and the withheld servers leak straight back in. (Same pattern
    // openclaw uses: `--strict-mcp-config --mcp-config <controlled>`.)
    const localRouting = config.toolRouting === 'local';
    const {
      mcpConfigPath,
      hasChannelBridge,
      cleanup: mcpCleanup,
    } = buildMergedMcpConfig(process.cwd(), {
      pcpSessionId: config.pcpSessionId,
      studioId: config.studioId,
      omitToolServers: localRouting,
    });
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }
    if (localRouting) {
      args.push('--strict-mcp-config');
      // Built-in tools are part of the structural boundary too: strict MCP
      // only withholds servers, not native Bash/Edit/WebSearch/ToolSearch —
      // all of which would bypass ink's tool policy entirely.
      //
      // NAMED EXCEPTION (Conor-ratified, spec:wholly-in-ink-tool-routing):
      // native Read is exposed ONLY when this spawn carries attachments that
      // were NOT injected as prompt content — non-image files, oversize
      // images, callers that didn't thread media, or re-view turns after the
      // delivery turn. A turn whose media is fully injected gets no built-in
      // tools at all (spec:provider-media-injection).
      const hasAttachments = (config.attachmentDirs?.length ?? 0) > 0;
      const needsNativeRead =
        hasAttachments && (media.length === 0 || injectedCount < media.length);
      args.push('--tools', needsNativeRead ? 'Read' : '');
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
    // inbox to Claude Code's channel notification system. Keyed off the
    // RETAINED entry in the final config — never the raw project file — so a
    // rejected non-canonical `inkmail` is not requested by name against a
    // strict config that no longer defines it.
    if (hasChannelBridge) {
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

    // Injected turns switch stdin to stream-json: one JSONL user message
    // whose content is the prompt text plus base64 image blocks. Text-only
    // turns keep the plain-stdin path — smallest blast radius.
    let stdinData = config.prompt;
    if (injecting && config.prompt) {
      args.push('--input-format', 'stream-json');
      stdinData =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: config.prompt }, ...imageBlocks],
          },
        }) + '\n';
    }

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
      ...(stdinData ? { stdinData } : {}),
    };
  }

  createStreamParser(): BackendStreamParser {
    return new ClaudeStreamParser();
  }
}
