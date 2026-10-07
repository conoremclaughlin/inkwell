/**
 * Claude Code Backend Adapter
 *
 * Identity injection via --append-system-prompt (inline text)
 * MCP config via --mcp-config <path>
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { basename, join } from 'path';
import { homedir } from 'os';
import { encodeContextToken, PRINT_MODE_CHANNEL_ENV } from '@inklabs/shared';
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
  /** Raw bytes embedded, so a second batch can share the same request budget. */
  totalBytes: number;
}

/** Encode injection candidates; the read fn is injectable for unit tests. */
export function encodeMediaBlocks(
  candidates: TurnMedia[],
  readBounded: (path: string, maxBytes: number) => Buffer | null = readMediaBounded,
  budgetBytes: number = MAX_MEDIA_TOTAL_BYTES
): EncodedMedia {
  const out: EncodedMedia = { blocks: [], injected: [], rejected: [], totalBytes: 0 };
  for (const m of candidates) {
    if (out.totalBytes >= budgetBytes) {
      out.rejected.push({ media: m, reason: 'turn media budget exhausted' });
      continue;
    }
    const buf = readBounded(m.path, Math.min(MAX_MEDIA_FILE_BYTES, budgetBytes - out.totalBytes));
    if (!buf) {
      out.rejected.push({ media: m, reason: 'unreadable, not a regular file, or over size cap' });
      continue;
    }
    out.totalBytes += buf.byteLength;
    out.blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: m.mimeType, data: buf.toString('base64') },
    });
    out.injected.push(m);
  }
  return out;
}

/**
 * Tool-captured images as content blocks, each preceded by a one-line label
 * naming its ref, so a spawn carrying several (a re-seed delivers every image
 * still on the ledger) says which picture is which. Shares the request's
 * media budget with the turn's own attachments, which are encoded first.
 */
export function encodeContextImageBlocks(
  images: TurnMedia[],
  usedBytes: number,
  readBounded: (path: string, maxBytes: number) => Buffer | null = readMediaBounded
): EncodedMedia {
  const encoded = encodeMediaBlocks(
    images,
    readBounded,
    Math.max(0, MAX_MEDIA_TOTAL_BYTES - usedBytes)
  );
  const labelled: Array<Record<string, unknown>> = [];
  encoded.injected.forEach((image, i) => {
    const ref = (image as { ref?: unknown }).ref;
    labelled.push({
      type: 'text',
      text: `[image ${typeof ref === 'string' ? ref : image.path}]`,
    });
    labelled.push(encoded.blocks[i]!);
  });
  return { ...encoded, blocks: labelled };
}

/**
 * Documents a withheld turn reads inline (task 0321ccf1). With no native
 * tool, a file the provider can't take as an image block is shown as text
 * this process reads: a text file as it is, a PDF as the text extracted from
 * its first pages. Each sits in a fenced block that says which file it is.
 * The fence keeps the file's words apart from the message's; it does not
 * make instructions inside a file harmless.
 */
export const MAX_TEXT_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_PDF_PAGES = 30;
export const MAX_DOCUMENT_TEXT_CHARS = 100_000;
export const PDF_EXTRACT_TIMEOUT_MS = 20_000;

type DocumentKind = 'text' | 'pdf';

