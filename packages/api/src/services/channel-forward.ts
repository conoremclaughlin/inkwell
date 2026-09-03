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
 */

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
  // badge.
  //
  // But trim only DETECTS that; it must not be what gets sent. Leading
  // indentation is load-bearing in Markdown — a fenced block, a nested list —
  // and trimming the forwarded value would silently reformat the agent's answer
  // (Lumen, PR #580). Detect on the trimmed copy, forward the original.
  const text = input.finalTextResponse;
  if (!text || !text.trim()) return { action: 'nothing-delivered', reason: 'no-final-text' };

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
export interface ChannelForwardEffects {
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  debug(message: string, meta: Record<string, unknown>): void;
  release(payload?: { content: string; format: 'markdown' }): Promise<void>;
}

export async function applyChannelForward(
  decision: ChannelForwardDecision,
  context: {
    channel: string;
    conversationId: string;
    hadExplicitResponse: boolean;
    runSucceeded: boolean;
    finalTextLength: number;
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
    await effects.release({ content: decision.content, format: 'markdown' });
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
    effects.debug('Explicit send_response detected, skipping auto-forward', {
      channel,
      conversationId,
      hadExplicitResponse: context.hadExplicitResponse,
    });
  }

  await effects.release();
}
