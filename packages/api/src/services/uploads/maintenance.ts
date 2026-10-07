/**
 * The uploads sweep and reconciler, run on the heartbeat tick (upload design
 * r4 §3, r5).
 *
 * It runs only where reminder processing runs: the same three flags and the
 * same worktree auto-disable (config/heartbeat-flags.ts), so an isolated or
 * test server never sweeps the shared database's uploads.
 *
 * What one pass does, and what it never does:
 *   - An upload no send has claimed, an hour after the API wrote it and with
 *     its gate open, is an orphan: the gate closes first (against a claim the
 *     foreign key refuses, and the claim wins), then the row moves to
 *     removing and its bytes go. A `receiving` row is never touched on age:
 *     its writer may still be running, and nothing frees a slot while a
 *     writer can still publish bytes. It is counted as held.
 *   - A row left `removing` by an earlier pass or a failed write is retried;
 *     it becomes `removed`, freeing its slots, only once the bytes are
 *     confirmed gone.
 *   - A claim with no confirmed message is confirmed when its committed
 *     message matches, otherwise held. A failed read changes nothing.
 *     Nothing here deletes a claimed upload; there is no retention yet.
 *   - A claimed upload still holding a pending slot (its send's release was
 *     lost) has the slot released.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getHeartbeatProcessingConfig } from '../../config/heartbeat-flags';
import { PENDING_TTL_MS } from './authorize';
import { reconcileClaim, type ReconcileLookup, type StoredClaim } from './claims';
import { removeUploadBytes } from './files';
import type { UploadLocation } from './layout';
import { extForContentType } from './sniff';
import { beginRemoval, closeGate, finishRemoval, loadClaim, loadClaimedMessage } from './store';

/** Rows looked at per step per pass. */
export const MAINTENANCE_BATCH = 100;

/**
 * Where each step resumes: the last key it looked at, or '' to start over.
 * Each pass takes the next page after its cursor and wraps once a page comes
 * back short, so rows that stay put (held, stuck) can never keep the rows
 * after them from being reached.
 */
export interface MaintenanceCursors {
  pending: string;
  removing: string;
  claims: string;
}

export function newMaintenanceCursors(): MaintenanceCursors {
  return { pending: '', removing: '', claims: '' };
}

const processCursors = newMaintenanceCursors();

export interface MaintenanceDeps {
  db: SupabaseClient;
  root: string | null;
  /** The API's clock, the one every created_at was written with. */
  now: () => number;
  env?: NodeJS.ProcessEnv;
  remove?: typeof removeUploadBytes;
  /** This process's own by default. */
  cursors?: MaintenanceCursors;
}

export interface MaintenanceReport {
  skipped?: 'heartbeats-off' | 'uploads-off';
  orphansRemoved: number;
  receivingHeld: number;
  pendingReleased: number;
  removalsFinished: number;
  removalsStuck: number;
  confirmed: number;
  held: number;
  readFailed: number;
}

/** True exactly where reminder processing is enabled. */
export function uploadsMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getHeartbeatProcessingConfig(env).enabled;
}

const emptyReport = (): MaintenanceReport => ({
  orphansRemoved: 0,
  receivingHeld: 0,
  pendingReleased: 0,
  removalsFinished: 0,
  removalsStuck: 0,
  confirmed: 0,
  held: 0,
  readFailed: 0,
});

export async function maintainUploads(deps: MaintenanceDeps): Promise<MaintenanceReport> {
  const report = emptyReport();
  if (!uploadsMaintenanceEnabled(deps.env)) return { ...report, skipped: 'heartbeats-off' };
  if (!deps.root) return { ...report, skipped: 'uploads-off' };
  await sweepPending(deps, deps.root, report);
  await finishRemovals(deps, deps.root, report);
  await reconcileClaims(deps, report);
  return report;
}

interface RowForRemoval {
  id: string;
  user_id: string;
  workspace_id: string;
  content_type: string;
}

function locationOf(row: RowForRemoval): UploadLocation | null {
  const ext = extForContentType(row.content_type);
  return ext ? { userId: row.user_id, workspaceId: row.workspace_id, uploadId: row.id, ext } : null;
}

const iso = (deps: MaintenanceDeps) => new Date(deps.now()).toISOString();

/** Remove a `removing` row's bytes, and mark it removed only if they are confirmed gone. */
async function removeAndFinish(
  deps: MaintenanceDeps,
  root: string,
  row: RowForRemoval,
  report: MaintenanceReport
): Promise<boolean> {
  const loc = locationOf(row);
  const removed = loc ? await (deps.remove ?? removeUploadBytes)(root, loc) : null;
  if (removed?.gone && (await finishRemoval(deps.db, row.id, iso(deps)))) return true;
  report.removalsStuck += 1;
  return false;
}

/**
 * The next page of a step's rows after its cursor, by key, and the cursor
 * moved past them (or back to the start when the page is short).
 */
