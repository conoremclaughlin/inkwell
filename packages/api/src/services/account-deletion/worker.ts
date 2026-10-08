/**
 * Account deletion, one step at a time (ink://specs/account-deletion v6 §4).
 *
 * The worker runs in the main server, the one process that serves consumer
 * accounts. It takes requests oldest first and advances each until it
 * completes or a step holds. Every step can be repeated: a step moves the
 * request forward only by an update conditional on the step it read, and
 * records its outcome before the next one begins. After a restart the
 * worker resumes where the request row says it stopped.
 *
 *   requested → closed        the account may be deleted (eligibility.ts);
 *                             its gate is closed, so it takes no new work
 *   closed → auth_revoked     its Supabase sign-in is deleted
 *   auth_revoked → drained    its live turns are stopped, and nothing of it
 *                             is inside its gate or on another server
 *   drained → files_removed   the inventory is fixed from the rows as they
 *                             stand now, and every file in it is removed
 *   files_removed →
 *     rows_removed            delete_account, one transaction, which also
 *                             writes this step
 *   rows_removed → completed  nothing of the account remains
 *
 * A hold leaves the request where it is, with its reason in `outcomes`. A
 * drain that times out never reaches files or rows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import { eraseAccountUploadRecords, removeAccountUploads } from '../uploads/account';
import { deletionIneligibility } from './eligibility';
import {
  allAbsent,
  inventoryFor,
  removeTarget,
  type FileTarget,
  type InventoryRoots,
} from './files';
import { accountGate } from './gate';

export type DeletionStep =
  | 'requested'
  | 'closed'
  | 'auth_revoked'
  | 'drained'
  | 'files_removed'
  | 'rows_removed'
  | 'completed';

/** How long a completed request's record is kept (Q-C: Myra's 30-day default). */
export const REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeletionDeps {
  db: SupabaseClient<Database>;
  /** Delete the Supabase sign-in. "Not found" is done. */
  deleteAuthUser(authUid: string): Promise<'deleted' | 'absent'>;
  /** Stop every live turn of these identities (inkling-turns.ts). */
  stopTurns(sbIds: string[]): void;
  /** This process's server instance, as its launch rows name it. */
  serverInstance(): string | undefined;
  roots: InventoryRoots;
  /** The checked uploads root, or null when uploads are off here. */
  uploadsRoot: string | null;
  /** Remove the account's saved logins and their secrets, when that store exists. */
  removeSavedLogins?(userId: string): Promise<void>;
  drainTimeoutMs: number;
  now(): number;
  /**
   * Where the last sweep stopped. Each sweep takes the next requests after
   * it, so twenty that keep holding can't keep newer ones from ever being
   * reached (Lumen, #783). Without one, every sweep starts at the oldest.
   */
  sweep?: SweepCursor;
}

export interface SweepCursor {
  /** The `requested_at` of the last request the previous sweep took, or null to start at the oldest. */
  after: string | null;
}

/** How many requests one sweep advances. */
export const SWEEP_SIZE = 20;

interface RequestRow {
  user_id: string;
  step: DeletionStep;
  auth_uid: string | null;
  inventory: Json | null;
  outcomes: Json;
  completed_at: string | null;
}

interface Inventory {
  sbIds: string[];
  sessionIds: string[];
  uploads: boolean;
  files: FileTarget[];
}

export interface Advance {
  step: DeletionStep;
  /** Why the request is holding where it is. */
  held?: string;
}

/** At startup, before the server takes work: close every deletion in progress. */
export async function closeDeletionsInProgress(db: SupabaseClient<Database>): Promise<number> {
  const { data, error } = await db
    .from('account_deletion_requests')
    .select('user_id')
    .not('started_at', 'is', null)
    .is('completed_at', null);
  if (error) throw new Error(`Could not read deletions in progress: ${error.message}`);
  for (const row of data ?? []) accountGate.close(row.user_id);
  return (data ?? []).length;
}

/**
 * Advance up to SWEEP_SIZE pending requests as far as each goes, in request
 * order from where the last sweep stopped. A sweep that reaches the newest
 * request sends the next one back to the oldest.
 */
