/**
 * Antigravity Runner
 *
 * Spawns Google's Antigravity CLI (`agy`) in non-interactive mode. This is the
 * successor to GeminiRunner, not a rename of it: Google cut off the OAuth
 * "Code Assist for individuals" free tier for third-party clients on
 * 2026-06-18 (IneligibleTierError / UNSUPPORTED_CLIENT, exit 55) and moved the
 * headless surface to `agy`. GeminiRunner is left in place untouched — a team
 * programme still authenticates against it, so it is dormant here rather than
 * dead everywhere.
 *
 * Where this diverges from GeminiRunner, and why:
 *   - `--output-format stream-json`, not `-o stream-json`
 *   - `--dangerously-skip-permissions`, not `--yolo`
 *   - `--conversation <id>`, not `-r <uuid>`; the id is `conversation_id` and
 *     arrives in the FINAL event, not an `init` event, so it is captured on
 *     completion rather than at startup. There is no `--session-id` to assign
 *     one up front.
 *   - No system-prompt flag exists at all (no `--policy`, no `GEMINI_SYSTEM_MD`).
 *     Identity is folded into the first-turn message alongside injected context.
 *   - MCP auth goes through a stdio bridge. See antigravity-mcp-bridge.mjs for
 *     why; the short version is that `agy` reads one host-global config file and
 *     does not interpolate env vars into it.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type {
  InjectedContext,
  ClaudeRunnerConfig,
  RunnerResult,
  ChannelResponse,
  IRunner,
  ToolCall,
} from './types.js';
import { formatInjectedContext } from './context-builder.js';
import { logger } from '../../utils/logger.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import { buildSessionEnv, resolveSpawnTarget } from '@inklabs/shared';

/** Maximum time (ms) to wait for an agy subprocess before killing it.
 *  Override with ANTIGRAVITY_PROCESS_TIMEOUT_MS. */
const PROCESS_TIMEOUT_MS =
  parseInt(process.env.ANTIGRAVITY_PROCESS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000;

/** Idle timeout: no output for this long = stuck. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Grace between SIGTERM and SIGKILL, then between SIGKILL and giving up. */
const KILL_ESCALATION_MS = 5_000;
const KILL_GIVEUP_MS = 5_000;

/** agy's own `--print-timeout` defaults to 5m, which is far too short for agent
 *  work. Keep it just under our hard ceiling so agy reports the timeout itself
 *  (as a structured result event) before we resort to killing the process. */
const PRINT_TIMEOUT_SECONDS = Math.floor((PROCESS_TIMEOUT_MS - 30_000) / 1000);

/**
 * The single host-global file `agy` reads MCP servers from.
 *
 * Resolved per call, not once at module load. A module-level homedir() is
 * captured before anything can change HOME, and when it resolves to '' the
 * join silently produces a RELATIVE path — so the config lands in whatever the
 * process cwd happens to be and agy reads nothing, with no error anywhere.
 */
function agyMcpConfigPath(): string {
  return join(homedir(), '.gemini', 'config', 'mcp_config.json');
}

/** Server key — must match what tool names are namespaced under (mcp__inkwell__*). */
const INK_SERVER_KEY = 'inkwell';

/** Sibling file, copied into dist by the package build step. */
const BRIDGE_FILENAME = 'antigravity-mcp-bridge.mjs';

/**
 * Where the bridge is published for agy to execute.
 *
 * Deliberately NOT the spawning checkout's copy. `agy` reads one host-global
 * config, so whatever path lands in it is used by every server on this machine
 * — the main dev server, a built dist server, and the isolated worktree servers
 * this repo explicitly runs in parallel. Publishing `__dirname` would mean one
 * process executes another's bridge revision, or a path whose worktree has
 * since been deleted. A single installed location keeps the entry identical no
 * matter who writes it.
 */
const RUNTIME_DIR = () => join(homedir(), '.ink', 'runtime');

/**
 * The stable path named in agy's host-global config.
 *
 * This file's CONTENT never varies with the bridge implementation — it only
 * reads INK_BRIDGE_PATH and delegates. That distinction is the point. Making
 * the config path stable was not enough on its own: every server still
 * overwrote one shared executable with its own checkout's bytes, so a peer on a
 * different revision could atomically replace the bridge between our staging it
 * and agy exec'ing it, and we would run their implementation. Atomic rename
 * prevents half-written files, not version crossover.
 *
 * With a version-invariant launcher, concurrent writers write identical bytes
 * (so overwriting is a no-op) and the revision-specific part is selected
 * per-spawn through inherited env, which no peer can reach.
 */
export function launcherPath(): string {
  return join(RUNTIME_DIR(), 'agy-mcp-launcher.mjs');
}

const LAUNCHER_SOURCE = [
  '#!/usr/bin/env node',
  '// Generated by AntigravityRunner. Version-invariant on purpose: agy reads one',
  '// host-global config, so this path is shared by every Ink server on this machine.',
  '// The revision-specific bridge is chosen per-spawn via INK_BRIDGE_PATH.',
  'const target = process.env.INK_BRIDGE_PATH;',
  'if (!target) {',
  "  process.stderr.write('[ink-bridge] INK_BRIDGE_PATH is not set; refusing to guess\\n');",
  '  process.exit(1);',
  '}',
  'import(target).catch((error) => {',
  "  process.stderr.write('[ink-bridge] cannot load ' + target + ': ' + error + '\\n');",
  '  process.exit(1);',
  '});',
  '',
].join('\n');

/** Content-addressed so two server revisions coexist instead of overwriting. */
export function bridgePathForContent(content: string): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return join(RUNTIME_DIR(), 'bridges', `antigravity-mcp-bridge-${digest}.mjs`);
}