async function nextPage<T extends object>(
  cursors: MaintenanceCursors,
  step: keyof MaintenanceCursors,
  key: string,
  query: (after: string | null) => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<T[]> {
  const { data, error } = await query(cursors[step] || null);
  if (error) throw new Error(`Failed to read uploads for maintenance (${step}): ${error.message}`);
  const rows = (data ?? []) as T[];
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  cursors[step] = rows.length < MAINTENANCE_BATCH || !last ? '' : String(last[key]);
  return rows;
}

/**
 * Open rows still holding a pending slot: every finished upload no send has
 * claimed, plus any claimed one whose release was lost. A `receiving` row is
 * never among them: its writer may still be running, and it is counted as
 * held instead.
 */
async function sweepPending(
  deps: MaintenanceDeps,
  root: string,
  report: MaintenanceReport
): Promise<void> {
  const cursors = deps.cursors ?? processCursors;
  const rows = await nextPage<RowForRemoval & { created_at: string }>(
    cursors,
    'pending',
    'id',
    (after) => {
      let query = deps.db
        .from('thread_uploads')
        .select('id, user_id, workspace_id, content_type, created_at')
        .eq('state', 'live')
        .eq('claim_gate', 'open')
        // Every slot that is set is 0 or more; null (released) is excluded.
        .gt('pending_slot', -1);
      if (after) query = query.gt('id', after);
      return query.order('id', { ascending: true }).limit(MAINTENANCE_BATCH);
    }
  );
  for (const row of rows) {
    if (await loadClaim(deps.db, row.id)) {
      const { error: releaseError } = await deps.db
        .from('thread_uploads')
        .update({ pending_slot: null })
        .eq('id', row.id);
      if (!releaseError) report.pendingReleased += 1;
      continue;
    }
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || deps.now() - created < PENDING_TTL_MS) continue;
    if (!(await closeGate(deps.db, row.id, 'open'))) continue;
    if (!(await beginRemoval(deps.db, row.id, 'orphan', iso(deps)))) continue;
    if (await removeAndFinish(deps, root, row, report)) report.orphansRemoved += 1;
  }
  await countHeldReceiving(deps, report);
}

/** Reported, never touched: receiving rows past the pending hour (at most one page's worth). */
async function countHeldReceiving(deps: MaintenanceDeps, report: MaintenanceReport): Promise<void> {
  const { data, error } = await deps.db
    .from('thread_uploads')
    .select('id, created_at')
    .eq('state', 'live')
    .eq('claim_gate', 'receiving')
    .limit(MAINTENANCE_BATCH);
  if (error) throw new Error(`Failed to read receiving uploads: ${error.message}`);
  for (const row of (data ?? []) as Array<{ created_at: string }>) {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || deps.now() - created >= PENDING_TTL_MS) {
      report.receivingHeld += 1;
    }
  }
}

async function finishRemovals(
  deps: MaintenanceDeps,
  root: string,
  report: MaintenanceReport
): Promise<void> {
  const rows = await nextPage<RowForRemoval>(
    deps.cursors ?? processCursors,
    'removing',
    'id',
    (after) => {
      let query = deps.db
        .from('thread_uploads')
        .select('id, user_id, workspace_id, content_type')
        .eq('state', 'removing');
      if (after) query = query.gt('id', after);
      return query.order('id', { ascending: true }).limit(MAINTENANCE_BATCH);
    }
  );
  for (const row of rows) {
    if (await removeAndFinish(deps, root, row, report)) report.removalsFinished += 1;
  }
}

/**
 * Claims with no confirmed message, a page per pass. Held claims come round
 * again, since their message may still commit; the cursor keeps any number
 * of them from holding back the claims after them.
 */
async function reconcileClaims(deps: MaintenanceDeps, report: MaintenanceReport): Promise<void> {
  const claims = await nextPage<StoredClaim>(
    deps.cursors ?? processCursors,
    'claims',
    'upload_id',
    (after) => {
      let query = deps.db
        .from('thread_upload_claims')
        .select(
          'upload_id, thread_id, client_message_id, user_id, content_sha256, manifest_sha256, manifest_index, message_id, held_reason, created_at'
        )
        .is('message_id', null);
      if (after) query = query.gt('upload_id', after);
      return query.order('upload_id', { ascending: true }).limit(MAINTENANCE_BATCH);
    }
  );
  const lookups = new Map<string, ReconcileLookup>();
  for (const claim of claims) {
    const send = `${claim.thread_id}|${claim.client_message_id}`;
    let lookup = lookups.get(send);
    if (!lookup) {
      try {
        const message = await loadClaimedMessage(deps.db, claim);
        lookup = message ? { kind: 'found', message } : { kind: 'none' };
      } catch {
        lookup = { kind: 'error' };
      }
      lookups.set(send, lookup);
    }
    const outcome = reconcileClaim(claim, lookup, deps.now());
    if (outcome.action === 'skip') {
      if (outcome.why === 'read-failed') report.readFailed += 1;
      continue;
    }
    // Already held for this reason: nothing new to record.
    if (outcome.action === 'hold' && claim.held_reason === outcome.reason) continue;
    const patch =
      outcome.action === 'confirm'
        ? { message_id: outcome.messageId, held_reason: null, held_at: null }
        : { held_reason: outcome.reason, held_at: iso(deps) };
    const { error: writeError } = await deps.db
      .from('thread_upload_claims')
      .update(patch)
      .eq('upload_id', claim.upload_id)
      .is('message_id', null);
    if (writeError) continue;
    if (outcome.action === 'confirm') report.confirmed += 1;
    else report.held += 1;
  }
}
