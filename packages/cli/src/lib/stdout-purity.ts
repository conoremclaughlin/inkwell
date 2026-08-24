/**
 * stdout purity for machine-readable output modes.
 *
 * `--session-candidates-json` promises a stdout that `JSON.parse` accepts,
 * but the path to the payload prints diagnostics from all over the CLI —
 * server-update notices, hook-health warnings, PCP-unavailable warnings,
 * profile messages. Silencing each one individually means finding them all
 * and finding them again whenever a new one is added.
 *
 * Instead the entry point diverts console.log to stderr and the code that
 * writes the payload restores it first. Warnings stay visible on stderr,
 * stdout carries only the payload. console.error and direct
 * process.stdout.write are untouched — the latter deliberately, so a caller
 * that genuinely needs raw stdout still has it.
 */

let restore: (() => void) | null = null;

/** Route console.log to stderr until {@link restoreConsoleLog}. Idempotent. */
export function divertConsoleLogToStderr(): void {
  if (restore) return;
  const original = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  restore = () => {
    console.log = original;
  };
}

/** Restore console.log. Safe to call when no diversion is active. */
export function restoreConsoleLog(): void {
  restore?.();
  restore = null;
}
