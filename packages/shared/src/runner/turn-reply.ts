/**
 * One outer turn's reply, as `ink chat --non-interactive` reports it.
 *
 * A server-spawned `ink chat` runs up to `--max-turns` OUTER turns in one
 * process: the delivered message, then "Continue working…" prompts until the
 * SB signals completed or blocked. The process used to report one text for the
 * whole run, the last assistant entry, and the server made one forward decision
 * per process. So a reply written as text in turn 1 was replaced by turn 2's
 * text, and a send_response in any turn suppressed every other turn's text.
 * On 2026-10-03 Myra answered a Telegram message as turn-1 text, then two more
 * turns ran. The text was never forwarded and nothing logged why; the reply
 * arrived only because she noticed and re-sent it with send_response.
 *
 * The chat now prints one `turn_reply` line as each outer turn ends, and the
 * server decides per turn, while the run is still going. Two properties of
 * that line are load-bearing (Lumen, PR #735):
 *
 * - It carries the run's token. The chat's stdout also carries everything it
 *   echoes, the delivered message included, so a line that merely looks like
 *   an event is not one. The server mints the token per spawn and accepts only
 *   lines that carry it.
 * - It carries the turn's own successful sends. Whether a turn already
 *   answered through send_response used to be read from a server-side marker
 *   the send sets over MCP, a different channel from stdout with no ordering
 *   between the two, so turn 1 could read turn 2's send. The chat knows which
 *   sends each turn made; it says so on the same line as the text.
 */

import { LOCAL_TOOL_CALL_PLACEHOLDER } from '../runtime/local-tool-placeholder.js';

export { LOCAL_TOOL_CALL_PLACEHOLDER };

export const TURN_REPLY_EVENT = 'turn_reply';

/**
 * The token the server mints for one spawn whose turn replies it forwards. The
 * chat reads it once at startup and removes it from its own environment, so
 * its tools and provider children never carry it, and prints it only on its
 * `turn_reply` lines. An environment variable rather than a flag: a CLI build
 * that predates it ignores it, where an unknown flag would refuse to start.
 */
export const TURN_REPLY_TOKEN_ENV = 'INK_TURN_REPLY_TOKEN';

/** One send_response that delivered during the turn, by its target. */
export interface TurnSend {
  channel: string;
  conversationId: string;
}

export interface TurnReply {
  /** 1-based outer turn number within the process. */
  turn: number;
  /** The delivered message's label for turn 1 (`telegram`, …), `continuation` after. */
  label: string;
  /** The turn's user-facing text, or null when it wrote none. */
  text: string | null;
  /** The send_response calls this turn made that delivered something. */
  sends: TurnSend[];
}

export interface TurnReplyEvent extends TurnReply {
  type: typeof TURN_REPLY_EVENT;
  token: string;
}

/**
 * The text a reader could use, or null. Blank text and the tool-call
 * placeholder are not replies. The original string is returned untrimmed:
 * leading indentation is load-bearing in Markdown.
 */
export function userFacingReplyText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed === LOCAL_TOOL_CALL_PLACEHOLDER) return null;
  return text;
}

function isTurnSend(value: unknown): value is TurnSend {
  if (!value || typeof value !== 'object') return false;
  const send = value as Record<string, unknown>;
  return (
    typeof send.channel === 'string' &&
    send.channel.length > 0 &&
    typeof send.conversationId === 'string' &&
    send.conversationId.length > 0
  );
}

/**
 * A parsed stdout line, if it is a well-formed `turn_reply` event. Whether its
 * token is the run's is the caller's check: this only says the shape is right.
 */
export function parseTurnReplyEvent(value: unknown): TurnReplyEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type !== TURN_REPLY_EVENT) return null;
  if (typeof event.token !== 'string' || !event.token) return null;
  if (typeof event.turn !== 'number' || !Number.isInteger(event.turn) || event.turn < 1) {
    return null;
  }
  if (typeof event.label !== 'string') return null;
  if (event.text !== null && typeof event.text !== 'string') return null;
  if (!Array.isArray(event.sends) || !event.sends.every(isTurnSend)) return null;
  return {
    type: TURN_REPLY_EVENT,
    token: event.token,
    turn: event.turn,
    label: event.label,
    text: userFacingReplyText(event.text as string | null),
    sends: event.sends.map((send) => ({
      channel: send.channel,
      conversationId: send.conversationId,
    })),
  };
}
