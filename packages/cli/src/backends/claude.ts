/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync } from 'fs';
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
 * set). Only these — explicitly unsupported types (documents, audio, heic)
 * — may fall back to native read; everything else about injection fails
 * CLOSED (see encodeMediaBlocks).
 */
const CLAUDE_INJECTABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Size guards for injected media, mirroring provider request limits. A
 * supported image that breaches a cap is REJECTED (loud, fail closed) — it
 * does not reopen native read.
 */
export const MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 25 * 1024 * 1024;

export interface MediaClassification {
  /** Supported image types — injection candidates. */
  candidates: TurnMedia[];
  /**
   * Explicitly unsupported types (documents, audio, heic) — the ONLY bucket
   * allowed to fall back to the gated native-read exception.
   */
  nativeRead: TurnMedia[];
}

/**
 * Classify media by mime alone. Deterministic and IO-free: the --tools gate
 * derives from this classification on every spawn of a logical turn, so the
 * boundary decision cannot flap on filesystem state (TOCTOU) or differ
 * between the delivery spawn and tool-loop continuations.
 */
export function classifyMedia(media: TurnMedia[]): MediaClassification {
  const out: MediaClassification = { candidates: [], nativeRead: [] };
  for (const m of media) {
    (CLAUDE_INJECTABLE_MIME.has(m.mimeType ?? '') ? out.candidates : out.nativeRead).push(m);
  }
  return out;
}

/**
 * Bounded single-descriptor read: open once, verify it is a REGULAR file
 * within the cap via fstat on that same descriptor, then read it fully.
 * Special files (fifos, devices), oversize files, and IO errors all return
 * null — never a partial or unbounded read.
 */
export function readMediaBounded(path: string, maxBytes: number): Buffer | null {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: opening a FIFO for read BLOCKS until a writer appears —
    // a media path pointing at one would hang the spawn indefinitely.
    // Nonblocking open returns immediately; fstat then rejects it as
    // non-regular. Regular-file reads are unaffected by the flag.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return offset === st.size ? buf : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface EncodedMedia {
  /** Base64 image content blocks, in candidate order. */
  blocks: Array<Record<string, unknown>>;
  injected: TurnMedia[];
  /**
   * Candidates that failed policy or IO (oversize, over-total, special
   * file, read error). Fail CLOSED: rejected media neither injects nor
   * reopens native read — the failure is reported loudly instead.
   */
  rejected: Array<{ media: TurnMedia; reason: string }>;
}

/** Encode injection candidates; the read fn is injectable for unit tests. */
export function encodeMediaBlocks(
  candidates: TurnMedia[],
  readBounded: (path: string, maxBytes: number) => Buffer | null = readMediaBounded
): EncodedMedia {
  const out: EncodedMedia = { blocks: [], injected: [], rejected: [] };
  let totalBytes = 0;
  for (const m of candidates) {
    if (totalBytes >= MAX_MEDIA_TOTAL_BYTES) {
      out.rejected.push({ media: m, reason: 'turn media budget exhausted' });
      continue;
    }
    const buf = readBounded(
      m.path,
      Math.min(MAX_MEDIA_FILE_BYTES, MAX_MEDIA_TOTAL_BYTES - totalBytes)
    );
    if (!buf) {
      out.rejected.push({ media: m, reason: 'unreadable, not a regular file, or over size cap' });
      continue;
    }
    totalBytes += buf.byteLength;
    out.blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: m.mimeType, data: buf.toString('base64') },
    });
    out.injected.push(m);
  }
  return out;
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
  // Prompt is delivered via stdin (see prepare() below) — no argv ceiling.
  readonly promptTransport = 'stdin' as const;

  prepare(config: BackendConfig): PreparedBackend {
    const identityPrompt = buildIdentityPrompt(config.agentId);

    const args: string[] = [];

    // Media injection (spec:provider-media-injection): embed images as
    // base64 content blocks in a stream-json user message instead of having
    // the provider pull them via native Read. Requires prompt mode (the
    // message rides stdin).
    //
    // Callers pass the turn's media on EVERY spawn of the logical turn and
    // mark DELIVERY spawns with deliverMedia. Delivery spawns embed the
    // blocks — including into a resumed cross-process conversation, where
    // new media legitimately arrives with a recovered backendSessionId
    // (Lumen, review 4900202375). Same-turn tool-loop continuations omit
    // deliverMedia and do not re-embed (the provider session already holds
    // the images), but the classification still drives the --tools gate
    // below so the boundary disposition is identical across the whole
    // logical turn.
    const media = config.media ?? [];
    const classified = classifyMedia(media);
    const encoded =
      config.prompt && config.deliverMedia && classified.candidates.length > 0
        ? encodeMediaBlocks(classified.candidates)
        : undefined;
    // Fail-closed rejections must be LOUD where someone can see them: the
    // stderr warn is invisible on successful headless runs (InkRunner
    // discards it), so the note also rides the prompt itself — the provider
    // tells the user what it never received.
    let rejectionNote = '';
    if (encoded && encoded.rejected.length > 0) {
      for (const r of encoded.rejected) {
        console.warn(`[media] not injected (${r.reason}): ${r.media.path}`);
      }
      rejectionNote =
        '\n\n[media note] The following attached file(s) could NOT be delivered ' +
        '(fail-closed; no filesystem fallback). Tell the user, naming each file:\n' +
        encoded.rejected.map((r) => `- ${r.media.path} — ${r.reason}`).join('\n');
    }
    const injecting = (encoded?.blocks.length ?? 0) > 0;
    const promptText = config.prompt ? config.prompt + rejectionNote : config.prompt;

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
      // native Read is exposed ONLY for attachments that injection can
      // never carry — explicitly unsupported types (documents, audio,
      // heic), legacy callers that didn't thread media, and re-view turns
      // after the delivery turn. The decision derives from the IO-free mime
      // classification, so it is identical on every spawn of the logical
      // turn; injection FAILURES (oversize, unreadable, special files) fail
      // closed and never reopen Read.
      const hasAttachments = (config.attachmentDirs?.length ?? 0) > 0;
      const needsNativeRead =
        hasAttachments && (media.length === 0 || classified.nativeRead.length > 0);
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
    // turns and non-delivery spawns keep the plain-stdin path. Either way
    // the prompt carries the rejection note when something wasn't delivered.
    let stdinData = promptText;
    if (injecting && promptText) {
      args.push('--input-format', 'stream-json');
      stdinData =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: promptText }, ...(encoded?.blocks ?? [])],
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
