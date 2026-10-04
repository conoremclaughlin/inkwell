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
 * server decides per turn, while the run is still going.
 */

import { LOCAL_TOOL_CALL_PLACEHOLDER } from '../runtime/local-tool-placeholder.js';

export { LOCAL_TOOL_CALL_PLACEHOLDER };

export const TURN_REPLY_EVENT = 'turn_reply';

/**
 * Set by the server on a chat whose turn replies it forwards to the user, so
 * the chat can tell the SB that text in a continuation turn reaches the user.
 * An environment variable rather than a flag: a CLI build that predates it
 * ignores it, where an unknown flag would refuse to start.
 */
export const TURN_REPLIES_FORWARDED_ENV = 'INK_TURN_REPLIES_FORWARDED';

export interface TurnReply {
  /** 1-based outer turn number within the process. */
  turn: number;
  /** The delivered message's label for turn 1 (`telegram`, …), `continuation` after. */
  label: string;
  /** The turn's user-facing text, or null when it wrote none. */
  text: string | null;
}

export interface TurnReplyEvent extends TurnReply {
  type: typeof TURN_REPLY_EVENT;
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

/** A parsed stdout line, if it is a well-formed `turn_reply` event. */
export function parseTurnReplyEvent(value: unknown): TurnReplyEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type !== TURN_REPLY_EVENT) return null;
  if (typeof event.turn !== 'number' || !Number.isInteger(event.turn) || event.turn < 1) {
    return null;
  }
  if (typeof event.label !== 'string') return null;
  if (event.text !== null && typeof event.text !== 'string') return null;
  return {
    type: TURN_REPLY_EVENT,
    turn: event.turn,
    label: event.label,
    text: userFacingReplyText(event.text as string | null),
  };
}