/** Publish a file if absent or different. Executable, atomic, idempotent. */
async function publish(target: string, content: string): Promise<void> {
  try {
    if ((await readFile(target, 'utf-8')) === content) return;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = scratchPath(target);
  await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, target);
}

/**
 * Install the launcher and this revision's bridge.
 * Returns the content-addressed bridge path to hand the child via env.
 */
export async function stageBridge(): Promise<{ launcher: string; bridge: string }> {
  const source = await readFile(join(__dirname, BRIDGE_FILENAME), 'utf-8');
  const bridge = bridgePathForContent(source);

  // Bridge first: the launcher must never be reachable before its target is.
  await publish(bridge, source);
  const launcher = launcherPath();
  await publish(launcher, LAUNCHER_SOURCE);

  return { launcher, bridge };
}

/**
 * Which Ink server this turn should talk to.
 *
 * The workspace `.mcp.json` is NOT authoritative, and is checked last. The
 * standard isolation recipe in CLAUDE.md is `PCP_PORT_BASE=4001 yarn dev`,
 * which does not rewrite the repo's committed `.mcp.json` — that file still
 * says 3001. Trusting it would make an isolated server hand its bearer token
 * and context to the MAIN server, the specific thing this repo is emphatic
 * about not disturbing.
 */
export async function resolveInkMcpUrl(config: ClaudeRunnerConfig): Promise<string> {
  // Passed down from server.ts, derived from env.MCP_HTTP_PORT — the same value
  // the HTTP listener actually bound. Authoritative over every config file.
  if (config.inkMcpUrl) return config.inkMcpUrl;

  const fromEnv = process.env.INK_SERVER_URL;
  if (fromEnv) return `${fromEnv.replace(/\/+$/, '')}/mcp`;

  // Our own process env: if this server was started with a port base, that is
  // the port it is listening on, whatever any config file claims.
  const portBase = (process.env.INK_PORT_BASE || process.env.PCP_PORT_BASE || '').trim();
  if (/^\d+$/.test(portBase)) return `http://localhost:${portBase}/mcp`;

  const candidates = [config.mcpConfigPath, join(config.workingDirectory, '.mcp.json')].filter(
    Boolean
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf-8')) as {
        mcpServers?: Record<string, { url?: string; serverUrl?: string }>;
      };
      const entry = parsed.mcpServers?.[INK_SERVER_KEY];
      const url = entry?.url || entry?.serverUrl;
      if (url) return url;
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }

  return 'http://localhost:3001/mcp';
}

/**
 * Unique scratch name for a temp-then-rename publish.
 *
 * The pid alone is not enough: several spawns inside ONE server race here, and
 * they all share a pid, so they would write the same scratch file and all but
 * one rename would hit ENOENT.
 */
let tmpCounter = 0;
function scratchPath(target: string): string {
  tmpCounter += 1;
  return `${target}.${process.pid}.${tmpCounter}.tmp`;
}

