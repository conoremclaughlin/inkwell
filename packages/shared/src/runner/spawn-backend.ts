/**
 * Shared Backend Process Spawning
 *
 * Consolidated utilities for spawning backend CLI processes (Claude, Codex, Gemini).
 * Used by both the API server runners and the CLI backend-runner.
 *
 * Centralizes:
 * - CLAUDECODE env var stripping (prevents nested session detection)
 * - Clean env construction
 * - Line-buffered output accumulation
 * - Timeout management (idle + hard ceiling)
 * - Process lifecycle (spawn → collect → finalize)
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface ContainerTarget {
  /** Docker container name or ID to exec into */
  containerName: string;
  /** Docker binary (default: 'docker') */
  dockerBinary?: string;
  /** Working directory inside the container (default: '/studio') */
  workDir?: string;
}

export interface SpawnBackendOptions {
  /** Absolute or PATH-relative binary name */
  binary: string;
  /** Arguments to pass to the binary */
  args: string[];
  /** Additional env vars to merge (on top of cleaned process.env) */
  env?: Record<string, string>;
  /** Working directory for the child process */
  cwd?: string;
  /** Whether to pipe stdin (default: false — stdin is 'ignore') */
  pipeStdin?: boolean;
  /** Hard timeout in ms (default: 30 minutes) */
  timeoutMs?: number;
  /** Idle timeout in ms — kill if no output for this long (default: none) */
  idleTimeoutMs?: number;
  /** Called on each stdout chunk */
  onStdout?: (chunk: string) => void;
  /** Called on each stderr chunk */
  onStderr?: (chunk: string) => void;
  /** Run the binary inside a Docker container instead of on the host */
  container?: ContainerTarget;
}

export interface SpawnBackendResult {
  /** Raw stdout output (trimmed) */
  stdout: string;
  /** Raw stderr output (trimmed) */
  stderr: string;
  /** Process exit code */
  exitCode: number;
  /** Duration in ms */
  durationMs: number;
  /** Whether the process timed out */
  timedOut: boolean;
  /** If timed out, was it idle or hard ceiling? */
  timeoutType?: 'idle' | 'hard';
}

// ─── Core ───────────────────────────────────────────────────────

/**
 * Build a clean env for backend spawning.
 *
 * Strips CLAUDECODE to prevent nested-session detection when sb/PCP
 * is itself running inside Claude Code (e.g., via PM2 or direct invocation).
 */
export function buildCleanEnv(
  extraEnv?: Record<string, string>
): Record<string, string | undefined> {
  const { CLAUDECODE, ...cleanEnv } = process.env;
  return { ...cleanEnv, ...extraEnv };
}

/**
 * Build the actual binary + args for spawning, handling container routing.
 *
 * When `container` is set, wraps the command in `docker exec` so the
 * binary runs inside the container. Env vars are passed via `-e` flags
 * and cwd via `--workdir`. The caller sees the same interface regardless
 * of execution target.
 */
export function resolveSpawnTarget(options: SpawnBackendOptions): {
  binary: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
} {
  if (!options.container) {
    return {
      binary: options.binary,
      args: options.args,
      cwd: options.cwd,
      env: buildCleanEnv(options.env),
    };
  }

  const docker = options.container.dockerBinary || 'docker';
  const execArgs = ['exec'];

  if (options.pipeStdin) {
    execArgs.push('-i');
  }

  const containerWorkDir = options.container.workDir || '/studio';
  if (options.cwd) {
    execArgs.push('--workdir', containerWorkDir);
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      execArgs.push('-e', `${key}=${value}`);
    }
  }

  // Use basename — the container has CLI tools on its PATH, not at host-resolved absolute paths
  const containerBinary = path.basename(options.binary);
  execArgs.push(options.container.containerName, containerBinary, ...options.args);

  return {
    binary: docker,
    args: execArgs,
    // cwd is inside the container (passed via --workdir), not on the host
    cwd: undefined,
    // Host env is clean but doesn't need the extra vars (they're inside the container)
    env: buildCleanEnv(),
  };
}

/**
 * Spawn a backend process with timeout management, output accumulation,
 * and CLAUDECODE env stripping.
 *
 * This is the canonical spawn function for all backend process invocations.
 * Both API server runners and CLI backend-runner should use this.
 *
 * When `options.container` is set, the binary runs inside the specified
 * Docker container via `docker exec`. The interface is identical — callers
 * don't need to know whether they're targeting host or container.
 */
export function spawnBackend(options: SpawnBackendOptions): {
  child: ChildProcess;
  result: Promise<SpawnBackendResult>;
} {
  const started = Date.now();
  const target = resolveSpawnTarget(options);

  const child = spawn(target.binary, target.args, {
    stdio: [options.pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    cwd: target.cwd,
    env: target.env,
  });

  let stdout = '';
  let stderr = '';
  let resolved = false;
  let timedOut = false;
  let timeoutType: 'idle' | 'hard' | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  const result = new Promise<SpawnBackendResult>((resolve) => {
    const finalize = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        timeoutType,
      });
    };

    // Hard ceiling timeout
    const hardTimeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    hardTimer = setTimeout(() => {
      timedOut = true;
      timeoutType = 'hard';
      child.kill('SIGTERM');
      // Give 5s for graceful shutdown, then SIGKILL
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
      finalize(124);
    }, hardTimeoutMs);
    hardTimer.unref?.();

    // Idle timeout (optional) — resets on any output
    const resetIdleTimer = () => {
      if (!options.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        timeoutType = 'idle';
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        killTimer.unref?.();
        finalize(124);
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();

    child.stdout?.on('data', (chunk) => {
      const str = String(chunk);
      stdout += str;
      options.onStdout?.(str);
      resetIdleTimer();
    });

    child.stderr?.on('data', (chunk) => {
      const str = String(chunk);
      stderr += str;
      options.onStderr?.(str);
      resetIdleTimer();
    });

    child.on('error', (error) => {
      stderr = `${stderr}\n${String(error)}`.trim();
      finalize(1);
    });

    child.on('close', (code) => finalize(code ?? 1));
  });

  return { child, result };
}

// ─── Line Buffer ────────────────────────────────────────────────

/**
 * Line-buffered stream parser.
 *
 * Accumulates chunks, splits on newlines, emits complete lines.
 * Handles partial lines across chunk boundaries (the "remainder" pattern
 * used by all API runners).
 */
export class LineBuffer {
  private buffer = '';

  /**
   * Feed a chunk and get back complete lines.
   * Partial trailing content is buffered for the next call.
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() || '';
    return parts;
  }

  /**
   * Flush any remaining buffered content as a final line.
   * Call this when the stream closes.
   */
  flush(): string | null {
    if (!this.buffer) return null;
    const line = this.buffer;
    this.buffer = '';
    return line;
  }
}
