/**
 * Reads and writes of the upload tables, one PostgREST statement each.
 *
 * Every state change here is a single conditional update that names the
 * state it moves from, so two writers racing for one row cannot both win
 * and nothing moves backwards: a gate goes receiving → open or → closed and
 * is never reopened, a row goes live → removing → removed. A read that fails
 * throws; it is never taken for "not found".
 *
 * Times are the API's clock, passed in by the caller (see claims.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { UploadRow } from './authorize.js';
import type { StoredClaim, StoredThreadMessage } from './claims.js';
import { slotConflictOf, type SlotKind, type Slots, type UsedSlots } from './slots.js';
import type { SniffedType } from './sniff.js';

export interface StoredUpload extends UploadRow {
  kind: SniffedType['kind'];
  content_type: SniffedType['contentType'];
  byte_size: number;
  sha256: string;
}

const UPLOAD_COLUMNS =
  'id, user_id, workspace_id, thread_id, kind, content_type, byte_size, sha256, state, claim_gate, damaged_at, created_at';
const CLAIM_COLUMNS =
  'upload_id, thread_id, client_message_id, user_id, content_sha256, manifest_sha256, manifest_index, message_id, held_reason, created_at';
const MESSAGE_COLUMNS = 'id, thread_id, sender_kind, sender_user_id, content, metadata';

/** Rows whose bytes may still exist, so their slots are still taken. */
const HOLDING_SLOTS = ['live', 'removing'];

function failed(what: string, error: { message: string }): Error {
  return new Error(`Failed to ${what}: ${error.message}`);
}

