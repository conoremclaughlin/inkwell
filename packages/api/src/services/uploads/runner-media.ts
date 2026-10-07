/**
 * What a runner may do with a person's uploads among a turn's attachments.
 *
 * An upload attachment's path lies under the uploads root, in a directory of
 * its own: `<root>/<userId>/<workspaceId>/<uploadId>/`. A runner that can
 * grant a directory for one spawn is given exactly those directories, never
 * the root or a person's or workspace's level above them. A runner that
 * cannot, or a turn running in a container (which mounts no host media),
 * gets the uploads dropped and one line the turn can see saying so. Other
 * attachments pass through untouched.
 */

import { dirname, relative, sep } from 'path';
import type { MediaAttachment } from '../sessions/types';
import { isCanonicalId, isWithin } from './layout';
import { uploadsRoot } from './runtime';

export type UploadMediaPolicy = 'grant' | 'refuse';

export interface RunnerUploadMedia {
  /** Attachments the runner should receive. */
  attachments: MediaAttachment[];
  /** Per-upload directories to grant for this spawn only. */
  grantDirs: string[];
  /**
   * The upload attachments left out, as the same objects that came in, so
   * the caller can leave their paths out of the prompt too.
   */
  dropped: MediaAttachment[];
  /** Appended to the turn's message when an upload had to be dropped; else null. */
  note: string | null;
}

/** The upload's own directory, or null when the path is not exactly one upload's file. */
export function uploadDirOf(path: string, root: string): string | null {
  if (!isWithin(root, path) || path === root) return null;
  const parts = relative(root, path).split(sep);
  if (parts.length !== 4) return null;
  const [userId, workspaceId, uploadId, file] = parts;
  if (![userId, workspaceId, uploadId].every(isCanonicalId)) return null;
  if (!file.startsWith(`${uploadId}.`)) return null;
  return dirname(path);
}

/**
 * For a runner that declares `grant`: the per-upload directories its backend
 * needs for this spawn. None in a container, which mounts no host media.
 */
export function uploadDirsToGrant(
  attachments: readonly MediaAttachment[] | undefined,
  container: boolean
): string[] {
  return uploadMediaForRunner({
    attachments,
    root: uploadsRoot(),
    policy: 'grant',
    sandboxed: container,
  }).grantDirs;
}

export function uploadMediaForRunner(input: {
  attachments: readonly MediaAttachment[] | undefined;
  root: string | null;
  policy: UploadMediaPolicy;
  sandboxed: boolean;
}): RunnerUploadMedia {
  const attachments: MediaAttachment[] = [];
  const grantDirs: string[] = [];
  const dropped: MediaAttachment[] = [];
  for (const attachment of input.attachments ?? []) {
    const path = attachment.path;
    const isUpload = !!path && !!input.root && isWithin(input.root, path);
    if (!isUpload) {
      attachments.push(attachment);
      continue;
    }
    const dir = uploadDirOf(path, input.root!);
    // Anything but a declared grant refuses, including a runner that slipped
    // past the type without declaring one.
    if (!dir || input.policy !== 'grant' || input.sandboxed) {
      dropped.push(attachment);
      continue;
    }
    attachments.push(attachment);
    if (!grantDirs.includes(dir)) grantDirs.push(dir);
  }
  return {
    attachments,
    grantDirs,
    dropped,
    note:
      dropped.length === 0
        ? null
        : dropped.length === 1
          ? '(One attached file could not be opened in this runtime.)'
          : `(${dropped.length} attached files could not be opened in this runtime.)`,
  };
}
