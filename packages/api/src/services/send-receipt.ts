/**
 * A person's send receipt: what POST /api/admin/threads and /threads/reply
 * can truthfully say about a message they stored (contract v3 §4,
 * inkling:thread:app-build 242d45bf, amended 58202c0a).
 *
 * Two promises:
 *
 * - **Replay.** A client retrying a send passes the same clientMessageId.
 *   The message is stored once (a unique index on
 *   (thread_id, metadata->>'clientMessageId') holds even when two retries
 *   race), and a retry gets the original messageId back with replayed: true.
 *   A replay never wakes anyone a second time. The same id with a different
 *   sender or different words is a conflict, never a quiet substitute.
 *
 * - **Delivery from positive evidence.** `routed` means every recipient's
 *   routing stamp was written AND its wake was accepted, as the send
 *   handler reported them. An empty failure list alone proves nothing: a
 *   result that does not say who was dispatched to and who was woken is
 *   `unknown`. The outcome is recorded on the stored message once dispatch
 *   finishes, so a replay reports the original's; a message stored by a
 *   request that died before that point replays as `unknown`, never as a
 *   fabricated `routed`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { isUuid } from './inklings/inkling-service';

/** The unique index that makes a second copy of one client message impossible. */
export const CLIENT_MESSAGE_INDEX = 'inbox_thread_messages_thread_client_message_key';

export const CLIENT_MESSAGE_CONFLICT =
  'clientMessageId was already used for a different message in this conversation';

/**
 * The send handler's store was refused by the client-message index: a
 * concurrent retry of the same message stored first. Postgres names the
 * index in the violation, and the handler carries that message through.
 * Any other failure, including one after the store, is not this.
 */
export function isClientMessageConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(`"${CLIENT_MESSAGE_INDEX}"`);
}

export type DeliveryStatus = 'routed' | 'partial' | 'unrouted' | 'unknown';

export interface Delivery {
  status: DeliveryStatus;
  /** Recipients whose routing failed or whose wake was not accepted. */
  unrouted: string[];
}

export const UNKNOWN_DELIVERY: Delivery = Object.freeze({
  status: 'unknown',
  unrouted: [],
}) as Delivery;

function slugList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
}

/**
 * The delivery a send handler's result proves. Reads the handler's own
 * fields: `recipients` (who was dispatched to), `triggered` (whose wake was
 * accepted) and `routingFailures` (whose routing stamp failed).
 */
export function deliveryFromSendResult(result: Record<string, unknown>): Delivery {
  const recipients = slugList(result.recipients);
  const triggered = slugList(result.triggered);
  if (!recipients || recipients.length === 0 || !triggered) return { ...UNKNOWN_DELIVERY };

  const failed = new Set(
    (Array.isArray(result.routingFailures) ? result.routingFailures : [])
      .map((f) => (f as { sbSlug?: unknown })?.sbSlug)
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.toLowerCase())
  );
  const woken = new Set(triggered);
  const unrouted = [...new Set(recipients)].filter((s) => failed.has(s) || !woken.has(s));
  const status: DeliveryStatus =
    unrouted.length === 0
      ? 'routed'
      : unrouted.length === new Set(recipients).size
        ? 'unrouted'
        : 'partial';
  return { status, unrouted };
}

/** What a stored message recorded about its own dispatch, or unknown. */
export function deliveryFromStoredMetadata(metadata: unknown): Delivery {
  const pcp = (metadata as { pcp?: { delivery?: unknown } } | null)?.pcp;
  const recorded = pcp?.delivery as { status?: unknown; unrouted?: unknown } | undefined;
  const statuses: DeliveryStatus[] = ['routed', 'partial', 'unrouted'];
  if (!recorded || !statuses.includes(recorded.status as DeliveryStatus)) {
    return { ...UNKNOWN_DELIVERY };
  }
  return {
    status: recorded.status as DeliveryStatus,
    unrouted: slugList(recorded.unrouted) ?? [],
  };
}

/** Absent is fine; present must be a UUID. */
export function parseClientMessageId(
  value: unknown
): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return isUuid(value) ? { ok: true, value: value.toLowerCase() } : { ok: false };
}

interface StoredMessage {
  id: string;
  thread_id: string;
  sender_kind: string | null;
  sender_user_id: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
}

export type ReplayLookup =
  | { kind: 'none' }
  | { kind: 'replay'; messageId: string; threadId: string; delivery: Delivery }
  | { kind: 'conflict' };

/**
 * Has this client message id already stored a message in this thread? The
 * caller has already authenticated the person's membership. A replay must
 * come from the same person with the same words.
 */
export async function lookUpClientMessage(
  supabase: SupabaseClient,
  input: { threadId: string; clientMessageId: string; userId: string; content: string }
): Promise<ReplayLookup> {
  const { data, error } = await supabase
    .from('inbox_thread_messages')
    .select('id, thread_id, sender_kind, sender_user_id, content, metadata')
    .eq('thread_id', input.threadId)
    .eq('metadata->>clientMessageId', input.clientMessageId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up the client message id: ${error.message}`);
  const stored = data as StoredMessage | null;
  if (!stored) return { kind: 'none' };
  const sameSend =
    stored.sender_kind === 'user' &&
    stored.sender_user_id === input.userId &&
    stored.content === input.content;
  if (!sameSend) return { kind: 'conflict' };
  return {
    kind: 'replay',
    messageId: stored.id,
    threadId: stored.thread_id,
    delivery: deliveryFromStoredMetadata(stored.metadata),
  };
}

/**
 * Record the dispatch outcome on the stored message, so a replay can report
 * it. Best effort: if this write fails, a replay says `unknown`, which is
 * true. Nothing else writes a thread message's metadata after it is
 * stored, so read-then-write loses nothing.
 */
export async function recordDelivery(
  supabase: SupabaseClient,
  messageId: string,
  delivery: Delivery
): Promise<void> {
  try {
    const { data, error: readError } = await supabase
      .from('inbox_thread_messages')
      .select('metadata')
      .eq('id', messageId)
      .maybeSingle();
    if (readError || !data) throw new Error(readError?.message ?? 'message not found');
    const metadata = ((data as { metadata: Record<string, unknown> | null }).metadata ??
      {}) as Record<string, unknown>;
    const pcp = (metadata.pcp ?? {}) as Record<string, unknown>;
    const { error } = await supabase
      .from('inbox_thread_messages')
      .update({
        metadata: {
          ...metadata,
          pcp: { ...pcp, delivery: { ...delivery, recordedAt: new Date().toISOString() } },
        },
      })
      .eq('id', messageId);
    if (error) throw new Error(error.message);
  } catch (error) {
    logger.warn('Failed to record a message delivery outcome; a replay will report unknown', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
