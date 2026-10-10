/**
 * The non-interactive loop's per-turn reporting (spawned `ink chat`).
 *
 * One process runs several outer turns, and the server forwards each turn's
 * reply to the channel as that turn ends (@inklabs/shared runner/turn-reply).
 * These are the pieces the loop needs: the line it prints after each turn, the
 * sends it reports on that line, and the continuation prompt, which has to say
 * that text reaches the user once the server forwards it.
 */

import {
  TURN_REPLY_EVENT,
  userFacingReplyText,
  type TurnReplyEvent,
  type TurnSend,
} from '@inklabs/shared';

export { CONTINUATION_PROMPT, continuationPrompt } from '@inklabs/shared/runtime';

export function turnReplyEvent(input: {
  turn: number;
  label: string;
  assistantText: string | null;
  sends: TurnSend[];
  token: string;
}): TurnReplyEvent {
  return {
    type: TURN_REPLY_EVENT,
    token: input.token,
    turn: input.turn,
    label: input.label,
    text: userFacingReplyText(input.assistantText),
    sends: input.sends,
  };
}

export { isSendResponseTool, localDeliveredSend, backendSendTarget } from '@inklabs/shared';
