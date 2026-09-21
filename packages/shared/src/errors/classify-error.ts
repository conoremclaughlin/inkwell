/**
 * Error Classification
 *
 * Classifies backend CLI errors (Gemini, Claude, Codex) into actionable categories.
 * Used by session-service (server-side), chat.ts / claude.ts (CLI-side),
 * and the trigger failure handler to produce consistent error metadata.
 */

export type ErrorCategory =
  | 'owner_conflict'
  | 'capacity'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'config'
  | 'auth'
  | 'crash'
  | 'unknown';

/**
 * Categories where the backend refused the run BEFORE accepting it — no turn
 * began, so the run observed nothing about the target session's own state.
 *
 * Callers use this to decide whether a failure may be written onto the target
 * session as an outcome. It must not be read as "the owner is alive": the
 * refusal proves a writer/lock exists on the backend thread, which is not a
 * heartbeat, not an authenticated endpoint, and not authority to refresh
 * owner registration or extend a lease (Lumen, spec:live-agent-surfaces).
 */
export function isPreAcceptanceRefusal(category: ErrorCategory): boolean {
  return category === 'owner_conflict';
}

export interface ErrorClassification {
  category: ErrorCategory;
  summary: string;
  retryable: boolean;
}

interface ClassifyInput {
  errorText: string;
  backend?: string;
  exitCode?: number | null;
}

/** Pattern rules checked in priority order. First match wins. */
const RULES: Array<{
  category: ErrorCategory;
  retryable: boolean;
  test: (input: ClassifyInput) => boolean;
}> = [
  {
    // FIRST, deliberately: the backend refused to start because another writer
    // already holds the thread. It is the most specific signature we receive
    // and the only one that says something about a session OTHER than the
    // spawn's own health, so a looser rule must never claim it first.
    //
    // Measured on spec:live-agent-surfaces, 2026-09-21: four resumes into
    // Codex thread 019d0180 were refused this way while its owner was working,
    // and each one landed `lifecycle='failed', cli_attached=false` on the live
    // owner's row. Classified `unknown` at the time — the `crash` rule's
    // exit-code test is the one that would otherwise have caught it, and
    // session-service calls classifyError without an exitCode.
    //
    // Patterns are the signatures we have actually observed. Codex 0.154 emits
    // the thread-store conflict on stderr and the JSON-RPC refusal on stdout;
    // both appear in the same captured text. Other backends get added here
    // when a real refusal from them has been seen, not guessed at.
    category: 'owner_conflict',
    // Not retryable, matching what this text already classified as: an
    // immediate re-dispatch would re-resume the same held thread and be
    // refused again. Recovery belongs to reconciliation, not to the runner.
    //
    // Naming it does change one downstream behaviour, deliberately.
    // session-service's flushQueueOnNonRetryableError acts on classifications
    // that are non-retryable AND not `unknown`, so this text used to fall
    // through it and every queued message took its own turn at resuming the
    // held thread. Now the queue is flushed with a named reason instead.
    retryable: false,
    test: ({ errorText }) =>
      /already has an active writer/i.test(errorText) || /thread-store conflict/i.test(errorText),
  },
  {
    category: 'capacity',
    retryable: true,
    test: ({ errorText }) =>
      /high demand/i.test(errorText) ||
      /RESOURCE_EXHAUSTED/i.test(errorText) ||
      /\b503\b/.test(errorText) ||
      /overloaded_error/i.test(errorText) ||
      /\b529\b/.test(errorText) ||
      /\boverloaded\b/i.test(errorText) ||
      /\bno capacity\b/i.test(errorText) ||
      /\bcapacity available\b/i.test(errorText),
  },
  {
    category: 'quota',
    retryable: false,
    test: ({ errorText }) =>
      /usage limit/i.test(errorText) ||
      /session limit/i.test(errorText) ||
      /\bquota\b/i.test(errorText) ||
      /TerminalQuotaError/i.test(errorText) ||
      /rate_limit_error/i.test(errorText) ||
      /\b429\b/.test(errorText),
  },
  {
    category: 'timeout',
    retryable: true,
    test: ({ errorText, exitCode }) =>
      /timed? ?out/i.test(errorText) ||
      /\btimeout\b/i.test(errorText) ||
      (/\bidle\b/i.test(errorText) && /\bkill/i.test(errorText)) ||
      exitCode === 124,
  },
  {
    // Transient network / connectivity failures — the request never completed.
    // Seen when the host's network dips mid-spawn: undici connect timeouts
    // ("fetch failed" + UND_ERR_CONNECT_TIMEOUT), codex stream disconnects
    // ("stream disconnected before completion: error sending request"), and
    // codex startup model-list refresh failures. Note: signatures containing
    // the literal word "timeout" (e.g. "failed to refresh available models:
    // timeout waiting for child process") match the timeout rule above —
    // both categories are retryable, so either classification triggers retry.
    category: 'network',
    retryable: true,
    test: ({ errorText }) =>
      /stream disconnected/i.test(errorText) ||
      /error sending request/i.test(errorText) ||
      /fetch failed/i.test(errorText) ||
      /UND_ERR_CONNECT/i.test(errorText) ||
      /UND_ERR_SOCKET/i.test(errorText) ||
      /failed to refresh available models/i.test(errorText) ||
      /\bECONNRESET\b/.test(errorText) ||
      /\bECONNREFUSED\b/.test(errorText) ||
      /\bETIMEDOUT\b/.test(errorText) ||
      /\bENETUNREACH\b/.test(errorText) ||
      /\bEHOSTUNREACH\b/.test(errorText) ||
      /\bEAI_AGAIN\b/.test(errorText) ||
      /socket hang ?up/i.test(errorText) ||
      /\bnetwork error\b/i.test(errorText),
  },
  {
    category: 'auth',
    retryable: false,
    test: ({ errorText }) =>
      /authentication_error/i.test(errorText) ||
      /UNAUTHENTICATED/i.test(errorText) ||
      /\b401\b/.test(errorText) ||
      /\b403\b/.test(errorText) ||
      /\bunauthorized\b/i.test(errorText) ||
      /invalid api key/i.test(errorText),
  },
  {
    category: 'config',
    retryable: false,
    test: ({ errorText }) =>
      /ModelNotFoundError/i.test(errorText) ||
      /\bENOENT\b/.test(errorText) ||
      /command not found/i.test(errorText) ||
      (/\bmodel\b/i.test(errorText) && /not found/i.test(errorText)),
  },
  {
    category: 'crash',
    retryable: false,
    test: ({ errorText, exitCode }) =>
      /\bsegfault\b/i.test(errorText) ||
      /\bOOM\b/.test(errorText) ||
      /\bkilled\b/i.test(errorText) ||
      (exitCode != null && exitCode !== 0),
  },
];

/**
 * Classify a backend error into an actionable category.
 *
 * @param input.errorText  The raw error text (stderr, exception message, etc.)
 * @param input.backend    Optional backend name (gemini, claude, codex) — for future backend-specific rules
 * @param input.exitCode   Optional process exit code
 */
export function classifyError(input: ClassifyInput): ErrorClassification {
  const text = input.errorText || '';

  for (const rule of RULES) {
    if (rule.test({ ...input, errorText: text })) {
      return {
        category: rule.category,
        summary: truncateSummary(text),
        retryable: rule.retryable,
      };
    }
  }

  return {
    category: 'unknown',
    summary: truncateSummary(text),
    retryable: false,
  };
}

/** Keep the summary short but useful — first meaningful line, capped at 200 chars. */
function truncateSummary(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) || text;
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
}
