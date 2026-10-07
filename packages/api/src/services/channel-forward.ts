/**
 * Did the user get anything back?
 *
 * A turn on an external channel delivers its reply one of two ways: the agent
 * calls `send_response` explicitly, or the runtime auto-forwards the final text.
 * The system prompt tells agents the second one exists — "If you do not
 * explicitly call send_response, your text response will be auto-forwarded" —
 * so an agent is entitled to rely on it.
 *
 * It does not always fire. The guard was
 *
 *   if (!hadExplicitResponse && result.finalTextResponse && result.success)
 *
 * with a single `else` that logged, at DEBUG, "Explicit send_response detected,
 * skipping auto-forward". Three different situations reach that branch and the
 * message is only true for one of them. When the run failed, or when it ended
 * with no final text, nothing was delivered and the log said the opposite —
 * while carrying `hadExplicitResponse: false` in its own payload, contradicting
 * its own message. Debug is not persisted to ~/.ink/logs, so in production the
 * branch left no trace at all.
 *
 * Myra hit it on 2026-09-03 with research Conor was waiting on: three
 * `agent_complete` turns, zero `message_out`, and nothing in the logs to find.
 * She only noticed because she went looking, five minutes later. Her workaround
 * — never trust the fallback, always call send_response — is sound and should
 * not be necessary.
 *
 * Split out as a pure decision so the three cases can be told apart and tested
 * without a server, a channel gateway, or a live turn.
 *
 * A run with several outer turns (`ink chat`) is decided per turn instead, by
 * `createTurnReplyForwarder` below; this whole-run decision remains for
 * runners that report one turn.
 */

import { userFacingReplyText, type TurnReply } from '@inklabs/shared';

export type ChannelForwardDecision =
  /** Auto-forward the agent's final text; nothing else delivered it. */
  | { action: 'auto-forward'; content: string }
  /** The agent already delivered its own reply via send_response. */
  | { action: 'explicit-response' }
  /**
   * NOTHING reached the user, and the documented fallback could not fire.
   * `reason` distinguishes a failed run from one that simply produced no text —
   * they need different follow-up, and neither is "skipped because explicit".
   */
  | { action: 'nothing-delivered'; reason: 'run-failed' | 'no-final-text' };

export function decideChannelForward(input: {
  hadExplicitResponse: boolean;
  success: boolean;
  finalTextResponse?: string | null;
}): ChannelForwardDecision {
  if (input.hadExplicitResponse) return { action: 'explicit-response' };
  if (!input.success) return { action: 'nothing-delivered', reason: 'run-failed' };

  // Whitespace-only is not a reply: forwarding it satisfies a truthiness check
  // and still delivers nothing a reader can use — the failure wearing a success
  // badge. Neither is the placeholder an ink turn that ended on tool calls
  // stores as its text; forwarding it sent the user a line about a transcript.
  //
  // But trim only DETECTS that; it must not be what gets sent. Leading
  // indentation is load-bearing in Markdown — a fenced block, a nested list —
  // and trimming the forwarded value would silently reformat the agent's answer
  // (Lumen, PR #580). Detect on the trimmed copy, forward the original.
  const text = userFacingReplyText(input.finalTextResponse);
  if (!text) return { action: 'nothing-delivered', reason: 'no-final-text' };

  return { action: 'auto-forward', content: text };
}

/**
 * Carry out a decision: log it at the level it deserves and release the
 * conversation.
 *
 * Split from `server.ts` because the pure decision above stays green even if
 * the caller reverts to the old single-branch code or downgrades the warning
 * (Lumen, PR #580). A test can only prove the SERVER does the right thing if
 * the server's own step is reachable from a test, so it lives here and
 * `server.ts` is a thin call.
 *
 * The log level is part of the contract, not a detail: `nothing-delivered` at
 * debug is invisible, because debug is not persisted to ~/.ink/logs. That is
 * how a turn that reached nobody left no trace at all.
 */
/** What the gateway sends when the runtime auto-forwards the final text. */
export interface ChannelForwardPayload {
  content: string;
  format: 'markdown';
  /**
   * The turn's session, so the auto-forwarded `message_out` row is attributed
   * like an explicit send_response would be. Absent only when the caller has
   * no session for the turn.
   */
  sessionId?: string;
}

export interface ChannelForwardEffects {
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  release(payload?: ChannelForwardPayload): Promise<void>;
}

