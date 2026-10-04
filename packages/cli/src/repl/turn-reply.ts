/**
 * The non-interactive loop's per-turn reporting (spawned `ink chat`).
 *
 * One process runs several outer turns, and the server forwards each turn's
 * reply to the channel as that turn ends (@inklabs/shared runner/turn-reply).
 * These are the two pieces the loop needs: the line it prints after each turn,
 * and the continuation prompt, which has to say that text reaches the user once
 * the server forwards it.
 */

import { TURN_REPLY_EVENT, userFacingReplyText, type TurnReplyEvent } from '@inklabs/shared';

export const CONTINUATION_PROMPT =
  'Continue working. Use signal_status to indicate when you are completed, blocked, or continuing.';

/**
 * Text written in a continuation turn used to go nowhere unless it happened to
 * be the run's last. Now it goes to the user, so the SB is told: otherwise its
 * notes to itself ("nothing more I can do, closing the turn") arrive on the
 * user's phone as messages.
 */
const FORWARDED_NOTE =
  ' Text you write in this turn is sent to the user as a message, so write only what is meant for them; if there is nothing new for them, call signal_status without writing text.';

export function continuationPrompt(repliesForwarded: boolean): string {
  return repliesForwarded ? CONTINUATION_PROMPT + FORWARDED_NOTE : CONTINUATION_PROMPT;
}

export function turnReplyEvent(
  turn: number,
  label: string,
  assistantText: string | null
): TurnReplyEvent {
  return { type: TURN_REPLY_EVENT, turn, label, text: userFacingReplyText(assistantText) };
}
