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

/** Container-side path for runner temp files, bind-mounted from the host staging dir */
export const CONTAINER_RUNNER_FILES = '/run/ink';

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
  /**
   * Data to write to the child's stdin (then close it). Implies pipeStdin.
   * Used to pass large prompts via stdin instead of argv — argv has an OS
   * limit (~256KB on macOS) and large transcripts trigger spawn E2BIG.
   */
  stdinData?: string;
  /** Hard timeout in ms, applied only when given (default: none). A working
   *  turn is never killed on wall-clock; idleTimeoutMs ends a silent one. */
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
 * The environment variables a spawned backend inherits from the server
 * process. Exact names, no prefixes: an unlisted member of a listed family
 * (`NVM_SOMETHING_NEW`, `INK_SOMETHING_NEW`) does not cross until someone adds
 * it here, in a diff, in review.
 *
 * Why an allowlist (spec:sender-token-binding v3 §4 Phase 0, task 7f4ceda4):
 * until 2026-09-29 the child received the server's ENTIRE environment minus
 * `CLAUDECODE`, so every spawned SB held the JWT signing key, the Supabase
 * service key, the OAuth client secret and both bot tokens (measured by Myra
 * from inside a runner). A process that holds the signing key can sign a token
 * for any identity; one that holds the service key writes any table. Token
 * binding cannot bind such a process, and a prompt injection that reaches an
 * SB's shell reaches those variables with no path and no trace.
 *
 * What the child needs instead is explicit: its session variables and its own
 * server-minted credentials arrive through `buildSessionEnv` and the spawner's
 * explicit env, which are applied on top of this list.
 */
export const SPAWN_ENV_INHERITED_NAMES: readonly string[] = [
  // Process basics.
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMINFO',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'PAGER',
  'LESS',
  'EDITOR',
  'VISUAL',
  // macOS session and text encoding; keychain access (gh, git credential helpers) needs the session.
  '__CF_USER_TEXT_ENCODING',
  'SECURITYSESSIONID',
  'XPC_FLAGS',
  'XPC_SERVICE_NAME',
  'COMMAND_MODE',
  // SSH agent, so git over ssh works in the child.
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  // Node, package managers and version managers. NODE_OPTIONS is deliberately
  // absent: it injects code into every node process. NODE_AUTH_TOKEN is a
  // registry credential and is absent too.
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'NVM_CD_FLAGS',
  'NODE_EXTRA_CA_CERTS',
  'COREPACK_ROOT',
  'COREPACK_HOME',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  'PNPM_HOME',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'PYENV_ROOT',
  'PYENV_SHELL',
  'RBENV_SHELL',
  'ANDROID_SDK_ROOT',
  'MANPATH',
  'INFOPATH',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // The docker client, for the container spawn path.
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  // Inkwell knobs a child reads (operator configuration, never a credential:
  // INK_ACCESS_TOKEN and INK_DELEGATION_SECRET are NOT here, a child gets its
  // own explicitly; see SESSION_ENV_HANDOFF_NAMES for the one case where a
  // session process hands its own down).
  'INK_SERVER_URL',
  'INK_PORT_BASE',
  'INK_CLI_PATH',
  'INK_STUDIOS_ROOT',
  'INK_MCP_URL',
  'INK_TOOL_POLICY_PATH',
  'SB_DEBUG',
  'SB_DEBUG_FILE',
  // Each runtime's own authentication and configuration, named one by one so
  // a new provider variable shows up as a diff. GOOGLE_CLIENT_ID/SECRET are
  // Inkwell's OAuth app, not the Gemini runtime's, and are absent.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_VERTEXAI',
  // A GitHub credential the SBs' own tooling uses: the repo's .mcp.json
  // interpolates it for the GitHub MCP server. It is a GitHub credential, not
  // an Inkwell one (Decision E, spec §7).
  'GITHUB_TOKEN',
];