export async function applyChannelForward(
  decision: ChannelForwardDecision,
  context: {
    channel: string;
    conversationId: string;
    hadExplicitResponse: boolean;
    runSucceeded: boolean;
    finalTextLength: number;
    /** The session that ran the turn; carried onto the auto-forward payload. */
    sessionId?: string;
  },
  effects: ChannelForwardEffects
): Promise<void> {
  const { channel, conversationId } = context;

  if (decision.action === 'auto-forward') {
    effects.info('Auto-routing text response (no explicit send_response called)', {
      channel,
      conversationId,
      responseLength: decision.content.length,
    });
    await effects.release({
      content: decision.content,
      format: 'markdown',
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    });
    return;
  }

  if (decision.action === 'nothing-delivered') {
    effects.warn('Nothing delivered to the user for this turn', {
      channel,
      conversationId,
      reason: decision.reason,
      hadExplicitResponse: context.hadExplicitResponse,
      runSucceeded: context.runSucceeded,
      finalTextLength: context.finalTextLength,
    });
  } else {
    // Info, not debug: a skip is a decision not to deliver text, and debug is
    // not persisted. When it was the only trace of a dropped reply, there was
    // no trace (task 0eb376e5).
    effects.info('Explicit delivery marker present, skipping auto-forward', {
      channel,
      conversationId,
      hadExplicitResponse: context.hadExplicitResponse,
      finalTextLength: context.finalTextLength,
    });
  }

  await effects.release();
}

/** One turn's verdict. `explicit-response` and `forward` both mean the user got something. */
export type TurnReplyDecision =
  | { action: 'forward'; content: string }
  | { action: 'explicit-response' }
  | { action: 'no-text' };

/**
 * The per-turn form of `decideChannelForward`: a turn that delivered to this
 * conversation through send_response keeps its text to itself, and a turn
 * that did not has its text forwarded. The same rule a one-turn runner gets,
 * applied to each turn rather than to whichever turn happened to be last.
 *
 * `sentHere` comes from the turn's own report of its sends, never from the
 * conversation's marker. The marker is set by an MCP request and the turn's
 * line arrives on stdout; nothing orders the two, so a turn that read the
 * marker could take a later turn's send for its own and keep its reply back
 * (Lumen, PR #735, reproduced with a line split across stdout chunks).
 */
export function decideTurnReply(input: {
  sentHere: boolean;
  text: string | null | undefined;
}): TurnReplyDecision {
  if (input.sentHere) return { action: 'explicit-response' };
  const text = userFacingReplyText(input.text);
  if (!text) return { action: 'no-text' };
  return { action: 'forward', content: text };
}

export interface TurnReplyForwarderEffects {
  /**
   * Read AND clear the conversation's explicit-send marker
   * (consumeExplicitResponse). Read once, when the run ends: evidence that
   * something was delivered, and cleared so it does not outlive the run.
   */
  consumeExplicitResponse(): boolean;
  /** Send one message to the conversation without releasing it. */
  send(payload: ChannelForwardPayload): Promise<void>;
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
  release(): Promise<void>;
}

export interface TurnReplyForwarder {
  /** For SessionRequest.onTurnReply. Decides from the reply alone. */
  onTurnReply(reply: TurnReply & { sessionId?: string }): Promise<void>;
  /** How many turns the run reported. Zero means the runner reports none. */
  readonly turnsSeen: number;
  /** After the run: settle the last sends, say what was delivered, release. */
  finish(run: { success: boolean }): Promise<void>;
}

/**
 * Deliver a multi-turn run's replies as its turns end.
 *
 * Each turn is decided from its own line: its text, and the sends it reports
 * making. A send to another conversation does not stand in for a reply here.
 * Sends are queued, so replies reach the user in turn order even if one send
 * is slow.
 *
 * A turn reports only the sends the chat can observe: local tool routing on
 * any backend, and Claude backend routing. A send through a shell or CLI
 * wrapper, or through Codex or Gemini backend routing, is not reported, so
 * that turn's text is forwarded too. The worst case is a duplicate, never a
 * dropped reply, which is the direction we want: nothing may go missing
 * silently. `finish` still reads the marker, and says so at info when the
 * marker shows a send no turn reported.
 *
 * `finish` releases the conversation without a payload, because the last
 * turn's text was already decided as that turn ended. It warns when the whole
 * run delivered nothing, the same promise `applyChannelForward` keeps.
 */
