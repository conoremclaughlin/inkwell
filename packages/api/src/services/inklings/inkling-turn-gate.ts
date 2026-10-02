/**
 * Whether a turn may start for an inkling: the spawn seam's half of the
 * owner/dev gate (Lumen 97b1d66a). SessionService.processMessage asks this
 * after it loads the identity and before anything is spawned, for every
 * path that starts a turn: thread wakes, reminders and heartbeats,
 * strategies, channels, web chat, retries.
 *
 * The creation half (inkling-thread-gate.ts) keeps an inkling's
 * conversations between it and its owner. This half refuses everything
 * else that could wake it: an SB's or the system's send, a heartbeat, a
 * reminder, a strategy, a channel message, and every turn while the owner
 * test is off. Only a person's message, on the owner's own account, wakes
 * an inkling born under the test.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { INKLING_CLIENT } from './inkling-service';

/** Attempts at the conditional counter update before a contended claim is refused. */
const CLAIM_ATTEMPTS = 5;

/**
 * Count one turn against an inkling's cap before it is spawned: a
 * conditional update of metadata.ownerTestTurns, guarded on updated_at as
 * naming is, so two turns starting together cannot both take the last one.
 * A failed or unfinished turn still counts: the cap bounds how often the
 * inkling runs, not how often it succeeds. An unreadable identity, or a
 * claim still contended after a few attempts, is refused rather than run.
 */
export async function claimInklingTurn(
  supabase: SupabaseClient,
  sbId: string,
  userId: string,
  cap: number
): Promise<{ allowed: boolean; used: number }> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const { data, error } = await supabase
      .from('agent_identities')
      .select('metadata, updated_at')
      .eq('id', sbId)
      .eq('user_id', userId)
      .maybeSingle();
    const row = data as { metadata: Record<string, unknown> | null; updated_at: string } | null;
    if (error || !row) return { allowed: false, used: 0 };
    const metadata = row.metadata ?? {};
    const counted = metadata.ownerTestTurns;
    const used = typeof counted === 'number' && Number.isInteger(counted) ? counted : 0;
    if (used >= cap) return { allowed: false, used };
    const { data: won } = await supabase
      .from('agent_identities')
      .update({
        metadata: { ...metadata, ownerTestTurns: used + 1 },
        updated_at: new Date().toISOString(),
      })
      .eq('id', sbId)
      .eq('user_id', userId)
      .eq('updated_at', row.updated_at)
      .select('id')
      .maybeSingle();
    if (won) return { allowed: true, used: used + 1 };
  }
  return { allowed: false, used: cap };
}

export interface InklingTurnInput {
  /** agent_identities.metadata of the SB the turn is for; null when unknown. */
  identityMetadata: Record<string, unknown> | null | undefined;
  /** The account the turn runs for (the identity's user_id). */
  userId: string;
  /** SessionRequest.sender.id: 'user' for a person's message. */
  senderId: string | undefined;
}

/** Null when the turn may start; otherwise why it may not. Only inklings are ever refused. */
export function inklingTurnRefusal(
  input: InklingTurnInput,
  ownerTestUserId: string | null
): string | null {
  const metadata = input.identityMetadata;
  if (!metadata || metadata.client !== INKLING_CLIENT) return null;
  if (ownerTestUserId === null) return 'inklings are not open on this server';
  if (input.userId.toLowerCase() !== ownerTestUserId.toLowerCase()) {
    return 'this inkling belongs to an account outside the owner test';
  }
  if (metadata.ownerTest !== true) return 'this inkling was not born under the owner test';
  if (input.senderId !== 'user') {
    return 'an inkling wakes only for its owner’s own message, not a system, SB or channel send';
  }
  return null;
}