/**
 * Why there is no mutex here.
 *
 * Four attempts at one failed the same way: POSIX has no atomic
 * compare-and-delete, so every "check who owns the lock, then remove it" scheme
 * leaves a window — and proper-lockfile's mtime heartbeat cannot see a lock
 * stolen and replaced between two ticks, which is exactly our case, because
 * this critical section is two file operations and finishes well inside one.
 *
 * The deeper problem is that the lock guarded a conflict that no longer exists
 * and could never guard the one that does. Since the launcher became
 * version-invariant, every Ink server writes an IDENTICAL inkwell entry, so
 * Ink-versus-Ink is not a conflict at all. The remaining risk is a third party
 * — a human editing this file, or agy itself — and those writers never take our
 * lock, so no amount of locking constrains them.
 *
 * So: no lock. Read, merge, re-read to confirm the base did not move, publish
 * by atomic rename, then verify our entry actually landed and retry if not.
 * Every writer wants the same entry, so the loop converges. The residual window
 * is between the confirming re-read and the rename — one syscall, and one a
 * mutex would not have closed against a non-participating writer anyway.
 */
const CONFIG_WRITE_ATTEMPTS = 5;

interface ConfigSnapshot {
  /** False only when the file exists but cannot be read or parsed. */
  readable: boolean;
  /** Exact bytes, used to detect that the base moved under us. */
  raw: string;
  value: { mcpServers?: Record<string, unknown> };
}

export async function readConfigSnapshot(configPath: string): Promise<ConfigSnapshot> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    // Absent is normal; anything else means we cannot see the file.
    const code = (error as NodeJS.ErrnoException).code;
    return { readable: code === 'ENOENT', raw: '', value: {} };
  }

  if (!raw.trim()) return { readable: true, raw, value: {} };

  try {
    return {
      readable: true,
      raw,
      value: JSON.parse(raw) as { mcpServers?: Record<string, unknown> },
    };
  } catch {
    // Present but unparseable. Treating this as {} would erase every other MCP
    // server the user configured, so it is reported unreadable instead.
    return { readable: false, raw, value: {} };
  }
}

export function entryMatches(
  value: { mcpServers?: Record<string, unknown> },
  desired: unknown
): boolean {
  return JSON.stringify(value.mcpServers?.[INK_SERVER_KEY]) === JSON.stringify(desired);
}

