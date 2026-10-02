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

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { isUuid } from './inklings/inkling-service';

/** The unique index that makes a second copy of one client message impossible. */
export const CLIENT_MESSAGE_INDEX = 'inbox_thread_messages_thread_client_message_key';

export const CLIENT_MESSAGE_CONFLICT =
  'clientMessageId was already used for a different message in this conversation';

export const THREAD_KEY_TAKEN_ERROR =
  'This conversation key is already in use; a new conversation needs a new key';

/**
 * A retried create that finds its key taken by a thread the same person
 * created waits this long, at most, for its original request to store the
 * first message: 10 checks, 100 ms apart. That original stores within
 * milliseconds of creating the thread unless it died.
 */
export const OWN_CREATE_SETTLE_ATTEMPTS = 10;
export const OWN_CREATE_SETTLE_INTERVAL_MS = 100;

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

/** The handler's `dispatched`: every target it routed to, and whether each was meant to wake. */
function dispatchedTargets(value: unknown): Array<{ sbSlug: string; wake: boolean }> | null {
  if (!Array.isArray(value)) return null;
  const targets = new Map<string, boolean>();
  for (const entry of value) {
    const { sbSlug, wake } = (entry ?? {}) as { sbSlug?: unknown; wake?: unknown };
    if (typeof sbSlug !== 'string') continue;
    const slug = sbSlug.toLowerCase();
    targets.set(slug, targets.get(slug) === true || wake === true);
  }
  return [...targets].map(([sbSlug, wake]) => ({ sbSlug, wake }));
}

/**
 * The delivery a send handler's result proves, from its own fields:
 * `dispatched` (every target it routed to, which can be wider than the
 * requested recipients, and whether each was meant to wake), `triggered`
 * (whose wake was accepted) and `routingFailures` (whose routing stamp
 * failed). A target is delivered when its stamp held and, if it was meant
 * to wake, its wake was accepted. Without `dispatched` and `triggered` there
 * is no evidence and the answer is `unknown`: the requested list says who
 * was asked for, not who was routed to.
 */
export function deliveryFromSendResult(result: Record<string, unknown>): Delivery {
  const dispatched = dispatchedTargets(result.dispatched);
  const triggered = slugList(result.triggered);
  if (!dispatched || dispatched.length === 0 || !triggered) return { ...UNKNOWN_DELIVERY };

  const failed = new Set(
    (Array.isArray(result.routingFailures) ? result.routingFailures : [])
      .map((f) => (f as { sbSlug?: unknown })?.sbSlug)
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.toLowerCase())
  );
  const woken = new Set(triggered);
  const unrouted = dispatched
    .filter((t) => failed.has(t.sbSlug) || (t.wake && !woken.has(t.sbSlug)))
    .map((t) => t.sbSlug);
  const status: DeliveryStatus =
    unrouted.length === 0
      ? 'routed'
      : unrouted.length === dispatched.length
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
 * Who a client-identified create addressed, and its title: recorded on the
 * stored message at metadata.pcp.createRequest so a retry can be held to the
 * same submission. Recipients are a set (lowercased, deduplicated, sorted),
 * so a retry listing them in another order is the same create.
 */
export interface CreateRequest {
  recipients: string[];
  title: string | null;
}

export function createRequestOf(recipients: string[], title: string): CreateRequest {
  return {
    recipients: [...new Set(recipients.map((r) => r.toLowerCase()))].sort(),
    title: title || null,
  };
}

/** A digest of the words, so the intent can pin them without storing them twice. */
function contentDigestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * What a client-identified create records on the thread row it creates
 * (inbox_threads.metadata.createIntent), in the same insert, before any
 * participant is written: its client message id, its recipients as a set,
 * its full title (not the thread's bounded display title) and a digest of
 * its words. It is the only durable evidence of what an interrupted create
 * meant, so it is what a retry is held to.
 */
export function createIntentOf(clientMessageId: string, request: CreateRequest, content: string) {
  return {
    clientMessageId,
    recipients: request.recipients,
    title: request.title,
    contentDigest: contentDigestOf(content),
  };
}

/**
 * Is this thread the one this exact create made? Its recorded intent must
 * name the same client message id, the same recipients (as a set), the
 * same title and the same words. A thread with no recorded intent never
 * matches, and the same id with edited words is not its retry.
 */
export function matchesCreateIntent(
  threadMetadata: unknown,
  clientMessageId: string,
  request: CreateRequest,
  content: string
): boolean {
  const intent = (threadMetadata as { createIntent?: unknown } | null | undefined)?.createIntent as
    | { clientMessageId?: unknown; recipients?: unknown; title?: unknown; contentDigest?: unknown }
    | undefined;
  if (
    !intent ||
    intent.clientMessageId !== clientMessageId ||
    intent.contentDigest !== contentDigestOf(content) ||
    !Array.isArray(intent.recipients)
  ) {
    return false;
  }
  const recorded = createRequestOf(
    intent.recipients.filter((r): r is string => typeof r === 'string'),
    typeof intent.title === 'string' ? intent.title : ''
  );
  return (
    recorded.title === request.title &&
    recorded.recipients.length === request.recipients.length &&
    recorded.recipients.every((r, i) => r === request.recipients[i])
  );
}

function sameCreateRequest(metadata: Record<string, unknown> | null, request: CreateRequest) {
  const stored = (metadata?.pcp as { createRequest?: Partial<CreateRequest> } | undefined)
    ?.createRequest;
  if (!stored || !Array.isArray(stored.recipients)) return false;
  const storedSet = createRequestOf(
    stored.recipients.filter((r): r is string => typeof r === 'string'),
    stored.title ?? ''
  );
  return (
    storedSet.title === request.title &&
    storedSet.recipients.length === request.recipients.length &&
    storedSet.recipients.every((r, i) => r === request.recipients[i])
  );
}

/**
 * Has this client message id already stored a message in this thread? The
 * caller has checked the person's workspace role; the sender check here is
 * what keeps a replay to the person who sent the original. A replay must
 * come from the same person with the same words and, for a create, the same
 * recipients and title (`createRequest`); anything else is a conflict.
 */
export async function lookUpClientMessage(
  supabase: SupabaseClient,
  input: {
    threadId: string;
    clientMessageId: string;
    userId: string;
    content: string;
    createRequest?: CreateRequest;
  }
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
    stored.content === input.content &&
    (input.createRequest === undefined || sameCreateRequest(stored.metadata, input.createRequest));
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
