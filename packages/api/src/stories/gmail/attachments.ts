/**
 * Resolve outbound email attachments from agent-referenced paths.
 *
 * Reuses the containment boundary in channels/agent-media.ts rather than
 * re-implementing it: a referenced file must realpath inside the shared
 * media root (~/.ink/files), be a regular file with a single hard link,
 * and be read through one O_NOFOLLOW descriptor. Without that, an agent
 * could name ~/.ssh/id_rsa or .env.local and mail it out — a strictly
 * worse leak than the in-context one the trigger path guards, because it
 * leaves the machine.
 *
 * The one deliberate divergence from trigger media: this path fails the
 * whole send instead of dropping bad entries. Silently mailing a message
 * without the photos it was supposed to carry looks like success to the
 * user and to the agent; a loud error does not.
 */

import { basename } from 'path';
import {
  defaultMediaRoot,
  describeContainedFileRejection,
  readContainedFile,
  resolveMediaRoot,
} from '../../channels/agent-media';
import { logger } from '../../utils/logger';
import { guessMimeType, MAX_FILENAME_BYTES, type OutboundAttachment } from './mime';

/** Max attachments on a single outgoing message. */
export const MAX_OUTBOUND_ATTACHMENTS = 10;

/** Per-file cap, matching the trigger-media cap. */
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Total raw bytes across all attachments. Gmail caps a whole message at
 * 25MB *after* base64 inflates it by ~4/3, so raw payload has to stay
 * under ~18.7MB. 18MB leaves room for headers and body.
 */
export const MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;

export interface AttachmentRequest {
  path: string;
  filename?: string;
}

export interface ResolveOutboundOptions {
  mediaRoot?: string;
  /** Test hook — production always uses MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES. */
  maxTotalBytes?: number;
  /** Test hook — production always uses MAX_OUTBOUND_ATTACHMENT_BYTES. */
  maxFileBytes?: number;
}

/** Thrown when an attachment cannot be used; aborts the send. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * Read and validate every referenced attachment, or throw.
 *
 * Returns MIME-ready parts with their bytes already in memory, so the
 * caller assembles the message from verified content rather than from
 * paths that could change underneath it.
 */
export async function resolveOutboundAttachments(
  requests: AttachmentRequest[],
  options: ResolveOutboundOptions = {}
): Promise<OutboundAttachment[]> {
  if (requests.length === 0) return [];

  const mediaRoot = options.mediaRoot ?? defaultMediaRoot();
  const maxFileBytes = options.maxFileBytes ?? MAX_OUTBOUND_ATTACHMENT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES;

  if (requests.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new AttachmentError(
      `Too many attachments: ${requests.length} (max ${MAX_OUTBOUND_ATTACHMENTS}).`
    );
  }

  const rootReal = await resolveMediaRoot(mediaRoot);
  if (!rootReal) {
    throw new AttachmentError(
      `Shared media directory is unavailable (${mediaRoot}); cannot attach files.`
    );
  }

  const resolved: OutboundAttachment[] = [];
  let totalBytes = 0;

  for (const request of requests) {
    if (typeof request?.path !== 'string' || request.path.length === 0) {
      throw new AttachmentError('Attachment entry is missing a path.');
    }

    const read = await readContainedFile(request.path, rootReal, maxFileBytes);
    if (!read.ok) {
      logger.warn('[Gmail] outbound attachment rejected', {
        path: request.path,
        reason: read.reason,
      });
      throw new AttachmentError(
        `Cannot attach "${request.path}": ${describeContainedFileRejection(read.reason, mediaRoot)}. ` +
          `Attachments must be files inside ${mediaRoot} — use download_email_attachment or save the file there first.`
      );
    }

    totalBytes += read.bytes.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new AttachmentError(
        `Attachments exceed the total size limit of ${Math.floor(maxTotalBytes / (1024 * 1024))}MB. ` +
          `Send fewer or smaller files, or share them via Drive.`
      );
    }

    const filename = (request.filename || basename(read.realPath)).trim() || 'attachment';
    // Bounded in BYTES, not characters: 255 characters of non-ASCII is 765
    // bytes encoded, which would breach the header line limit during
    // assembly. Checked here so the caller gets an AttachmentError naming
    // the file rather than a bare failure from the MIME layer.
    const filenameBytes = Buffer.byteLength(filename, 'utf8');
    if (filenameBytes > MAX_FILENAME_BYTES) {
      throw new AttachmentError(
        `Cannot attach "${request.path}": the filename is ${filenameBytes} bytes ` +
          `(max ${MAX_FILENAME_BYTES}). Pass a shorter \`filename\`.`
      );
    }

    // Content-Type describes the BYTES; `filename` is presentation-only and
    // never gets a say. Deriving the type from the display name let a rename
    // silently change the declared type — a JPEG attached as `scan.pdf` went
    // out as `application/pdf` (found by Myra during live verification).
    //
    // A real file we cannot type stays `application/octet-stream`. Borrowing
    // the display name there would reinstate the same defect through the back
    // door: `payload.html` shown as `report.pdf` would be declared a PDF on
    // the strength of a name that has never seen the bytes. An honest
    // "unknown" beats a confident wrong answer.
    resolved.push({
      filename,
      mimeType: guessMimeType(basename(read.realPath)),
      content: read.bytes,
    });
  }

  logger.info('[Gmail] resolved outbound attachments', {
    count: resolved.length,
    totalBytes,
  });

  return resolved;
}
