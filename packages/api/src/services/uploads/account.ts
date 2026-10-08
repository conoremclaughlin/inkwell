/**
 * Removing an account's uploads, for account deletion. An account's uploads
 * are kept until the account is deleted (Conor's retention choice, Oct 7).
 *
 * The tables have no foreign keys to users, on purpose (the migration says
 * why), so deleting a user removes nothing here. Account deletion calls
 * removeAccountUploads first, and again until it reports `complete`.
 *
 * One call, safe to repeat:
 *   - Every row of the account still holding bytes or slots is found by its
 *     user id. The account-slot index allows at most 50.
 *   - It runs only once the account's work has drained: its gate is closed
 *     and nothing of it is inside (account-deletion/gate.ts). The upload
 *     route holds that gate for its whole request, through its last
 *     filesystem step, so no writer of the account can still be filling a
 *     row. A row still receiving was abandoned, and its gate is closed.
 *   - Every row (receiving, open, claimed or not, or already removing)
 *     moves to removing with end_reason account_deleted; its bytes go, and
 *     only then does it become removed.
 *   - Once none is left, the account's folder goes too.
 * Anything waiting or stuck is retried by the next call; the heartbeat pass
 * also finishes stuck removals.
 *
 * eraseAccountUploadRecords then deletes the rows themselves, claims first,
 * once every one is removed. Whether account deletion keeps them (they hold
 * ids, sizes and digests, not content) is the caller's choice.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { removeAccountFolder, removeUploadBytes, type RemoveFolderResult } from './files';
import { isCanonicalId } from './layout';
import { locationOf, MAINTENANCE_BATCH, type RowForRemoval } from './maintenance';
import { beginRemoval, closeGate, finishRemoval } from './store';

export interface AccountRemovalDeps {
  db: SupabaseClient;
  /** The checked uploads root, or null when uploads are off here. */
  root: string | null;
  /** The API's clock, the one every created_at was written with. */
  now: () => number;
  remove?: typeof removeUploadBytes;
  removeFolder?: typeof removeAccountFolder;
  /**
   * Whether the account's work has drained: its gate is closed and nothing
   * of it is inside. Removal refuses otherwise.
   */
  drained: (userId: string) => boolean;
}

export interface AccountRemoval {
  /** No row of the account holds bytes or slots, and its folder is gone. */
  complete: boolean;
  /** Nothing was done, and why. */
  refused?: 'bad-account' | 'uploads-off' | 'account-not-drained';
  /** Rows this call took to removed. */
  removed: number;
  /** Rows whose bytes could not be confirmed gone; they stay removing for the next call. */
  stuck: number;
  /** Set once the rows are done: what became of the account's folder. */
  folder?: RemoveFolderResult;
}

interface AccountRow extends RowForRemoval {
  state: 'live' | 'removing';
  claim_gate: 'receiving' | 'open' | 'closed';
  created_at: string;
}

const HOLDING = ['live', 'removing'];

export async function removeAccountUploads(
  deps: AccountRemovalDeps,
  userId: string
): Promise<AccountRemoval> {
  const report: AccountRemoval = { complete: false, removed: 0, stuck: 0 };
  if (!isCanonicalId(userId)) return { ...report, refused: 'bad-account' };
  const root = deps.root;
  if (!root) return { ...report, refused: 'uploads-off' };
  if (!deps.drained(userId)) return { ...report, refused: 'account-not-drained' };

  const pass = await removeHeldRows(deps, root, 'user_id', userId, 'account_deleted');
  report.removed = pass.removed;
  report.stuck = pass.stuck;
  if (pass.left) return report;

  report.folder = await (deps.removeFolder ?? removeAccountFolder)(root, userId);
  report.complete = report.folder.gone;
  return report;
}

export interface SpaceRemoval {
  /** No row of the space holds bytes or slots, and its records are gone. */
  complete: boolean;
  refused?: 'bad-space' | 'uploads-off' | 'space-not-drained';
  removed: number;
  stuck: number;
}

/**
 * Remove a space's uploads, every member's, for deleting the space
 * (ink://specs/account-deletion v6 §8). The same rule as an account's: the
 * space's gate is closed and drained first, so no upload into it is still
 * being written; every row is then closed, its bytes removed, and only then
 * its records. Each member's own folder stays, holding their other spaces.
 */
