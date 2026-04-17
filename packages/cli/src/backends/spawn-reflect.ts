/**
 * spawn-reflect: helper for `.live.test.ts` backend reflection tests.
 *
 * Spawns a backend CLI (claude | codex | gemini) via `ink -b <backend> -p`,
 * instructs the LLM to call the server's `debug_request` MCP tool,
 * and returns the reflected server-side context.
 *
 * What this proves: headers are actually reaching the server when the CLI
 * spawns the backend. Unit tests can only check the *intent* to inject
 * (adapter args/env); this checks that the chain end-to-end works —
 * adapter → backend runtime → MCP client → HTTP headers → server middleware.
 *
 * Prereqs (callers must arrange):
 *   - Target backend CLI installed on PATH (`claude`, `codex`, or `gemini`)
 *   - `ink` installed on PATH (or pass an explicit `inkBin`)
 *   - A running Inkwell server reachable at INK_SERVER_URL
 *   - Valid auth for both `ink` and the backend
 *
 * Live tests should `skipIf(!serverReachable)` themselves — this helper
 * only runs the CLI and parses output.
 */

import { spawn } from 'child_process';

export type LiveBackend = 'claude' | 'codex' | 'gemini';

export interface ReflectedRequestContext {
  transport: string;
  pinnedAgentId: string | null;
  requestContext: Record<string, unknown> | null;
  sessionContext: Record<string, unknown> | null;
}

export interface SpawnAndReflectOptions {
  backend: LiveBackend;
  /** Agent identity to pass via `-a` (defaults to studio identity) */
  agent?: string;
  /** Override the `ink` executable path (useful when testing local builds) */
  inkBin?: string;
  /** Extra env vars for the spawned process (merged with process.env) */
  env?: NodeJS.ProcessEnv;
  /** Working directory for spawn (defaults to current process cwd) */
  cwd?: string;
  /** Abort and reject after this many ms (default 90_000) */
  timeoutMs?: number;
  /** Forward stderr to our own stderr for debugging */
  inheritStderr?: boolean;
}

export interface SpawnAndReflectResult {
  reflected: ReflectedRequestContext;
  /** Raw stdout from the backend CLI (useful for debugging failures) */
  rawStdout: string;
  /** Raw stderr from the backend CLI */
  rawStderr: string;
  /** Exit code of the spawned `ink` process */
  exitCode: number | null;
}

const RESULT_MARKER = 'PCP_DEBUG_RESULT:';

/**
 * Prompt crafted to be compact and unambiguous across backends. We ask the
 * LLM to:
 *  1. Call `debug_request` with no args
 *  2. Copy the tool's JSON result verbatim after a known marker
 *  3. Output nothing else after that line
 *
 * The marker approach is less elegant than stream-json parsing but works
 * identically on claude/codex/gemini without per-backend formatter code.
 */
function buildReflectionPrompt(): string {
  return [
    'You are a test harness, not an assistant. Do exactly this and nothing else:',
    '',
    '1. Call the MCP tool named `debug_request` with no arguments.',
    '2. The tool returns a JSON object. Copy that JSON verbatim onto a single line,',
    `   prefixed with the literal marker "${RESULT_MARKER} " (marker, one space, then the JSON).`,
    '3. Do not explain, do not wrap in code fences, do not add anything after the JSON.',
    '',
    'If the tool is not available, output exactly: ' + RESULT_MARKER + ' UNAVAILABLE',
  ].join('\n');
}

/**
 * Parse reflected context out of CLI stdout. Tolerant to extra lines before
 * the marker (e.g. spinner output, banner). Errors if the marker is missing
 * or the JSON is unparseable.
 */
export function parseReflectedOutput(stdout: string): ReflectedRequestContext {
  const lines = stdout.split(/\r?\n/);
  const markerLine = lines.find((line) => line.trimStart().startsWith(RESULT_MARKER));
  if (!markerLine) {
    throw new Error(
      `debug_request marker not found in stdout. Last 400 chars:\n${stdout.slice(-400)}`
    );
  }
  const payload = markerLine.trimStart().slice(RESULT_MARKER.length).trim();
  if (payload === 'UNAVAILABLE') {
    throw new Error('Backend reported debug_request tool unavailable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(
      `Could not parse JSON after marker: ${(err as Error).message}\nPayload: ${payload}`
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Expected object from debug_request, got: ${typeof parsed}`);
  }
  return parsed as ReflectedRequestContext;
}

export async function spawnAndReflect(
  options: SpawnAndReflectOptions
): Promise<SpawnAndReflectResult> {
  const inkBin = options.inkBin ?? 'ink';
  const timeoutMs = options.timeoutMs ?? 90_000;
  // `--dangerous` is required: in `-p` mode there's no interactive permission
  // prompt, so any MCP tool call is rejected by default. Live tests run against
  // a trusted local server, so auto-approving is safe here.
  const args: string[] = ['--dangerous', '-b', options.backend];
  if (options.agent) {
    args.push('-a', options.agent);
  }
  args.push('-p', buildReflectionPrompt());

  const child = spawn(inkBin, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', options.inheritStderr ? 'inherit' : 'pipe'],
  });

  let rawStdout = '';
  let rawStderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    rawStdout += chunk;
  });
  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      rawStderr += chunk;
    });
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `spawnAndReflect timed out after ${timeoutMs}ms (backend=${options.backend}). Stdout so far:\n${rawStdout.slice(-400)}`
        )
      );
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const reflected = parseReflectedOutput(rawStdout);
  return { reflected, rawStdout, rawStderr, exitCode };
}
