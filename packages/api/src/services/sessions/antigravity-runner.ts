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
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
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

/** True when the config already names exactly this inkwell entry. */
async function inkEntryMatches(configPath: string, desired: unknown): Promise<boolean> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return JSON.stringify(parsed.mcpServers?.[INK_SERVER_KEY]) === JSON.stringify(desired);
  } catch {
    return false;
  }
}

/**
 * Unique scratch name for a temp-then-rename publish.
 *
 * The pid alone is not enough: several spawns inside ONE server race here, and
 * they all share a pid, so they would write the same scratch file and all but
 * one rename would hit ENOENT.
 */
let tmpCounter = 0;
let lockCounter = 0;
function scratchPath(target: string): string {
  tmpCounter += 1;
  return `${target}.${process.pid}.${tmpCounter}.tmp`;
}

/** A lock older than this is presumed abandoned by a crashed process. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Hold an exclusive lock across PROCESSES while mutating the host-global config.
 *
 * In-process mutexes are not enough here: the contending writers are separate
 * Node servers (main, isolated, dist), so the lock has to live in the
 * filesystem. `wx` is atomic on every platform we run on.
 */
export async function withFileLock(lockPath: string, fn: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // Ownership token, not just a pid. A waiter may decide our lock is stale and
  // take its own; if we then resume (machine sleep, long GC pause) an
  // unconditional unlink in our finally would free THEIR lock and let a third
  // writer into the critical section. Every removal checks this token first.
  lockCounter += 1;
  const token = `${process.pid}:${lockCounter}:${process.hrtime.bigint()}`;
  let held = false;

  const removeIfOurs = async (): Promise<void> => {
    try {
      if ((await readFile(lockPath, 'utf-8')) !== token) return;
      await rm(lockPath, { force: true });
    } catch {
      // Already gone, or unreadable — nothing safe to do either way.
    }
  };

  while (!held) {
    try {
      await writeFile(lockPath, token, { flag: 'wx' });
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      // Break a lock left behind by a process that died mid-write, otherwise a
      // single crash disables MCP for this backend permanently.
      //
      // The break is a RENAME, not a read-then-unlink. Checking the token and
      // then unlinking is two operations: two waiters can both read the same
      // stale owner, both decide to break it, and the second unlink removes
      // whichever fresh lock was acquired in between — putting two writers in
      // the critical section at once. rename() is atomic, so exactly one
      // breaker wins and the loser's rename fails with ENOENT.
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const claimed = `${lockPath}.broken.${token.replace(/[^\w.-]/g, '')}`;
          try {
            await rename(lockPath, claimed);
            await rm(claimed, { force: true });
          } catch {
            // Someone else broke it, or the owner released it first. Either
            // way the lock is no longer ours to break.
          }
          continue;
        }
      } catch {
        continue; // Vanished under us — retry immediately.
      }

      if (Date.now() > deadline) {
        // Proceeding unlocked could clobber a peer's servers.
        throw new Error(`Timed out waiting for ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    await fn();
  } finally {
    await removeIfOurs();
  }
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
    if (!isResume) {
      const preamble: string[] = [];
      const systemPrompt = config.appendSystemPrompt || config.systemPrompt;
      if (systemPrompt) preamble.push(systemPrompt);
      if (injectedContext) preamble.push(formatInjectedContext(injectedContext));
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

      const result = await this.spawnProcess(args, config, bridgePath);

      // agy reports failure in the result envelope, on stdout, with a real
      // message. Trust that over the exit code — reading the exit code is what
      // let a dead sibling look like a generic timeout for two months.
      if (result.status && result.status !== 'SUCCESS') {
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
    // The launcher's content is version-invariant, so every server writes the
    // same bytes here; the revision-specific bridge travels in env instead.
    const desired = { command: launcher, args: [] as string[] };

    const configPath = agyMcpConfigPath();
    await mkdir(dirname(configPath), { recursive: true });

    // A cheap unlocked check first. The authoritative comparison happens again
    // under the lock; this only avoids taking the lock on the common path where
    // the entry is already correct.
    if (await inkEntryMatches(configPath, desired)) return bridge;

    let installed = false;
    await withFileLock(`${configPath}.ink-lock`, async () => {
      // Re-read INSIDE the lock. The copy we compared a moment ago may already
      // be stale, and merging onto it would silently drop whatever a peer
      // process added in between.
      let existing: { mcpServers?: Record<string, unknown> } = {};
      let parsed = false;
      try {
        const raw = await readFile(configPath, 'utf-8');
        if (!raw.trim()) {
          parsed = true;
        } else {
          existing = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          parsed = true;
        }
      } catch (error) {
        // Distinguish "no file yet" from "file exists but will not parse".
        // Treating a transient read/parse failure as {} would wipe every other
        // MCP server the user configured.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') parsed = true;
      }

      if (!parsed) {
        // Leave the file untouched — we cannot see what else it holds — but do
        // NOT report success; the caller turns this into a failed spawn.
        logger.error(
          'Antigravity global MCP config is unreadable; leaving it alone rather than ' +
            'overwriting servers we cannot see',
          { path: configPath }
        );
        return;
      }

      const servers = { ...(existing.mcpServers || {}) };
      if (JSON.stringify(servers[INK_SERVER_KEY]) === JSON.stringify(desired)) {
        installed = true;
        return;
      }
      servers[INK_SERVER_KEY] = desired;

      // Publish by rename. writeFile truncates in place, so a concurrent agy
      // start can read a half-written file and see no servers at all.
      const body = `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
      const tmp = scratchPath(configPath);
      await writeFile(tmp, body, 'utf-8');
      await rename(tmp, configPath);
      installed = true;
      logger.info('Updated Antigravity global MCP config', { path: configPath, launcher, bridge });
    });

    if (!installed) {
      throw new Error(
        `Could not install the Ink MCP server into ${configPath}; refusing to start agy ` +
          'without its tools'
      );
    }
    return bridge;
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
