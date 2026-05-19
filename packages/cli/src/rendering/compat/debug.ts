/**
 * Shim for Claude Code's src/utils/debug.ts
 *
 * The rendering engine calls logForDebugging() for diagnostic output.
 * Claude Code's version has deep deps (bufferedWriter, cleanupRegistry, etc.)
 * so we provide a lightweight implementation.
 */

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

export function logForDebugging(_message: string, _options?: { level: DebugLogLevel }): void {
  // No-op in Inkwell CLI. Enable via environment variable if needed.
}