interface AntigravityUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The `result` payload, shared by --output-format json and the final stream event. */
interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export class AntigravityRunner implements IRunner {
  async run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<RunnerResult> {
    const { backendSessionId, injectedContext, config } = options;
    const isResume = !!backendSessionId;

    // agy has no system-prompt flag, so identity has to ride in the message.
    // First turn only: on resume the identity block is already in the
    // conversation history, and repeating it every turn would both waste
    // context and read as the caller re-introducing themselves each time.
    let fullMessage = message;
    let runConfig = config;
    if (!isResume) {
      const preamble: string[] = [];
      const systemPrompt = config.appendSystemPrompt || config.systemPrompt;
      if (systemPrompt) preamble.push(systemPrompt);
      if (injectedContext) {
        preamble.push(formatInjectedContext(injectedContext));
        runConfig = { ...config, constitutionInjected: true };
      }
      if (preamble.length > 0) {
        fullMessage = `${preamble.join('\n\n')}\n\n---\n\n${message}`;
      }
    }

    try {
      const bridgePath = config.pcpAccessToken ? await this.ensureGlobalMcpConfig() : undefined;

      const args = buildAgyArgs(fullMessage, config, backendSessionId);
      logger.info('Spawning Antigravity CLI', {
        isResume,
        backendSessionId: backendSessionId || '(new)',
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
        identityInPrompt: !isResume && !!(config.appendSystemPrompt || config.systemPrompt),
      });

      const result = await this.spawnProcess(args, runConfig, bridgePath);

      // agy reports failure in the result envelope, on stdout, with a real
      // message. Trust that over the exit code — reading the exit code is what
      // let a dead sibling look like a generic timeout for two months.
      //
      // But status alone is too blunt. agy stamps status:ERROR for a tool call
      // that failed even when the agent RECOVERED and completed the turn, so
      // treating every non-SUCCESS as fatal meant a single malformed tool call
      // killed a turn the agent had already answered. Measured on 1.1.13:
      //
      //   recovered:  {status:'ERROR', response:'RECOVERED\n', error:'...Invalid arguments...'}
      //   genuinely broken: {status:'ERROR', response:'', error:'authentication failed...'}
      //
      // The response body is the discriminator, not the status. GeminiRunner
      // never read status at all, which is why the same tool errors were
      // invisible there — this stricter reading arrived with the antigravity
      // runner and regressed recovery, rather than exposing something new.
      if (!isTurnSuccessful(result)) {
        return {
          success: false,
          backendSessionId: result.conversationId || backendSessionId || null,
          responses: result.responses,
          toolCalls: result.toolCalls,
          usage: result.usage,
          finalTextResponse: result.finalTextResponse,
          error: result.error || `Antigravity run ended with status ${result.status}`,
        };
      }

      if (result.status && result.status !== 'SUCCESS') {
        // Recovered: the agent produced an answer despite an error along the
        // way. Surfaced at warn so the tool failure is still visible — it is a
        // real defect worth fixing — without failing a turn that succeeded.
        logger.warn('Antigravity turn recovered from an error mid-run', {
          status: result.status,
          error: result.error,
          responseLength: result.finalTextResponse?.length ?? 0,
        });
      }

      return {
        success: true,
        backendSessionId: result.conversationId || backendSessionId || null,
        responses: result.responses,
        usage: result.usage,
        finalTextResponse: result.finalTextResponse,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error('Antigravity process failed', {
        backendSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        backendSessionId: backendSessionId || null,
        responses: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Point agy's host-global MCP config at the launcher, and return the
   * revision-specific bridge path for this spawn.
   *
   * Throws rather than returning quietly when the entry cannot be installed.
   * An agy that starts without this config has no bootstrap, no memory and no
   * send_response, yet still produces a fluent-looking answer — a silently
   * toolless agent is worse than a failed spawn.
   */
  private async ensureGlobalMcpConfig(): Promise<string> {
    const { launcher, bridge } = await stageBridge();
    // Version-invariant: every Ink server writes byte-identical bytes for this
    // key, which is what makes the loop below safe without a mutex.
    const desired = { command: launcher, args: [] as string[] };

    const configPath = agyMcpConfigPath();
    await mkdir(dirname(configPath), { recursive: true });

    for (let attempt = 1; attempt <= CONFIG_WRITE_ATTEMPTS; attempt += 1) {
      const before = await readConfigSnapshot(configPath);

      if (!before.readable) {
        // Leave the file untouched — we cannot see what else it holds — and do
        // NOT report success. An agy started without this config has no
        // bootstrap, no memory and no send_response, yet still produces a
        // fluent-looking answer; a silently toolless agent is worse than a
        // failed spawn.
        throw new Error(
          `Ink MCP config at ${configPath} is unreadable; refusing to start agy without its tools`
        );
      }

      if (entryMatches(before.value, desired)) return bridge;

      const servers = { ...(before.value.mcpServers || {}) };
      servers[INK_SERVER_KEY] = desired;
      const body = `${JSON.stringify({ ...before.value, mcpServers: servers }, null, 2)}\n`;

      const tmp = scratchPath(configPath);
      await writeFile(tmp, body, 'utf-8');

      // Re-read immediately before publishing. If the file moved under us our
      // merge is built on stale content and would drop whatever landed in
      // between, so discard the candidate and rebuild from the new base.
      //
      // `readable` is checked FIRST and is not redundant. An unreadable file
      // (EACCES, EISDIR, I/O error) reports raw:'' — the same sentinel an
      // absent or empty file reports. So when the candidate was built from an
      // absent base and an unreadable file appears in between, the byte
      // comparison succeeds and we would rename straight over a file we were
      // never able to inspect. Comparing content is only meaningful if we could
      // actually read the content.
      const current = await readConfigSnapshot(configPath);
      if (!current.readable || current.raw !== before.raw) {
        await rm(tmp, { force: true });
        continue;
      }

      // rename is atomic: no reader ever sees a half-written config.
      await rename(tmp, configPath);

      // Verify rather than assume. The loop converges because every writer
      // wants the same entry.
      const after = await readConfigSnapshot(configPath);
      if (after.readable && entryMatches(after.value, desired)) {
        logger.info('Updated Antigravity global MCP config', {
          path: configPath,
          launcher,
          bridge,
          attempt,
        });
        return bridge;
      }
    }

    throw new Error(
      `Could not install the Ink MCP server into ${configPath} after ` +
        `${CONFIG_WRITE_ATTEMPTS} attempts; refusing to start agy without its tools`
    );
  }

  private async spawnProcess(
    args: string[],
    config: ClaudeRunnerConfig,
    bridgePath?: string
  ): Promise<{
    responses: ChannelResponse[];
    usage?: AntigravityUsage;
    finalTextResponse?: string;
    toolCalls: ToolCall[];
    conversationId?: string;
    status?: string;
    error?: string;
  }> {
    const agyBin = await resolveBinaryPath('agy');
    const mcpUrl = await resolveInkMcpUrl(config);
    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE so it doesn't leak into the subprocess and make agy
      // think it is nested inside a Claude Code session.
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const spawnEnv: Record<string, string> = {
        HOME: process.env.HOME || '',
        PATH: buildSpawnPath(agyBin),
        ...(config.agentId ? { AGENT_ID: config.agentId } : {}),
        // Tells the session-start hook the constitution is already in the
        // prompt, so it does not inject a second copy.
        ...(config.constitutionInjected ? { INK_CONSTITUTION_INJECTED: '1' } : {}),
        // Explicit endpoint for the bridge. Without it the bridge falls back to
        // localhost:3001, so an isolated server on PCP_PORT_BASE=4001 would send
        // its bearer token and context to the MAIN server.
        INK_MCP_URL: mcpUrl,
        // Selects THIS revision's bridge. The launcher named in the global
        // config reads it, which is what keeps concurrent servers on different
        // revisions from running each other's implementation.
        ...(bridgePath ? { INK_BRIDGE_PATH: bridgePath } : {}),
        // These are what the stdio bridge reads to build its HTTP headers.
        ...buildSessionEnv({
          pcpSessionId: config.pcpSessionId,
          studioId: config.studioId,
          accessToken: config.pcpAccessToken,
          agentId: config.agentId,
          runtime: 'antigravity',
          repoRoot: config.repoRoot,
        }),
      };

      const target = resolveSpawnTarget({
        binary: agyBin,
        args,
        cwd: config.workingDirectory,
        env: spawnEnv,
        container: config.container,
      });

      const proc = spawn(target.binary, target.args, {
        cwd: target.cwd,
        env: config.container ? target.env : { ...cleanEnv, ...spawnEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutRemainder = '';
      const responses: ChannelResponse[] = [];
      const toolCalls: ToolCall[] = [];
      let usage: AntigravityUsage | undefined;
      let finalTextResponse: string | undefined;
      let conversationId: string | undefined;
      let status: string | undefined;
      let resultError: string | undefined;
      let settled = false;
      let lastActivityAt = Date.now();

      const finish = () => ({
        responses,
        usage,
        toolCalls,
        finalTextResponse,
        conversationId,
        status,
        error: resultError,
      });

      let idleTimer: NodeJS.Timeout;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled) return;
          const idleSecs = Math.round((Date.now() - lastActivityAt) / 1000);
          logger.error('Antigravity CLI idle too long, killing', {
            idleSeconds: idleSecs,
            hasResponses: responses.length > 0,
            hasFinalText: !!finalTextResponse,
          });
          settled = true;
          // Await real termination before releasing the turn. Resolving on the
          // SIGTERM alone lets SessionService finalize and release the session
          // while the old agy and its bridge are still executing MCP side
          // effects against it.
          void this.killProcess(proc)
            .catch((error) => {
              // Never let a fault in teardown strand the turn — resolve anyway.
              logger.error('Antigravity teardown failed after idle timeout', { error });
            })
            .then(() => {
              // status/error, not just a marker string: run() decides success
              // from `status`, so resolving bare reports a killed turn as a
              // successful one — the session goes idle and the marker can be
              // forwarded to a human as if it were the agent's answer. The word
              // "timeout" is load-bearing: classifyError matches on it, and
              // without it this classifies as a non-retryable crash.
              resolve({
                ...finish(),
                status: 'TIMEOUT',
                error: `Antigravity timeout: no output for ${idleSecs}s, process killed`,
                finalTextResponse:
                  finalTextResponse || `[Process timed out after ${idleSecs}s idle]`,
              });
            });
        }, IDLE_TIMEOUT_MS);
      };
      resetIdleTimer();

      const timeout = setTimeout(() => {
        if (settled) return;
        logger.error('Antigravity CLI hit hard timeout, killing', {
          timeoutMs: PROCESS_TIMEOUT_MS,
        });
        settled = true;
        void this.killProcess(proc)
          .catch((error) => {
            logger.error('Antigravity teardown failed after hard timeout', { error });
          })
          .then(() => {
            resolve({
              ...finish(),
              status: 'TIMEOUT',
              error: `Antigravity timeout: exceeded the ${Math.round(PROCESS_TIMEOUT_MS / 1000)}s ceiling, process killed`,
              finalTextResponse: finalTextResponse || '[Process hit hard timeout]',
            });
          });
      }, PROCESS_TIMEOUT_MS);

      const acc: AgyStreamState = {
        responses,
        toolCalls,
        get usage() {
          return usage;
        },
        set usage(v) {
          usage = v;
        },
        get finalTextResponse() {
          return finalTextResponse;
        },
        set finalTextResponse(v) {
          finalTextResponse = v;
        },
        get conversationId() {
          return conversationId;
        },
        set conversationId(v) {
          conversationId = v;
        },
        get status() {
          return status;
        },
        set status(v) {
          status = v;
        },
        get error() {
          return resultError;
        },
        set error(v) {
          resultError = v;
        },
      };

      const consume = (line: string): void => {
        if (!line.trim()) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // Non-JSON on stdout in stream-json mode is noise.
        }
        applyAgyEvent(acc, parsed);
      };

      proc.stdout.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        const combined = `${stdoutRemainder}${data.toString()}`;
        const lines = combined.split('\n');
        stdoutRemainder = lines.pop() ?? '';
        for (const line of lines) consume(line);
      });

      proc.stderr.on('data', (data) => {
        lastActivityAt = Date.now();
        resetIdleTimer();
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn agy: ${error.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        if (settled) return;
        settled = true;

        if (stdoutRemainder.trim()) consume(stdoutRemainder);

        if (code !== 0 && !status) {
          // Resolve, never reject. Rejecting discards the accumulator — including
          // the conversation id agy emitted on `init` — so the next message would
          // start a fresh conversation and could repeat side effects the crashed
          // turn already performed. And resolving bare would report success:true
          // for a non-zero exit whenever partial text happened to arrive first.
          logger.warn('Antigravity CLI exited with non-zero code', { code, resultError });
          resolve({
            ...finish(),
            status: 'CRASH',
            error: `agy exited with code ${code}: ${
              resultError || stderr.trim() || 'no error output captured'
            }`,
          });
          return;
        }

        if (code !== 0) {
          logger.warn('Antigravity CLI exited non-zero after reporting a status', {
            code,
            status,
          });
        }

        resolve(finish());
      });
    });
  }

  /**
   * Terminate the child and RESOLVE ONLY ONCE IT IS ACTUALLY GONE.
   *
   * `proc.killed` only means a signal was delivered, so it flips true the
   * instant SIGTERM is sent — gating escalation on it means a SIGTERM-resistant
   * child is never force-killed. And returning before exit lets the caller
   * finalize the session while the child is still making MCP calls against it.
   */
  private killProcess(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      // `let` and declared BEFORE finish(). These were `const` below the
      // function that clears them, so the `proc.kill` catch path — the one
      // taken when the child is already gone — hit them in the temporal dead
      // zone and threw a ReferenceError out of the promise executor. Callers
      // only attach .then(), so nothing observed the rejection and the turn
      // stayed pending forever: a hang, not a crash.
      let escalation: NodeJS.Timeout | undefined;
      let giveUp: NodeJS.Timeout | undefined;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        if (escalation) clearTimeout(escalation);
        if (giveUp) clearTimeout(giveUp);
        resolve();
      };

      proc.once('exit', finish);

      try {
        proc.kill('SIGTERM');
      } catch {
        finish(); // Already gone.
        return;
      }

      escalation = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Raced with a normal exit.
        }
      }, KILL_ESCALATION_MS);

      // Never block the turn forever on an unkillable child. Past this point
      // the process is unreachable and waiting longer helps nobody.
      giveUp = setTimeout(() => {
        logger.error('Antigravity child did not exit after SIGKILL', { pid: proc.pid });
        finish();
      }, KILL_ESCALATION_MS + KILL_GIVEUP_MS);
    });
  }
}

