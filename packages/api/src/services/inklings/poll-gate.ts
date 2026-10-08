/**
 * An inkling is never reached through a polling or attached client.
 *
 * Its turns run on the spawn path (session-service processMessage), where its
 * owner test, profile and withheld provider tools live. Three routes went
 * around that path when a client was attached to an inkling's session, and
 * this module closes the shipped ones (Oct 7 audit, suspected #1; never
 * observed: no inline delivery to an inkling is on record):
 *
 * - the trigger handler delivering inline instead of spawning
 *   (trigger-delivery.ts, decideDelivery's targetMetadata);
 * - the channel plugin's and an interactive ink chat's own polling reads,
 *   get_inbox and get_thread_messages with channelPoll (pollReaderRefusal);
 * - the writers that mark a session attached or polling, which is what makes
 *   the trigger handler think a client is there (presenceRefused).
 *
 * It does not stop an owner reading their own inkling's conversation by hand
 * from a local CLI without channelPoll: that's the owner's own data, readable
 * in the app too, and a caller-set bit can't make it an execution boundary.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyIdentityById } from './inkling-turn-gate';

/**
 * Why a polling client may not read as this identity, or null when it may.
 * Fails closed: an inkling, an identity that can't be read, and a session with
 * no canonical identity are all refused. An identity positively read as not an
 * inkling (metadata null included) reads as before.
 */
export async function pollReaderRefusal(
  client: SupabaseClient,
  sbId: string | null | undefined
): Promise<string | null> {
  if (!sbId) return 'session has no canonical identity';
  const identity = await classifyIdentityById(client, sbId);
  if (identity.kind === 'inkling')
    return "an inkling's mail is never delivered to a polling client";
  if (identity.kind === 'unknown') return 'session identity could not be classified';
  return null;
}

/**
 * Whether a session must never be marked attached or polling: its identity is
 * positively an inkling. Defense in depth behind the read gate, so an unknown
 * identity is NOT refused here; refusing an ordinary SB's attach on a transient
 * read error would let the server spawn a turn beside a live CLI.
 */
export async function presenceRefused(
  client: SupabaseClient,
  sbId: string | null | undefined
): Promise<boolean> {
  if (!sbId) return false;
  return (await classifyIdentityById(client, sbId)).kind === 'inkling';
}
