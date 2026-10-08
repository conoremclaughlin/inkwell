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

/** `send_response` as a local tool, or as a backend's MCP tool (`mcp__inkwell__send_response`). */
export function isSendResponseTool(name: string): boolean {
  return name === 'send_response' || name.endsWith('__send_response');
}

function sendTarget(source: unknown): TurnSend | null {
  if (!source || typeof source !== 'object') return null;
  const { channel, conversationId } = source as Record<string, unknown>;
  if (typeof channel !== 'string' || !channel) return null;
  if (typeof conversationId !== 'string' || !conversationId) return null;
  return { channel, conversationId };
}

/**
 * A local send_response that delivered, by its target, or null.
 *
 * InkClient throws on a protocol failure (status `error`) and returns the
 * handler's JSON body otherwise. The handler answers `success: false` for every
 * send that reached nobody, so only `success: true` counts. The target is the
 * one the server echoes back, which is the one it sent to; the arguments are
 * the fallback.
 *
 * One of the two send paths the chat observes, with `backendSendTarget`. A
 * send made any other way (a shell or CLI wrapper, or backend routing on
 * Codex or Gemini) is not seen, and that turn's text is forwarded as well:
 * a possible duplicate, never a dropped reply (TurnReply.sends).
 */
export function localDeliveredSend(input: {
  tool: string;
  status: string;
  args?: Record<string, unknown>;
  result?: unknown;
}): TurnSend | null {
  if (!isSendResponseTool(input.tool)) return null;
  if (input.status !== 'executed' && input.status !== 'approved') return null;
  const body = input.result as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== 'object' || body.success !== true) return null;
  return sendTarget(body) ?? sendTarget(input.args);
}

/**
 * A backend-routed send_response, as the provider stream reports it: the
 * call's input on `tool-use`, then only an error flag on `tool-result`. The
 * handler returns `isError` for every send that reached nobody, so a result
 * without it means the target in the input was sent to.
 *
 * Only a backend with a stream parser reports these events, which today is
 * Claude alone. Codex and Gemini backend routing report no sends.
 */
export function backendSendTarget(name: string, input: unknown): TurnSend | null {
  return isSendResponseTool(name) ? sendTarget(input) : null;
}