function documentKind(m: TurnMedia): DocumentKind | null {
  const mime = (m.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return null;
}

export interface ExtractedPdf {
  text: string;
  /** Pages the text came from (the first ones), and the document's total. */
  pages: number;
  total: number;
}

export type PdfExtractor = (
  bytes: Buffer,
  maxPages: number,
  timeoutMs: number
) => ExtractedPdf | null;

/**
 * Runs in a short-lived child process, so extraction stays synchronous for
 * prepare() and a PDF that hangs or crashes the parser takes down only the
 * child. pdf-parse is resolved from this package; the child gets the bytes
 * on stdin and an empty environment.
 */
const PDF_EXTRACT_SCRIPT = `
const { PDFParse } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false });
  try {
    const result = await parser.getText({ first: Number(process.argv[2]) });
    process.stdout.write(JSON.stringify({ text: result.text.slice(0, Number(process.argv[3])), total: result.total }));
  } finally {
    await parser.destroy();
  }
});`;

let pdfParseEntry: string | null | undefined;

export function extractPdfTextSync(
  bytes: Buffer,
  maxPages: number,
  timeoutMs: number = PDF_EXTRACT_TIMEOUT_MS
): ExtractedPdf | null {
  try {
    pdfParseEntry ??= createRequire(import.meta.url).resolve('pdf-parse');
  } catch {
    pdfParseEntry = null;
  }
  if (!pdfParseEntry) return null;
  try {
    const args = [
      '-e',
      PDF_EXTRACT_SCRIPT,
      pdfParseEntry,
      String(maxPages),
      String(MAX_DOCUMENT_TEXT_CHARS + 1),
    ];
    const out = execFileSync(process.execPath, args, {
      input: bytes,
      env: {},
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      // The child caps the text; room for it JSON-escaped, at up to six bytes a character.
      maxBuffer: 6 * (MAX_DOCUMENT_TEXT_CHARS + 1) + 64 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out.toString('utf8')) as { text?: unknown; total?: unknown };
    if (typeof parsed.text !== 'string' || typeof parsed.total !== 'number') return null;
    return { text: parsed.text, pages: Math.min(maxPages, parsed.total), total: parsed.total };
  } catch {
    return null;
  }
}

/** The text, cut at `max` characters without splitting a surrogate pair. */
function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** A fence no run of backticks in the content can close. */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A file name fit for one line of the label. */
function labelName(path: string): string {
  return basename(path).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
}

function documentBlock(label: string, content: string, cut: boolean): Record<string, unknown> {
  const fence = fenceFor(content);
  const tail = cut
    ? `\n[The text was cut at ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString('en-US')} characters; the rest is not shown.]`
    : '';
  return { type: 'text', text: `${label}\n${fence}\n${content}\n${fence}${tail}` };
}

/**
 * Encode a withheld turn's documents as text blocks. Shares the request's
 * media budget with images: `usedBytes` is what the turn's images took, and
 * each block's UTF-8 size counts against the rest. Anything that can't be
 * shown (another type, unreadable, oversize, not UTF-8, a PDF with no
 * readable text, an exhausted budget) is rejected with its reason, for the
 * note the model is given; nothing reopens native read.
 */
export function encodeDocumentBlocks(
  documents: TurnMedia[],
  usedBytes: number,
  readBounded: (path: string, maxBytes: number) => Buffer | null = readMediaBounded,
  extractPdf: PdfExtractor = extractPdfTextSync,
  now: () => number = Date.now
): EncodedMedia {
  const out: EncodedMedia = { blocks: [], injected: [], rejected: [], totalBytes: 0 };
  const budget = Math.max(0, MAX_MEDIA_TOTAL_BYTES - usedBytes);
  // One extraction deadline for the whole turn, not one per PDF: prepare()
  // is synchronous, so ink chat waits on it, and a message can carry several.
  const deadline = now() + PDF_EXTRACT_TIMEOUT_MS;
  for (const m of documents) {
    const kind = documentKind(m);
    if (!kind) {
      out.rejected.push({ media: m, reason: 'not a type that can be shown in this conversation' });
      continue;
    }
    if (out.totalBytes >= budget) {
      out.rejected.push({ media: m, reason: 'turn media budget exhausted' });
      continue;
    }
    const name = labelName(m.path);
    let block: Record<string, unknown>;
    if (kind === 'text') {
      const buf = readBounded(m.path, MAX_TEXT_DOCUMENT_BYTES);
      if (!buf) {
        out.rejected.push({ media: m, reason: 'unreadable, not a regular file, or over size cap' });
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        out.rejected.push({ media: m, reason: 'not valid UTF-8 text' });
        continue;
      }
      const capped = capText(text, MAX_DOCUMENT_TEXT_CHARS);
      const mime = (m.mimeType ?? 'text/plain').split(';')[0]!.trim();
      block = documentBlock(
        `[Attached file ${name} (${mime}, ${buf.byteLength.toLocaleString('en-US')} bytes). Its contents follow between the fences.]`,
        capped.text,
        capped.cut
      );
    } else {
      const buf = readBounded(m.path, MAX_MEDIA_FILE_BYTES);
      if (!buf) {
        out.rejected.push({ media: m, reason: 'unreadable, not a regular file, or over size cap' });
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        out.rejected.push({ media: m, reason: 'the time for reading attached files ran out' });
        continue;
      }
      const extracted = extractPdf(buf, MAX_PDF_PAGES, remaining);
      if (!extracted) {
        out.rejected.push({ media: m, reason: 'its text could not be read as a PDF' });
        continue;
      }
      if (!extracted.text.trim()) {
        out.rejected.push({
          media: m,
          reason: 'no text could be extracted (it may hold only scanned images)',
        });
        continue;
      }
      const capped = capText(extracted.text, MAX_DOCUMENT_TEXT_CHARS);
      const pages =
        extracted.pages < extracted.total
          ? `pages 1–${extracted.pages} of ${extracted.total}`
          : `${extracted.total} page${extracted.total === 1 ? '' : 's'}`;
      block = documentBlock(
        `[Attached file ${name} (PDF, ${pages}). The text extracted from it follows between the fences; its layout and images are not included.]`,
        capped.text,
        capped.cut
      );
    }
    const size = Buffer.byteLength(block.text as string, 'utf8');
    if (out.totalBytes + size > budget) {
      out.rejected.push({ media: m, reason: 'turn media budget exhausted' });
      continue;
    }
    out.totalBytes += size;
    out.blocks.push(block);
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
  // Embedded as stream-json image blocks alongside the prompt.
  readonly acceptsContextImages = true;

  prepare(config: BackendConfig): PreparedBackend {
    const identityPrompt = buildIdentityPrompt(
      config.sbSlug,
      undefined,
      config.systemPromptOverride
    );

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
    // Withheld (task 0321ccf1): with no native tool there is no native read,
    // so a document is read here and shown as text on the delivery spawn,
    // and anything that can't be shown is named to the model as unopened
    // rather than left for it to look for a way in. Refused first if the
    // routing isn't ink-owned, before any file is read.
    const withhold = config.withholdProviderTools === true;
    if (withhold && config.toolRouting !== 'local') {
      // startBackendTurn never asks for this; refuse rather than spawn a
      // provider that keeps its own tools and the project's MCP servers.
      throw new Error('withholdProviderTools requires ink-owned (local) tool routing');
    }
    const documents =
      withhold && config.prompt && config.deliverMedia && classified.nativeRead.length > 0
        ? encodeDocumentBlocks(classified.nativeRead, encoded?.totalBytes ?? 0)
        : undefined;
    if (documents && documents.rejected.length > 0) {
      for (const r of documents.rejected) {
        console.warn(`[media] document not shown (${r.reason}): ${r.media.path}`);
      }
      rejectionNote +=
        '\n\n[media note] These attached file(s) could NOT be opened, and there is no other ' +
        'way to read a file here. Tell the user you could not open each one, and why:\n' +
        documents.rejected
          .map(
            (r) =>
              `- ${labelName(r.media.path)}${r.media.mimeType ? ` (${r.media.mimeType})` : ''} — ${r.reason}`
          )
          .join('\n');
    }
    // Images a tool put in context. Embedded whenever the host sends them —
    // it sends exactly what this provider session has not been given — and
    // kept out of the --tools gate below, which reads `media` alone.
    const contextImages = config.prompt ? (config.contextImages ?? []) : [];
    const encodedContext =
      contextImages.length > 0
        ? encodeContextImageBlocks(
            contextImages,
            (encoded?.totalBytes ?? 0) + (documents?.totalBytes ?? 0)
          )
        : undefined;
    if (encodedContext && encodedContext.rejected.length > 0) {
      for (const r of encodedContext.rejected) {
        console.warn(`[media] context image not injected (${r.reason}): ${r.media.path}`);
      }
      rejectionNote +=
        '\n\n[image note] These image(s), named in your context, could NOT be attached to ' +
        'this message, so you have not seen them. Each goes again with your next message ' +
        'while it stays in your context; evict it if you no longer need it, or view the ' +
        'file again if the reason is that it is unreadable:\n' +
        encodedContext.rejected
          .map((r) => {
            const ref = (r.media as { ref?: unknown }).ref;
            return `- ${typeof ref === 'string' ? ref : 'image'} — ${r.reason}`;
          })
          .join('\n');
    }
    const contentBlocks = [
      ...(encoded?.blocks ?? []),
      ...(documents?.blocks ?? []),
      ...(encodedContext?.blocks ?? []),
    ];
    const injecting = contentBlocks.length > 0;
    const promptText = config.prompt ? config.prompt + rejectionNote : config.prompt;

    // Prompt mode vs interactive. The prompt is passed via stdin (not argv):
    // transcripts can exceed the OS argv limit (~256KB on macOS), which
    // makes spawn fail with E2BIG. `claude -p` reads the prompt from piped
    // stdin when no positional prompt is given.
    if (config.prompt) {
      args.push('-p');
    }
    // `ink -b claude -p hello` arrives with no prompt and the print flag in
    // passthrough (extractArgs cannot tell it from any other unknown flag),
    // and the Claude it launches is print mode all the same.
    const printMode =
      Boolean(config.prompt) ||
      config.passthroughArgs.some((arg) => arg === '-p' || arg === '--print');

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
    // Effort: per-SB from the identity's runtimeConfig, threaded through
    // `ink chat --effort`; absent leaves the CLI's own/user-level setting.
    if (config.effort) {
      args.push('--effort', config.effort);
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
    // Pass inkSessionId/studioId explicitly — process.env doesn't have them yet
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
      inkSessionId: config.inkSessionId,
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
      //
      // Withheld, there is no exception: the turn keeps no native tool,
      // whatever it carries. Read's reach is Claude Code's read policy, not
      // the attachment's directory (task 0321ccf1).
      const hasAttachments = (config.attachmentDirs?.length ?? 0) > 0;
      const needsNativeRead =
        !withhold && hasAttachments && (media.length === 0 || classified.nativeRead.length > 0);
      args.push('--tools', needsNativeRead ? 'Read' : '');
    }

    // Auto-approve: skip all permission prompts
    if (config.dangerous) {
      args.push('--dangerously-skip-permissions');
    }

    // Withheld, the spawn gets no directory grant at all. With no native
    // tool one would be inert, and it stays out so nothing opened later
    // inherits it. Injected images are read here, by this process, not by
    // the provider, so they need none.
    if (!withhold) {
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

      // Ephemeral-studio root (spec:studio-materialization v8): grant at spawn
      // so create_studio/overflow worktrees minted mid-session are accessible —
      // a live session can never be granted a new directory. Created if
      // missing: Claude Code ignores a nonexistent --add-dir.
      const inkStudiosDir = process.env.INK_STUDIOS_ROOT || join(homedir(), '.ink', 'studios');
      try {
        mkdirSync(inkStudiosDir, { recursive: true });
      } catch {
        // Non-fatal — worst case the grant is a no-op until the dir exists.
      }
      args.push('--add-dir', inkStudiosDir);
    }

    // Inkwell channel plugin: enable real-time inbox push notifications.
    // The channel plugin is a stdio MCP server that bridges Inkwell's HTTP
    // inbox to Claude Code's channel notification system. Keyed off the
    // RETAINED entry in the final config — never the raw project file — so a
    // rejected non-canonical `inkmail` is not requested by name against a
    // strict config that no longer defines it.
    if (hasChannelBridge) {
      args.push('--dangerously-load-development-channels', 'server:inkmail');
    }

    // Passthrough flags. Appended last, so they could override any flag
    // above; a withheld spawn takes none (Lumen).
    if (!withhold) {
      args.push(...config.passthroughArgs);
    }

    // Consolidated context token for x-ink-context header. The `.mcp.json`
    // generated by buildMergedMcpConfig references ${INK_CONTEXT}; this env
    // var is what Claude Code resolves at MCP connect time.
    //
    // The on-prompt hook reads cliAttached from this token, and an attached
    // prompt is the one that claims the turn epoch and renews the studio
    // lease. A headless `ink chat` declares false for its children, since the
    // server's run registry protects its turns. The one-shot wrapper keeps the
    // default, and detaches when the child exits (detachOnChildExit).
    const contextToken = encodeContextToken({
      sessionId: config.inkSessionId || '',
      studioId: config.studioId || '',
      sbSlug: config.sbSlug,
      cliAttached: config.cliAttached ?? true,
      runtime: 'claude',
    });

    // Injected turns switch stdin to stream-json: one JSONL user message
    // whose content is the prompt text plus base64 image blocks (and, on a
    // withheld turn, a text block for each document shown). Text-only
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
            content: [{ type: 'text', text: promptText }, ...contentBlocks],
          },
        }) + '\n';
    }

    return {
      binary: this.binary,
      args,
      env: {
        SB_SLUG: config.sbSlug,
        AGENT_ID: config.sbSlug,
        INK_CONTEXT: contextToken,
        ...(config.inkSessionId ? { INK_SESSION_ID: config.inkSessionId } : {}),
        ...(config.studioId ? { INK_STUDIO_ID: config.studioId } : {}),
        // `-p` cannot show a channel notification, so the inkmail plugin must
        // not poll here: it would ack messages the model never saw. The
        // config may still load it — the pass-through path is not strict.
        ...(printMode ? PRINT_MODE_CHANNEL_ENV : {}),
      },
      cleanup: mcpCleanup,
      ...(stdinData ? { stdinData } : {}),
      // Encoded images ride the stream-json message above (encoding needs a
      // prompt, and a prompt with blocks always switches to stream-json), so
      // what was injected is exactly what this spawn carries.
      ...(encodedContext && encodedContext.injected.length > 0
        ? { contextImagesDelivered: encodedContext.injected }
        : {}),
    };
  }

  createStreamParser(): BackendStreamParser {
    return new ClaudeStreamParser();
  }
}