export function createTurnReplyForwarder(
  context: { channel: string; conversationId: string },
  effects: TurnReplyForwarderEffects
): TurnReplyForwarder {
  const { channel, conversationId } = context;
  const forwarded: number[] = [];
  const explicit: number[] = [];
  const failed: number[] = [];
  let turnsSeen = 0;
  let sends: Promise<void> = Promise.resolve();

  const onTurnReply = (reply: TurnReply & { sessionId?: string }): Promise<void> => {
    turnsSeen += 1;
    const sentHere = reply.sends.some(
      (send) => send.channel === channel && send.conversationId === conversationId
    );
    const decision = decideTurnReply({ sentHere, text: reply.text });
    const meta = { channel, conversationId, turn: reply.turn, label: reply.label };

    if (decision.action === 'explicit-response') {
      explicit.push(reply.turn);
      effects.info('Turn delivered by send_response; its text is not forwarded', {
        ...meta,
        textLength: reply.text?.length ?? 0,
      });
      return sends;
    }
    if (decision.action === 'no-text') {
      effects.info('Turn ended without a reply to forward', meta);
      return sends;
    }

    const step = sends.then(async () => {
      effects.info('Auto-routing turn reply (no send_response this turn)', {
        ...meta,
        responseLength: decision.content.length,
      });
      try {
        await effects.send({
          content: decision.content,
          format: 'markdown',
          ...(reply.sessionId ? { sessionId: reply.sessionId } : {}),
        });
        forwarded.push(reply.turn);
      } catch (error) {
        failed.push(reply.turn);
        effects.error('Failed to forward turn reply; this turn reached nobody', {
          ...meta,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    sends = step;
    return step;
  };

  const finish = async (run: { success: boolean }): Promise<void> => {
    await sends;
    // A send the turns did not report (a run that crashed mid-turn after
    // calling send_response, or a backend call with no id to match its
    // result) still delivered something, and its marker must not outlive
    // this run.
    const explicitMarker = effects.consumeExplicitResponse();
    const meta = {
      channel,
      conversationId,
      turnsSeen,
      forwardedTurns: forwarded,
      explicitTurns: explicit,
      failedTurns: failed,
      explicitMarker,
      runSucceeded: run.success,
    };
    if (forwarded.length === 0 && explicit.length === 0 && !explicitMarker) {
      effects.warn('Nothing delivered to the user for this run', {
        ...meta,
        reason: !run.success ? 'run-failed' : failed.length > 0 ? 'send-failed' : 'no-final-text',
      });
    } else {
      effects.info('Run replies settled', meta);
    }
    if (explicitMarker && explicit.length === 0) {
      // Something reached this conversation that no turn's line accounts for:
      // a path the turns do not observe (a shell wrapper, a backend without a
      // stream parser), or a turn that never printed its line. If a turn's
      // text was forwarded as well, the user probably got it twice.
      effects.info('A send reached this conversation that no turn reported', {
        ...meta,
        possibleDuplicate: forwarded.length > 0,
      });
    }
    await effects.release();
  };

  return {
    onTurnReply,
    get turnsSeen() {
      return turnsSeen;
    },
    finish,
  };
}

/**
 * Did anything actually reach the user?
 *
 * `send_response` used to report success, and mark the conversation answered,
 * as soon as the transport call resolved. Resolving is not delivering. The
 * schema accepts `content: z.string()` with no minimum, so a blank body with no
 * media resolves happily and sends nothing; and a media-only Slack send can
 * come back with `mediaSent: 0`, every attachment having failed, while the
 * callback resolves normally (Lumen, PR #580 r2).
 *
 * Both cases then set the marker, which suppressed the auto-forward fallback
 * AND the nothing-delivered warning — so the most complete failure available,
 * a send where literally nothing arrived, was the one least likely to be
 * reported.
 *
 * Evidence, in order of strength:
 *   nonblank text      -> the body itself went out
 *   mediaSent > 0      -> the gateway counted attachments delivered
 *   media requested    -> weakest: the HTTP transport reports no per-item
 *                         counters, so an accepted request is all there is.
 *                         Kept deliberately rather than failing every
 *                         media-only send through that path.
 */
export function hasDeliveryEvidence(input: {
  content: string;
  mediaRequested: number;
  /** Undefined when the transport reports no per-item counters. */
  mediaSent?: number;
}): boolean {
  if (input.content.trim().length > 0) return true;
  if (input.mediaSent !== undefined) return input.mediaSent > 0;
  return input.mediaRequested > 0;
}

/**
 * Give every response the turn's session unless it already names one.
 *
 * `send_response` calls made from inside the request stamp their own validated
 * session at the tool boundary. Responses a runner synthesises from backend
 * output (the antigravity runner extracts them from tool events) carry none,
 * and routed as-is they logged `session_id` null — the same anonymous
 * `message_out` row #596 set out to remove, on a different path. The turn's
 * session is the right answer for those: it is the session that produced the
 * text. A session a response already carries is never overridden; it came from
 * a validated boundary and this function did not validate anything.
 */
export function attributeResponses<T extends { sessionId?: string }>(
  responses: T[],
  sessionId: string | undefined
): T[] {
  if (!sessionId) return responses;
  return responses.map((response) => (response.sessionId ? response : { ...response, sessionId }));
}