/**
 * Did this turn actually produce an answer?
 *
 * agy overloads exactly ONE status, and we have measured it. `ERROR` covers
 * both a run that could not proceed and a run where a tool call failed but the
 * agent handled it and finished:
 *
 *   recovered        {status:'ERROR', response:'RECOVERED\n', error:'...Invalid arguments...'}
 *   genuinely broken {status:'ERROR', response:'',            error:'authentication failed...'}
 *
 * Only the first is a completed turn. Treating both as fatal is what made a
 * single malformed tool call discard a reply the agent had already written, and
 * hand the sender a failure notice for a message that had been delivered.
 *
 * This is an ALLOWLIST of the overloaded status, deliberately, not a denylist
 * of fatal ones. A denylist says "anything I have not named is recoverable",
 * which extends a single measurement to every status agy might add later — an
 * unlisted fatal status carrying a diagnostic or partial answer would be read
 * as a success. The safe default for a status we have never observed is
 * failure, and the cost of being wrong that way is a retry rather than a
 * silently swallowed error. (Lumen, PR #507.)
 */
const RECOVERABLE_STATUSES = new Set(['ERROR']);

export function isTurnSuccessful(result: { status?: string; finalTextResponse?: string }): boolean {
  if (!result.status || result.status === 'SUCCESS') return true;
  // A status we have measured as overloaded succeeds only with a real answer.
  if (RECOVERABLE_STATUSES.has(result.status)) {
    return Boolean(result.finalTextResponse && result.finalTextResponse.trim());
  }
  // Everything else — TIMEOUT and CRASH from this runner, CANCELED/INTERRUPTED
  // and anything agy adds later — is a stopped run, so any text is partial.
  return false;
}