/** An upload in the caller's workspace, or null. */
export async function loadUpload(
  db: SupabaseClient,
  id: string,
  workspaceId: string
): Promise<StoredUpload | null> {
  const { data, error } = await db
    .from('thread_uploads')
    .select(UPLOAD_COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw failed('read an upload', error);
  return (data as StoredUpload | null) ?? null;
}

/**
 * An upload by id alone, for trigger dispatch. The caller authorizes it
 * against the stored message being delivered, which binds the workspace: the
 * message's thread must be the upload's.
 */
export async function loadUploadForDispatch(
  db: SupabaseClient,
  id: string
): Promise<StoredUpload | null> {
  const { data, error } = await db
    .from('thread_uploads')
    .select(UPLOAD_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw failed('read an upload', error);
  return (data as StoredUpload | null) ?? null;
}

export async function loadClaim(db: SupabaseClient, uploadId: string): Promise<StoredClaim | null> {
  const { data, error } = await db
    .from('thread_upload_claims')
    .select(CLAIM_COLUMNS)
    .eq('upload_id', uploadId)
    .maybeSingle();
  if (error) throw failed('read an upload claim', error);
  return (data as StoredClaim | null) ?? null;
}

/** The one message that can ever be stored under a claim's (thread, clientMessageId). */
export async function loadClaimedMessage(
  db: SupabaseClient,
  claim: StoredClaim
): Promise<StoredThreadMessage | null> {
  const { data, error } = await db
    .from('inbox_thread_messages')
    .select(MESSAGE_COLUMNS)
    .eq('thread_id', claim.thread_id)
    .eq('metadata->>clientMessageId', claim.client_message_id)
    .maybeSingle();
  if (error) throw failed('read a claimed message', error);
  return (data as StoredThreadMessage | null) ?? null;
}

/** Is this person, not an SB, a current participant of the thread in this workspace? */
export async function isPersonParticipant(
  db: SupabaseClient,
  input: { threadId: string; userId: string; workspaceId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from('inbox_thread_participants')
    .select('thread_id')
    .eq('thread_id', input.threadId)
    .eq('user_id', input.userId)
    .eq('workspace_id', input.workspaceId)
    .is('sb_id', null)
    .limit(1);
  if (error) throw failed('read thread participants', error);
  return (data ?? []).length > 0;
}

/** The slots in use: this person's account and pending slots, and every global slot. */
export async function usedSlots(db: SupabaseClient, userId: string): Promise<UsedSlots> {
  const mine = await db
    .from('thread_uploads')
    .select('account_slot, pending_slot')
    .eq('user_id', userId)
    .in('state', HOLDING_SLOTS);
  if (mine.error) throw failed('read upload slots', mine.error);
  const own = (mine.data ?? []) as Array<{ account_slot: number; pending_slot: number | null }>;
  return {
    account: own.map((r) => r.account_slot),
    pending: own.flatMap((r) => (r.pending_slot === null ? [] : [r.pending_slot])),
    global: await usedGlobalSlots(db),
  };
}

/** Under PostgREST's max_rows (1000), which a full set of 1024 global slots exceeds. */
const SLOT_PAGE = 500;

/**
 * Every global slot in use, read page by page until a short page, so a full
 * server is told from a full read, never from a response the row cap cut.
 */
async function usedGlobalSlots(db: SupabaseClient): Promise<number[]> {
  const slots: number[] = [];
  for (let from = 0; ; from += SLOT_PAGE) {
    const { data, error } = await db
      .from('thread_uploads')
      .select('global_slot')
      .in('state', HOLDING_SLOTS)
      .order('global_slot', { ascending: true })
      .range(from, from + SLOT_PAGE - 1);
    if (error) throw failed('read upload slots', error);
    const page = (data ?? []) as Array<{ global_slot: number }>;
    slots.push(...page.map((r) => r.global_slot));
    if (page.length < SLOT_PAGE) return slots;
  }
}

export interface NewUploadRow {
  id: string;
  user_id: string;
  workspace_id: string;
  thread_id: string;
  kind: SniffedType['kind'];
  content_type: SniffedType['contentType'];
  byte_size: number;
  sha256: string;
  created_at: string;
}

/**
 * Insert a receiving row holding these slots, before any byte is written. A
 * slot taken by someone else is a conflict to retry; anything else throws.
 */
export async function insertUploadRow(
  db: SupabaseClient,
  row: NewUploadRow,
  slots: Slots
): Promise<{ ok: true } | { ok: false; conflict: SlotKind }> {
  const { error } = await db.from('thread_uploads').insert({
    ...row,
    state: 'live',
    claim_gate: 'receiving',
    account_slot: slots.account,
    pending_slot: slots.pending,
    global_slot: slots.global,
  });
  if (!error) return { ok: true };
  const conflict = slotConflictOf(error);
  if (conflict) return { ok: false, conflict };
  throw failed('record an upload', error);
}

/**
 * receiving → open, once the bytes are in place. False when the gate is no
 * longer receiving: something closed it, and it stays closed.
 */
export async function openGate(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db
    .from('thread_uploads')
    .update({ claim_gate: 'open' })
    .eq('id', id)
    .eq('claim_gate', 'receiving')
    .eq('state', 'live')
    .select('id');
  if (error) throw failed('open an upload', error);
  return (data ?? []).length === 1;
}

/**
 * Close the gate from the state it is known to be in. Against an open upload
 * that a claim holds, the foreign key refuses (23503): the claim won, and
 * this answers false.
 */
export async function closeGate(
  db: SupabaseClient,
  id: string,
  from: 'receiving' | 'open'
): Promise<boolean> {
  const { data, error } = await db
    .from('thread_uploads')
    .update({ claim_gate: 'closed' })
    .eq('id', id)
    .eq('claim_gate', from)
    .eq('state', 'live')
    .select('id');
  if (error?.code === '23503') return false;
  if (error) throw failed('close an upload', error);
  return (data ?? []).length === 1;
}

export type EndReason = 'orphan' | 'expired' | 'account_deleted' | 'manual';

/** live → removing. Reads refuse from here; the slots stay held. */
export async function beginRemoval(
  db: SupabaseClient,
  id: string,
  reason: EndReason,
  nowIso: string
): Promise<boolean> {
  const { data, error } = await db
    .from('thread_uploads')
    .update({ state: 'removing', end_reason: reason, ended_at: nowIso })
    .eq('id', id)
    .eq('state', 'live')
    .select('id');
  if (error) throw failed('start removing an upload', error);
  return (data ?? []).length === 1;
}

/** removing → removed, only once the bytes are confirmed gone. Frees the slots. */
export async function finishRemoval(
  db: SupabaseClient,
  id: string,
  nowIso: string
): Promise<boolean> {
  const { data, error } = await db
    .from('thread_uploads')
    .update({ state: 'removed', removed_at: nowIso })
    .eq('id', id)
    .eq('state', 'removing')
    .select('id');
  if (error) throw failed('finish removing an upload', error);
  return (data ?? []).length === 1;
}

/** Record that the bytes no longer match the row. Never cleared. */
export async function markDamaged(db: SupabaseClient, id: string, nowIso: string): Promise<void> {
  const { error } = await db
    .from('thread_uploads')
    .update({ damaged_at: nowIso })
    .eq('id', id)
    .is('damaged_at', null);
  if (error) throw failed('mark an upload damaged', error);
}
