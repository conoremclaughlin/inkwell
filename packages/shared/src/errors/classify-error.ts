/**
 * Error Classification
 *
 * Classifies backend CLI errors (Gemini, Claude, Codex) into actionable categories.
 * Used by session-service (server-side), chat.ts / claude.ts (CLI-side),
 * and the trigger failure handler to produce consistent error metadata.
 */

export type ErrorCategory =
  | 'capacity'
  | 'quota'
  | 'timeout'
  | 'config'
  | 'auth'
  | 'crash'
  | 'unknown';

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
