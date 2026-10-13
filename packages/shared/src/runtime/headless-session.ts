import type { SessionSignal, SessionSignalState } from './context-tools.js';
import type { SessionTurnInput } from './session-turn.js';

export const CONTINUATION_PROMPT =
  'Continue working. Use signal_status to indicate when you are completed, blocked, or continuing.';

const FORWARDED_NOTE =
  ' Text you write in this turn is sent to the user as a message, so write only what is meant for them; if there is nothing new for them, call signal_status without writing text.';

/** Continuation text is user-visible when the host forwards each turn's reply. */
export function continuationPrompt(repliesForwarded: boolean): string {
  return repliesForwarded ? CONTINUATION_PROMPT + FORWARDED_NOTE : CONTINUATION_PROMPT;
}

export interface HeadlessSessionPorts {
  /** Must await the existing serialized turn, including its committed-reply callback. */
  runTurn(turn: number, input: SessionTurnInput): Promise<void>;
  sessionSignal: SessionSignalState;
  consecutiveBackendFailures(): number;
}

export interface HeadlessSessionResult {
  turnsCompleted: number;
  exitReason?: string;
  finalSignal: SessionSignal | null;
  phase: 'blocked:backend-error' | 'blocked:needs-input' | 'idle:completed' | 'idle:awaiting-input';
}

/**
 * The CLI's existing unattended outer turns. This does not replace the inner
 * agent loop: one outer turn can contain several provider/tool continuations.
 * Rendering, reporting, resource cleanup and persistence remain host ports.
 */
export async function runHeadlessSession(
  input: {
    message: string;
    messageLabel?: string;
    maxTurns: number;
    repliesForwarded: boolean;
    signal?: AbortSignal;
  },
  ports: HeadlessSessionPorts
): Promise<HeadlessSessionResult> {
  if (!input.message.trim()) throw new Error('A headless session requires a message');
  if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 25) {
    throw new RangeError('Headless maxTurns must be an integer between 1 and 25');
  }
  let turnsCompleted = 0;
  let exitReason: string | undefined;
  const messageLabel = input.messageLabel?.trim();
  for (let turn = 1; turn <= input.maxTurns; turn++) {
    input.signal?.throwIfAborted();
    ports.sessionSignal.clear();
    await ports.runTurn(
      turn,
      turn === 1
        ? {
            raw: input.message,
            source: messageLabel ? 'system' : 'user',
            displayLabel: messageLabel,
          }
        : {
            raw: continuationPrompt(input.repliesForwarded),
            source: 'system',
            displayLabel: 'continuation',
          }
    );
    turnsCompleted++;
    // The host owns cancellation of in-flight work. Never turn that into an
    // idle/completed receipt or start a new turn after it has been cancelled.
    input.signal?.throwIfAborted();
    const status = ports.sessionSignal.get();
    if (status?.status === 'completed' || status?.status === 'blocked') {
      exitReason = `${status.status}${status.reason ? `: ${status.reason}` : ''}`;
      break;
    }
    // Preserve the CLI's stricter first-turn failure rule. Later turns get
    // one unsuccessful attempt before two consecutive failures stop the run.
    if (ports.consecutiveBackendFailures() >= (turn === 1 ? 1 : 2)) {
      exitReason = 'backend_failure';
      break;
    }
  }
  const finalSignal = ports.sessionSignal.get();
  const phase =
    exitReason === 'backend_failure'
      ? 'blocked:backend-error'
      : finalSignal?.status === 'blocked'
        ? 'blocked:needs-input'
        : finalSignal?.status === 'completed'
          ? 'idle:completed'
          : 'idle:awaiting-input';
  return { turnsCompleted, exitReason, finalSignal, phase };
}