export async function processDeletions(deps: DeletionDeps): Promise<Advance[]> {
  let query = deps.db
    .from('account_deletion_requests')
    .select('user_id, requested_at')
    .is('completed_at', null)
    .order('requested_at', { ascending: true })
    .limit(SWEEP_SIZE);
  if (deps.sweep?.after) query = query.gt('requested_at', deps.sweep.after);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read deletion requests: ${error.message}`);
  if (deps.sweep) {
    const rows = data ?? [];
    deps.sweep.after = rows.length === SWEEP_SIZE ? rows[rows.length - 1].requested_at : null;
  }
  const results: Advance[] = [];
  for (const row of data ?? []) {
    try {
      results.push(await advanceDeletion(deps, row.user_id));
    } catch (err) {
      logger.warn('[AccountDeletion] A step failed; it will be tried again', {
        userId: row.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await requestDeletionOfRecreatedAccounts(deps);
  await purgeExpiredRequests(deps);
  return results;
}

/**
 * An account bound to a sign-in this worker already deleted can only have
 * been created by a request that verified the sign-in before its deletion and
 * finished after it: accounts are always created bound (principal.ts), and a
 * deleted sign-in is never reused. Each one is given a deletion request of
 * its own, which then runs the whole procedure with its refusals and holds.
 * Nothing is deleted here, and no other account is a candidate.
 */
async function requestDeletionOfRecreatedAccounts(deps: DeletionDeps): Promise<void> {
  const { data: completed, error } = await deps.db
    .from('account_deletion_requests')
    .select('auth_uid')
    .eq('step', 'completed')
    .not('auth_uid', 'is', null)
    .limit(500);
  if (error) {
    logger.warn('[AccountDeletion] Could not read completed deletions', { error: error.message });
    return;
  }
  const deletedSignIns = (completed ?? []).map((r) => r.auth_uid).filter((v): v is string => !!v);
  if (deletedSignIns.length === 0) return;
  const { data: recreated, error: usersError } = await deps.db
    .from('users')
    .select('id, auth_uid, email')
    .in('auth_uid', deletedSignIns);
  if (usersError) {
    logger.warn('[AccountDeletion] Could not look for re-created accounts', {
      error: usersError.message,
    });
    return;
  }
  for (const user of recreated ?? []) {
    const { error: insertError } = await deps.db
      .from('account_deletion_requests')
      .upsert(
        { user_id: user.id, auth_uid: user.auth_uid, email_sha256: null },
        { onConflict: 'user_id', ignoreDuplicates: true }
      );
    if (insertError) {
      logger.warn('[AccountDeletion] Could not request deletion of a re-created account', {
        userId: user.id,
        error: insertError.message,
      });
    } else {
      logger.warn(
        '[AccountDeletion] An account was re-created for a deleted sign-in; deleting it',
        {
          userId: user.id,
        }
      );
    }
  }
}

/** Take one request as far as it can go now. */
export async function advanceDeletion(deps: DeletionDeps, userId: string): Promise<Advance> {
  for (let guard = 0; guard < 8; guard += 1) {
    const row = await readRequest(deps.db, userId);
    if (!row) return { step: 'completed', held: 'no request' };
    const next = await runStep(deps, row);
    if (next.held || next.step === 'completed') return next;
  }
  return { step: (await readRequest(deps.db, userId))?.step ?? 'completed' };
}

async function runStep(deps: DeletionDeps, row: RequestRow): Promise<Advance> {
  const { db } = deps;
  const userId = row.user_id;
  switch (row.step) {
    case 'requested': {
      const problem = await deletionIneligibility(db, userId);
      if (problem) {
        return hold(
          deps,
          row,
          'close',
          problem.reason === 'operator-account'
            ? problem.detail
            : 'it owns a space with other members'
        );
      }
      const startedAt = new Date(deps.now()).toISOString();
      if (!(await moveTo(db, userId, 'requested', 'closed', { started_at: startedAt }))) {
        return { step: row.step };
      }
      accountGate.close(userId);
      return { step: 'closed' };
    }
    case 'closed': {
      accountGate.close(userId);
      const authUid = row.auth_uid ?? (await boundAuthUid(db, userId));
      if (!authUid)
        return hold(deps, row, 'revoke', 'the sign-in this account belongs to is not known');
      await deps.deleteAuthUser(authUid);
      await moveTo(db, userId, 'closed', 'auth_revoked');
      return { step: 'auth_revoked' };
    }
    case 'auth_revoked': {
      accountGate.close(userId);
      const sbIds = await identityIds(db, userId);
      deps.stopTurns(sbIds);
      const drained = await accountGate.waitDrained(userId, deps.drainTimeoutMs);
      if (!drained) return hold(deps, row, 'drain', 'work of the account is still running');
      const foreign = await foreignLaunches(deps, userId);
      if (foreign > 0) {
        return hold(deps, row, 'drain', 'a launch of the account belongs to another server');
      }
      await moveTo(db, userId, 'auth_revoked', 'drained');
      return { step: 'drained' };
    }
    case 'drained': {
      accountGate.close(userId);
      const inventory = await fixInventory(deps, row);
      const outcomes = [];
      for (const target of inventory.files) outcomes.push(await removeTarget(target));
      const heldFile = outcomes.find((o) => o.result === 'held');
      if (heldFile) {
        await recordOutcome(db, row, 'files', outcomes);
        return hold(
          deps,
          row,
          'files',
          `${heldFile.kind} held: ${'reason' in heldFile ? heldFile.reason : ''}`
        );
      }
      if (deps.removeSavedLogins) await deps.removeSavedLogins(userId);
      const uploads = await removeAccountUploads(
        {
          db: db as never,
          root: deps.uploadsRoot,
          now: deps.now,
          drained: (id) => accountGate.isClosed(id) && accountGate.inFlightCount(id) === 0,
        },
        userId
      );
      if (!uploads.complete && uploads.refused !== 'uploads-off') {
        await recordOutcome(db, row, 'files', { files: outcomes, uploads });
        return hold(deps, row, 'files', 'uploads are not all removed yet');
      }
      if (uploads.refused === 'uploads-off' && (await hasUploadRows(db, userId))) {
        return hold(deps, row, 'files', 'uploads are off on this server, and the account has some');
      }
      const erased = await eraseAccountUploadRecords(db as never, userId);
      if (!erased.erased && (await hasUploadRows(db, userId))) {
        return hold(deps, row, 'files', 'upload records remain');
      }
      await recordOutcome(db, row, 'files', { files: outcomes, uploads, erased });
      await moveTo(db, userId, 'drained', 'files_removed');
      return { step: 'files_removed' };
    }
    case 'files_removed': {
      const { data, error } = await db.rpc(
        'delete_account' as never,
        { p_user_id: userId } as never
      );
      if (error) return hold(deps, row, 'rows', error.message);
      logger.info('[AccountDeletion] Rows removed', { userId, counts: data });
      return { step: 'rows_removed' };
    }
    case 'rows_removed': {
      const inventory = parseInventory(row.inventory);
      const remaining = await anythingLeft(deps, userId, inventory);
      if (remaining) return hold(deps, row, 'complete', remaining);
      const done = await moveTo(db, userId, 'rows_removed', 'completed', {
        completed_at: new Date(deps.now()).toISOString(),
      });
      if (done) accountGate.forget(userId);
      logger.info('[AccountDeletion] Completed', { userId });
      return { step: 'completed' };
    }
    case 'completed':
      return { step: 'completed' };
  }
}

async function readRequest(
  db: SupabaseClient<Database>,
  userId: string
): Promise<RequestRow | null> {
  const { data, error } = await db
    .from('account_deletion_requests')
    .select('user_id, step, auth_uid, inventory, outcomes, completed_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the deletion request: ${error.message}`);
  return (data as RequestRow | null) ?? null;
}

