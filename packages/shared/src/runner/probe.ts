/**
 * A short, bounded child run whose stdout is the answer: a backend's own
 * config-only command, such as `codex mcp list --json`, asked before a spawn.
 *
 * The child's output can carry secrets (Codex prints static header values in
 * the clear), so this returns stdout to the caller and nothing else: a
 * failure is classified only from the error's `code`, `signal` and `killed`,
 * never its message, which quotes the command line and stderr. stderr is
 * discarded. The caller owns the env it passes, and should pass only what
 * the command needs.
 */

import { execFile } from 'child_process';

/** Bytes of stdout a probe may produce; more is refused as overflow. */
export const PROBE_MAX_BUFFER = 1024 * 1024;

export type ProbeFailure =
  | { kind: 'no-time' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'overflow' }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'spawn'; code: string };

export type ProbeResult = { ok: true; stdout: string } | { ok: false; failure: ProbeFailure };

export interface ProbeOptions {
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Ends the probe early; an aborted probe is `aborted`. */
  signal?: AbortSignal;
  /** The probe's whole budget. Zero or less refuses without starting it. */
  timeoutMs: number;
}

interface ExecError {
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
}

/** The failure, from the error's code, signal and killed flag only. */
function classify(error: ExecError): ProbeFailure {
  if (error.code === 'ABORT_ERR') return { kind: 'aborted' };
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'overflow' };
  if (error.killed === true) return { kind: 'timeout' };
  if (typeof error.code === 'number') return { kind: 'exit', exitCode: error.code };
  if (typeof error.signal === 'string') return { kind: 'signal', signal: error.signal };
  if (typeof error.code === 'string') return { kind: 'spawn', code: error.code };
  return { kind: 'spawn', code: 'UNKNOWN' };
}

export function runProbe(
  binary: string,
  args: readonly string[],
  options: ProbeOptions
): Promise<ProbeResult> {
  if (options.timeoutMs <= 0) return Promise.resolve({ ok: false, failure: { kind: 'no-time' } });
  if (options.signal?.aborted) return Promise.resolve({ ok: false, failure: { kind: 'aborted' } });
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        env: { ...options.env },
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: PROBE_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(
          error ? { ok: false, failure: classify(error as ExecError) } : { ok: true, stdout }
        );
      }
    );
  });
}