/**
 * Build the env a spawned backend starts from.
 *
 * Only the names in SPAWN_ENV_INHERITED_NAMES cross from the parent (the
 * server process by default; tests pass a synthetic one). `extraEnv` is the
 * spawner's explicit contribution and is applied last: it wins over an
 * inherited value and may add names the list does not carry, because the
 * spawner knows what it is handing over. `CLAUDECODE` is never inherited, so a
 * server running inside a Claude Code session does not make its child think
 * it is nested.
 */
export function buildCleanEnv(
  extraEnv?: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const inherited: Record<string, string> = {};
  for (const name of SPAWN_ENV_INHERITED_NAMES) {
    const value = parent[name];
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...extraEnv };
}

/**
 * The session state a session process hands to a child that serves the SAME
 * session: the ink chat loop spawning its provider backend for a turn. These
 * are its own credentials and its own session identity, not the server's, so
 * handing them down is the one legitimate inheritance of a credential, and
 * it is explicit: the spawner calls sessionEnvHandoff() and merges the
 * result under its own prepared env. Nothing in this list is inherited by
 * buildCleanEnv on its own (Lumen, #694 r1: the provider grandchild lost its
 * INK_ACCESS_TOKEN the moment the server allowlist stopped the blanket
 * inheritance it had been riding on).
 */
export const SESSION_ENV_HANDOFF_NAMES: readonly string[] = [
  'INK_ACCESS_TOKEN',
  'INK_DELEGATION_SECRET',
  'INK_SESSION_ID',
  'INK_STUDIO_ID',
  'INK_CONTEXT',
  'INK_RUNTIME_LINK_ID',
  'INK_CONSTITUTION_INJECTED',
  'SB_SLUG',
  'AGENT_ID',
];

/**
 * The epoch of the server run that spawned an `ink chat` process. The server
 * sets it on the chat it spawns for a turn, and the chat's turn signal names
 * it on every lifecycle request instead of claiming an epoch of its own
 * (repl/turn-signal.ts, routes/hook-lifecycle.ts).
 *
 * It is deliberately in neither list above, so no provider spawned through
 * buildCleanEnv carries it: it describes the chat process's relationship to
 * one server run, and a provider child that inherited it would be naming a
 * turn it does not own. The chat's own local tools are another matter: a
 * run's bash tool was seen carrying the chat's environment (the #694 probe),
 * so a tool subprocess can carry it. Its only reader is the chat itself
 * (chat.ts), so the one effect is that a non-attached `ink chat` started from
 * a run's tool names the parent run's epoch and acts as another child of it.
 */
export const RUN_TURN_EPOCH_ENV = 'INK_RUN_TURN_EPOCH';

/** The SESSION_ENV_HANDOFF_NAMES present in `parent`, by exact name. */
export function sessionEnvHandoff(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const handoff: Record<string, string> = {};
  for (const name of SESSION_ENV_HANDOFF_NAMES) {
    const value = parent[name];
    if (value !== undefined) handoff[name] = value;
  }
  return handoff;
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
  execArgs.push('--', options.container.containerName, containerBinary, ...options.args);

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
  // stdinData implies pipeStdin (resolveSpawnTarget also checks it for docker -i)
  if (options.stdinData !== undefined && !options.pipeStdin) {
    options = { ...options, pipeStdin: true };
  }
  const target = resolveSpawnTarget(options);

  const child = spawn(target.binary, target.args, {
    shell: false,
    stdio: [options.pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    cwd: target.cwd,
    env: target.env,
  });

  if (options.stdinData !== undefined && child.stdin) {
    // EPIPE if the child exits before consuming stdin — swallow, the close
    // handler reports the real exit
    child.stdin.on('error', () => {});
    child.stdin.write(options.stdinData);
    child.stdin.end();
  }

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

    // Hard ceiling, only when the caller sets one.
    const hardTimeoutMs = options.timeoutMs;
    if (hardTimeoutMs !== undefined && hardTimeoutMs > 0) {
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
    }

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

    child.on('close', (code, signal) => {
      if (code !== null) return finalize(code);
      const SIG_CODES: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 };
      finalize(signal ? 128 + (SIG_CODES[signal] ?? 15) : 1);
    });
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