/** Move forward only from the step that was read; false if another call did. */
async function moveTo(
  db: SupabaseClient<Database>,
  userId: string,
  from: DeletionStep,
  to: DeletionStep,
  extra: Record<string, string> = {}
): Promise<boolean> {
  const { data, error } = await db
    .from('account_deletion_requests')
    .update({ step: to, ...extra })
    .eq('user_id', userId)
    .eq('step', from)
    .select('user_id');
  if (error) throw new Error(`Could not move the deletion to ${to}: ${error.message}`);
  return (data ?? []).length === 1;
}

async function hold(
  deps: DeletionDeps,
  row: RequestRow,
  stage: string,
  reason: string
): Promise<Advance> {
  await recordOutcome(deps.db, row, stage, {
    held: reason,
    at: new Date(deps.now()).toISOString(),
  });
  logger.warn('[AccountDeletion] Holding', { userId: row.user_id, step: row.step, reason });
  return { step: row.step, held: reason };
}

async function recordOutcome(
  db: SupabaseClient<Database>,
  row: RequestRow,
  stage: string,
  outcome: unknown
): Promise<void> {
  const outcomes = { ...((row.outcomes as Record<string, unknown>) ?? {}), [stage]: outcome };
  const { error } = await db
    .from('account_deletion_requests')
    .update({ outcomes: outcomes as Json })
    .eq('user_id', row.user_id)
    .eq('step', row.step);
  if (error) throw new Error(`Could not record the deletion's outcome: ${error.message}`);
}

async function boundAuthUid(db: SupabaseClient<Database>, userId: string): Promise<string | null> {
  const { data } = await db.from('users').select('auth_uid').eq('id', userId).maybeSingle();
  return (data as { auth_uid: string | null } | null)?.auth_uid ?? null;
}

