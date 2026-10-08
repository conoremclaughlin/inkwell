/**
 * File attachments for chat turns
 *
 * Media reaches ink chat as local file paths (--attach-file), downloaded
 * by the server's channel listeners (Telegram, Discord, Gmail) to
 * ~/.ink/files/<channel>/. The runtime forwards them to the provider
 * backend three ways (spec:provider-media-injection):
 *
 *   1. Injection as prompt CONTENT for supported images — claude embeds
 *      base64 image blocks via stream-json stdin; codex attaches
 *      `--image=` flags. The preferred path: no filesystem tool needed.
 *   2. An attachment block appended to the turn's message text — the
 *      backend learns the exact path of every attachment.
 *   3. Directory access for the backend spawn (claude: --add-dir per
 *      attachment directory) so explicitly unsupported types (documents,
 *      audio) are readable via the gated native-read fallback.
 */

import { stat } from 'fs/promises';
import { dirname, extname } from 'path';

export interface ResolvedAttachment {
  path: string;
  /** Detected from extension; undefined when unknown */
  mime?: string;
  /** Human-readable size (e.g., "142KB"); undefined when stat failed */
  sizeLabel?: string;
  /** True when the file is missing or unreadable */
  missing?: boolean;
}

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

export function detectMime(filePath: string): string | undefined {
  return EXTENSION_MIME[extname(filePath).toLowerCase()];
}

/** Stat each path, attaching mime + size; missing files are flagged, not dropped. */
export async function resolveAttachments(paths: string[]): Promise<ResolvedAttachment[]> {
  const resolved: ResolvedAttachment[] = [];
  for (const path of paths) {
    const mime = detectMime(path);
    try {
      const info = await stat(path);
      const kb = Math.max(1, Math.round(info.size / 1024));
      resolved.push({ path, mime, sizeLabel: `${kb}KB` });
    } catch {
      resolved.push({ path, mime, missing: true });
    }
  }
  return resolved;
}

/**
 * The text block appended to a turn's message so the backend knows what
 * was attached and how to view it. Missing files are listed as such —
 * silently dropping them reads as "covered" when it isn't.
 */
export function buildAttachmentBlock(attachments: ResolvedAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines = ['[Attached files]'];
  for (const a of attachments) {
    const meta = [a.mime, a.sizeLabel].filter(Boolean).join(', ');
    lines.push(
      `- ${a.path}${meta ? ` (${meta})` : ''}${a.missing ? ' — MISSING (not readable)' : ''}`
    );
  }
  lines.push(
    'Images may be attached inline with this message; use your file-reading tool (when available) for any files not shown inline.'
  );
  return lines.join('\n');
}

/** Unique parent directories of readable attachments — for backend --add-dir grants. */
export function collectAttachmentDirs(attachments: ResolvedAttachment[]): string[] {
  const dirs = new Set<string>();
  for (const a of attachments) {
    if (!a.missing) dirs.add(dirname(a.path));
  }
  return [...dirs];
}