export async function removeSpaceUploads(
  deps: Omit<AccountRemovalDeps, 'removeFolder'>,
  workspaceId: string
): Promise<SpaceRemoval> {
  const report: SpaceRemoval = { complete: false, removed: 0, stuck: 0 };
  if (!isCanonicalId(workspaceId)) return { ...report, refused: 'bad-space' };
  const root = deps.root;
  if (!root) {
    // Uploads off here: complete only if the space has none to remove.
    const { data, error } = await deps.db
      .from('thread_uploads')
      .select('id')
      .eq('workspace_id', workspaceId)
      .limit(1);
    if (error) throw new Error(`Failed to read a space's uploads: ${error.message}`);
    return (data ?? []).length === 0
      ? { ...report, complete: true }
      : { ...report, refused: 'uploads-off' };
  }
  if (!deps.drained(workspaceId)) return { ...report, refused: 'space-not-drained' };

  const pass = await removeHeldRows(deps, root, 'workspace_id', workspaceId, 'manual');
  report.removed = pass.removed;
  report.stuck = pass.stuck;
  if (pass.left) return report;

  const { data: rows, error } = await deps.db
    .from('thread_uploads')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('state', 'removed');
  if (error) throw new Error(`Failed to read a space's uploads: ${error.message}`);
  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  if (ids.length > 0) {
    const claims = await deps.db.from('thread_upload_claims').delete().in('upload_id', ids);
    if (claims.error) throw new Error(`Failed to delete a space's claims: ${claims.error.message}`);
    const uploads = await deps.db
      .from('thread_uploads')
      .delete()
      .in('id', ids)
      .eq('state', 'removed');
    if (uploads.error)
      throw new Error(`Failed to delete a space's uploads: ${uploads.error.message}`);
  }
  report.complete = true;
  return report;
}

/**
 * One batch: every row matching `column = value` that still holds bytes or
 * slots is closed, moved to removing, its bytes removed, then marked removed.
 * `left` says whether any such row remains afterwards (stuck, or beyond the
 * batch), read again so a row the batch missed keeps the caller incomplete.
 */
async function removeHeldRows(
  deps: Omit<AccountRemovalDeps, 'removeFolder'>,
  root: string,
  column: 'user_id' | 'workspace_id',
  value: string,
  reason: 'account_deleted' | 'manual'
): Promise<{ removed: number; stuck: number; left: boolean }> {
  const nowIso = new Date(deps.now()).toISOString();
  const { data, error } = await deps.db
    .from('thread_uploads')
    .select('id, user_id, workspace_id, content_type, state, claim_gate, created_at')
    .eq(column, value)
    .in('state', HOLDING)
    .order('id')
    .limit(MAINTENANCE_BATCH);
  if (error) throw new Error(`Failed to read uploads: ${error.message}`);

  let removed = 0;
  let stuck = 0;
  for (const row of (data ?? []) as AccountRow[]) {
    if (row.state === 'live') {
      // Drained: no writer is filling a receiving row, and no send can be
      // claiming an open one. Either gate is closed first, so nothing can
      // publish or claim it while its bytes go.
      if (row.claim_gate !== 'closed') await closeGate(deps.db, row.id, row.claim_gate);
      // Not begun means another pass moved it first; the removal below
      // finishes a removing row either way, and counts anything else as stuck
      // for the next call to look at again.
      await beginRemoval(deps.db, row.id, reason, nowIso);
    }
    const loc = locationOf(row);
    const gone = loc ? await (deps.remove ?? removeUploadBytes)(root, loc) : null;
    if (gone?.gone && (await finishRemoval(deps.db, row.id, nowIso))) removed += 1;
    else stuck += 1;
  }
  const { data: left, error: leftError } = await deps.db
    .from('thread_uploads')
    .select('id')
    .eq(column, value)
    .in('state', HOLDING)
    .limit(1);
  if (leftError) throw new Error(`Failed to read uploads: ${leftError.message}`);
  return { removed, stuck, left: (left ?? []).length > 0 };
}

export interface AccountRecordErasure {
  /** False while any row still holds bytes or slots: nothing was deleted. */
  erased: boolean;
  claims: number;
  uploads: number;
}

/**
 * Delete an account's upload rows and their claims, once every row is
 * removed: the rows are what says which bytes to remove, so they go last.
 * Claims first, since each claim's foreign key names its upload. A claim
 * always carries its upload's user id, so this reaches every claim on the
 * account's uploads and nothing else.
 */
export async function eraseAccountUploadRecords(
  db: SupabaseClient,
  userId: string
): Promise<AccountRecordErasure> {
  const none: AccountRecordErasure = { erased: false, claims: 0, uploads: 0 };
  if (!isCanonicalId(userId)) return none;
  const { data: held, error } = await db
    .from('thread_uploads')
    .select('id')
    .eq('user_id', userId)
    .in('state', HOLDING)
    .limit(1);
  if (error) throw new Error(`Failed to read an account's uploads: ${error.message}`);
  if ((held ?? []).length > 0) return none;

  const claims = await db
    .from('thread_upload_claims')
    .delete()
    .eq('user_id', userId)
    .select('upload_id');
  if (claims.error)
    throw new Error(`Failed to delete an account's claims: ${claims.error.message}`);
  const uploads = await db
    .from('thread_uploads')
    .delete()
    .eq('user_id', userId)
    .eq('state', 'removed')
    .select('id');
  if (uploads.error)
    throw new Error(`Failed to delete an account's uploads: ${uploads.error.message}`);
  return { erased: true, claims: (claims.data ?? []).length, uploads: (uploads.data ?? []).length };
}
