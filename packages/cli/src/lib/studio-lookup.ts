/**
 * The server's studio row for a worktree, looked up by path.
 *
 * Shared by the launch repair (`completeStudioForLaunch`) and a manual
 * `ink init`, which both need the row's owner and permission profile and
 * must never take either from the checkout: the worktree may be the code
 * under review. Three answers, and only `found` licenses a write that names
 * the row: `none` (the server confirms no row) and `unknown` (no answer)
 * both mean no profile.
 */

import { studioPermissionProfile, type StudioPermissionProfile } from '@inklabs/shared';
import { callInkTool } from './ink-mcp.js';

export interface StudioRowSummary {
  id?: string;
  sbSlug?: string;
  /** From the row (`studioPermissionProfile`), never from the worktree. */
  permissionProfile?: StudioPermissionProfile;
}

export type StudioLookup =
  | { status: 'found'; row: StudioRowSummary }
  | { status: 'none' }
  | { status: 'unknown'; reason: string };

/** The server's own words for a worktree it has no row for. */
const NOT_FOUND = /studio not found/i;

/**
 * get_studio by path, bounded. A "Studio not found" from the server is the
 * one answer that means none; every other failure is no answer at all.
 */
export async function lookupStudioByPath(worktreePath: string): Promise<StudioLookup> {
  try {
    const result = await callInkTool<{
      studio?: {
        id?: string;
        sbSlug?: string;
        branch?: string;
        metadata?: unknown;
        roleTemplate?: string | null;
        threadKey?: string | null;
      };
    }>('get_studio', { path: worktreePath }, { timeoutMs: 3000, idempotent: true });
    if (result?.studio?.id) {
      const profile = studioPermissionProfile(result.studio);
      return {
        status: 'found',
        row: {
          id: result.studio.id,
          ...(result.studio.sbSlug ? { sbSlug: result.studio.sbSlug } : {}),
          ...(profile ? { permissionProfile: profile } : {}),
        },
      };
    }
    return { status: 'unknown', reason: 'the server returned no studio and no error' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (NOT_FOUND.test(message)) return { status: 'none' };
    return { status: 'unknown', reason: message };
  }
}