export function buildAgyArgs(
  message: string,
  config: ClaudeRunnerConfig,
  resumeConversationId?: string
): string[] {
  const args: string[] = [
    '-p',
    message,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${PRINT_TIMEOUT_SECONDS}s`,
  ];

  if (resumeConversationId) {
    args.push('--conversation', resumeConversationId);
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  return args;
}

/**
 * Pull incremental assistant text out of a stream event.
 *
 * Only `step_update` carries `text_delta`. The final `result` event repeats
 * the whole response, and is handled separately so it replaces the
 * accumulated deltas rather than doubling them.
 */ export function extractTextDelta(event: Record<string, unknown>): string | undefined {
  if (event.event !== 'step_update') return undefined;
  const update = (event.step_update ?? event) as Record<string, unknown>;
  const delta = update.text_delta;
  return typeof delta === 'string' && delta.length > 0 ? delta : undefined;
}

/**
 * Extract tool calls from a stream event, for the activity stream.
 *
 * agy nests tool data at `step_update.tool_info` as {name, parameters, output,
 * error}, but the envelope shape has already moved once (Gemini's `type` became
 * `event`), so this walks the whole object breadth-first the way CodexRunner and
 * GeminiRunner do rather than trusting one path.
 *
 * `responses` is ALWAYS EMPTY here, deliberately. Unlike the runners that parse
 * a local tool loop, every agy tool call reaches the live Inkwell MCP server
 * through the bridge — so by the time we see `send_response` in the stream,
 * handleSendResponse has already invoked the ChannelGateway and marked the
 * conversation answered. Returning a ChannelResponse as well would make
 * server.ts route the identical message a second time and the user would
 * receive it twice. The field stays on the return shape only because IRunner
 * defines it.
 *
 * Note this became reachable only once the call_mcp_tool unwrapping landed:
 * before that the name never matched, so nothing was ever synthesised and the
 * double-send was latent rather than visible.
 */ export function extractToolData(event: Record<string, unknown>): {
  responses: ChannelResponse[];
  toolCalls: ToolCall[];
} {
  const responses: ChannelResponse[] = [];
  const toolCalls: ToolCall[] = [];

  // agy reports each tool twice: ACTIVE when it starts, DONE when it finishes.
  // Recording both doubles every entry in the activity stream and would deliver
  // any send_response twice. DONE is the one that carries the result, and a
  // still-running tool is not a completed call, so ACTIVE is dropped.
  if (event.event === 'step_update') {
    const update = (event.step_update ?? event) as Record<string, unknown>;
    if (update.state === 'ACTIVE') return { responses, toolCalls };
  }

  const queue: unknown[] = [event];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = current as Record<string, unknown>;

    const rawName = obj.name;
    if (typeof rawName === 'string' && rawName.length > 0) {
      const rawInput = obj.parameters ?? obj.input ?? obj.args ?? obj.arguments;
      const unwrapped = unwrapMcpCall(rawName, normalizeInput(rawInput));
      const { toolName: name, input } = unwrapped;

      if (input && typeof input === 'object') {
        toolCalls.push({
          toolUseId:
            typeof obj.id === 'string'
              ? obj.id
              : typeof obj.tool_call_id === 'string'
                ? obj.tool_call_id
                : '',
          toolName: name,
          input: input as Record<string, unknown>,
        });
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return { responses, toolCalls };
}

/**
 * Turn agy's MCP wrapper into the namespaced tool name the rest of Ink uses.
 *
 * agy does not emit `mcp__inkwell__get_timezone`. Every MCP call arrives as a
 * single generic tool:
 *
 *   tool_info.name = "call_mcp_tool"
 *   parameters     = { ServerName: "inkwell", ToolName: "get_timezone",
 *                      Arguments: {...} }
 *
 * Left as-is, the activity stream records every MCP call as an indistinguishable
 * `call_mcp_tool`, and send_response is never recognised at all — so a reply the
 * agent did send would never reach its channel.
 */
export function unwrapMcpCall(name: string, input: unknown): { toolName: string; input: unknown } {
  if (name !== 'call_mcp_tool' || !input || typeof input !== 'object') {
    return { toolName: name, input };
  }

  const wrapper = input as Record<string, unknown>;
  const server = wrapper.ServerName ?? wrapper.serverName;
  const tool = wrapper.ToolName ?? wrapper.toolName;
  if (typeof server !== 'string' || typeof tool !== 'string') {
    return { toolName: name, input };
  }

  const args = normalizeInput(wrapper.Arguments ?? wrapper.arguments) ?? {};
  return { toolName: `mcp__${server}__${tool}`, input: args };
}

export function normalizeInput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

/** Mutable accumulator threaded through the stream. */
export interface AgyStreamState {
  responses: ChannelResponse[];
  toolCalls: ToolCall[];
  usage?: AntigravityUsage;
  finalTextResponse?: string;
  conversationId?: string;
  status?: string;
  error?: string;
}

/** Fresh accumulator — exported so tests can drive the reducer directly. */
export function newAgyStreamState(): AgyStreamState {
  return { responses: [], toolCalls: [] };
}

/**
 * Fold one agy stream event into the accumulated run state.
 *
 * Extracted from the stdout handler so the envelope handling can be tested
 * against recorded events without spawning agy — the alternative is that the
 * only coverage of init/result semantics is an end-to-end run.
 */
export function applyAgyEvent(acc: AgyStreamState, parsed: Record<string, unknown>): void {
  const extracted = extractToolData(parsed);
  acc.responses.push(...extracted.responses);
  acc.toolCalls.push(...extracted.toolCalls);

  const text = extractTextDelta(parsed);
  if (text) acc.finalTextResponse = (acc.finalTextResponse || '') + text;

  // agy 1.1.13 emits the id on `init`, before any model or tool work. Recording
  // it immediately means a crash or kill AFTER side effects still leaves us able
  // to resume that conversation instead of starting a fresh one and repeating
  // them. The result event stays authoritative when it arrives.
  if (parsed.event === 'init' && typeof parsed.conversation_id === 'string') {
    acc.conversationId = parsed.conversation_id;
  }

  if (parsed.event === 'result' && parsed.result) {
    const r = parsed.result as AgyResult;
    if (r.conversation_id) acc.conversationId = r.conversation_id;
    if (r.status) acc.status = r.status;
    if (r.error) acc.error = r.error;
    if (r.response) acc.finalTextResponse = r.response;
    if (r.usage) {
      // No contextTokens. agy's total_tokens sums every step's usage across the
      // whole invocation, so earlier steps are counted repeatedly — it is run
      // billing, not what is currently in the context window. The field means
      // occupancy, and absent means unknown, not zero (CodexRunner omits it for
      // the same reason).
      acc.usage = {
        inputTokens: r.usage.input_tokens || 0,
        outputTokens: r.usage.output_tokens || 0,
      };
    }
  }
}