async function identityIds(db: SupabaseClient<Database>, userId: string): Promise<string[]> {
  const { data, error } = await db.from('agent_identities').select('id').eq('user_id', userId);
  if (error) throw new Error(`Could not read the account's identities: ${error.message}`);
  return (data ?? []).map((r) => r.id);
}

async function sessionRows(
  db: SupabaseClient<Database>,
  userId: string
): Promise<Array<{ id: string; backend: string | null; backend_session_id: string | null }>> {
  const { data, error } = await db
    .from('sessions')
    .select('id, backend, backend_session_id')
    .eq('user_id', userId);
  if (error) throw new Error(`Could not read the account's sessions: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    backend: string | null;
    backend_session_id: string | null;
  }>;
}

/** Open launch rows of the account's sessions that another server instance wrote. */
async function foreignLaunches(deps: DeletionDeps, userId: string): Promise<number> {
  const sessions = await sessionRows(deps.db, userId);
  if (sessions.length === 0) return 0;
  const mine = deps.serverInstance();
  const { data, error } = await deps.db
    .from('launched_processes')
    .select('server_instance')
    .in(
      'session_id',
      sessions.map((s) => s.id)
    )
    .is('exited_at', null);
  if (error) throw new Error(`Could not read launch rows: ${error.message}`);
  return (data ?? []).filter((r) => r.server_instance !== mine).length;
}

/**
 * The inventory, written once: from the rows as they stand after the drain,
 * so a backend thread id learned after the close is in it.
 */
async function fixInventory(deps: DeletionDeps, row: RequestRow): Promise<Inventory> {
  const existing = parseInventory(row.inventory);
  if (existing) return existing;
  const sbIds = await identityIds(deps.db, row.user_id);
  const sessions = await sessionRows(deps.db, row.user_id);
  const files = await inventoryFor(
    deps.roots,
    sbIds,
    sessions.map((s) => ({ id: s.id, backend: s.backend, backendSessionId: s.backend_session_id }))
  );
  const inventory: Inventory = {
    sbIds,
    sessionIds: sessions.map((s) => s.id),
    uploads: await hasUploadRows(deps.db, row.user_id),
    files,
  };
  const { error } = await deps.db
    .from('account_deletion_requests')
    .update({ inventory: inventory as unknown as Json })
    .eq('user_id', row.user_id)
    .eq('step', 'drained')
    .is('inventory', null);
  if (error) throw new Error(`Could not record the inventory: ${error.message}`);
  const reread = parseInventory((await readRequest(deps.db, row.user_id))?.inventory ?? null);
  return reread ?? inventory;
}

function parseInventory(value: Json | null): Inventory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as unknown as Inventory;
  return Array.isArray(v.files) && Array.isArray(v.sbIds) ? v : null;
}

async function hasUploadRows(db: SupabaseClient<Database>, userId: string): Promise<boolean> {
  // thread_uploads is outside the generated types, as in services/uploads.
  const { count, error } = await (db as unknown as SupabaseClient)
    .from('thread_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(`Could not read the account's uploads: ${error.message}`);
  return (count ?? 0) > 0;
}

/** What still remains of the account, or null when nothing does. */
async function anythingLeft(
  deps: DeletionDeps,
  userId: string,
  inventory: Inventory | null
): Promise<string | null> {
  const { db } = deps;
  const checks: Array<[string, () => Promise<number>]> = [
    ['its users row', () => countWhere(db, 'users', 'id', userId)],
    ['an identity', () => countWhere(db, 'agent_identities', 'user_id', userId)],
    ['a session', () => countWhere(db, 'sessions', 'user_id', userId)],
    ['an upload', () => countWhere(db, 'thread_uploads', 'user_id', userId)],
  ];
  for (const [label, check] of checks) {
    if ((await check()) > 0) return `${label} remains`;
  }
  if (inventory && !(await allAbsent(inventory.files))) return 'a file of the inventory remains';
  return null;
}

async function countWhere(
  db: SupabaseClient<Database>,
  table: 'users' | 'agent_identities' | 'sessions' | 'thread_uploads',
  column: string,
  value: string
): Promise<number> {
  const { count, error } = await (db as unknown as SupabaseClient)
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(`Could not check ${table}: ${error.message}`);
  return count ?? 0;
}

/** A completed request's record goes after REQUEST_RETENTION_MS. */
async function purgeExpiredRequests(deps: DeletionDeps): Promise<void> {
  const cutoff = new Date(deps.now() - REQUEST_RETENTION_MS).toISOString();
  const { error } = await deps.db
    .from('account_deletion_requests')
    .delete()
    .eq('step', 'completed')
    .lt('completed_at', cutoff);
  if (error)
    logger.warn('[AccountDeletion] Could not purge old requests', { error: error.message });
}
