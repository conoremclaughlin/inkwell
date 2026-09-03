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

  // Whitespace-only is not a reply. Forwarding it would satisfy the check and
  // still deliver nothing a reader can use, which is the failure wearing a
  // success badge.
  const text = input.finalTextResponse?.trim();
  if (!text) return { action: 'nothing-delivered', reason: 'no-final-text' };

  return { action: 'auto-forward', content: text };
}
