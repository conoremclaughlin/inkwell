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
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type {
  InjectedContext,
  ClaudeRunnerConfig,
  RunnerResult,
  ChannelResponse,
  ChannelType,
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
export function stagedBridgePath(): string {
  return join(homedir(), '.ink', 'runtime', BRIDGE_FILENAME);
}

/** Copy the bridge to its installed location if it is missing or out of date. */
export async function stageBridge(): Promise<string> {
  const target = stagedBridgePath();
  const source = join(__dirname, BRIDGE_FILENAME);
  const desired = await readFile(source, 'utf-8');

  try {
    if ((await readFile(target, 'utf-8')) === desired) return target;
  } catch {
    // Missing or unreadable — fall through and (re)publish it.
  }

  await mkdir(dirname(target), { recursive: true });
  // Same reason as the config: rename so agy never execs a half-written file.
  // 0o755 because the config invokes it directly, relying on its shebang
  // rather than naming a node binary that differs between nvm versions.
  const tmp = scratchPath(target);
  await writeFile(tmp, desired, { encoding: 'utf-8', mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, target);
  logger.info('Staged Antigravity MCP bridge', { target });
  return target;
}

/**
 * Which Ink server this turn should talk to.
 *
 * Order matters. INK_SERVER_URL is the canonical runtime variable and is what
 * the container orchestrator rewrites, so it wins. Otherwise fall back to the
 * URL the workspace's own .mcp.json names — that is how an isolated server on
 * PCP_PORT_BASE=4001 identifies itself, and GeminiRunner already reads the same
 * file for the same reason. Only then the default.
 */
export async function resolveInkMcpUrl(config: ClaudeRunnerConfig): Promise<string> {
  const fromEnv = process.env.INK_SERVER_URL;
  if (fromEnv) return `${fromEnv.replace(/\/+$/, '')}/mcp`;

  try {
    const raw = await readFile(join(config.workingDirectory, '.mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { url?: string; serverUrl?: string }>;
    };
    const entry = parsed.mcpServers?.[INK_SERVER_KEY];
    const url = entry?.url || entry?.serverUrl;
    if (url) return url;
  } catch {
    // No workspace config, or unreadable — fall through to the default.
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
  let held = false;

  while (!held) {
    try {
      await writeFile(lockPath, `${process.pid}`, { flag: 'wx' });
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      // Break a lock left behind by a process that died mid-write, otherwise a
      // single crash disables MCP for this backend permanently.
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // Vanished under us — retry immediately.
      }

      if (Date.now() > deadline) {
        // Proceeding unlocked could clobber a peer's servers. Skipping means
        // this spawn runs without Ink tools, which is visible and recoverable.
        throw new Error(`Timed out waiting for ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
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
      if (config.pcpAccessToken) {
        await this.ensureGlobalMcpConfig();
      }

      const args = buildAgyArgs(fullMessage, config, backendSessionId);
      logger.info('Spawning Antigravity CLI', {
        isResume,
        backendSessionId: backendSessionId || '(new)',
        workingDirectory: config.workingDirectory,
        messageLength: fullMessage.length,
        hasPcpAccessToken: !!config.pcpAccessToken,
        identityInPrompt: !isResume && !!(config.appendSystemPrompt || config.systemPrompt),
      });

      const result = await this.spawnProcess(args, config);

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
   * Point agy's host-global MCP config at the stdio bridge.
   *
   * Safe to run on every spawn: the entry is static (a command and a path —
   * no token, no session id), so concurrent spawns write identical bytes and
   * there is nothing to race over. Per-session credentials reach the bridge
   * through the environment instead. Any other servers the user configured are
   * preserved.
   */
  private async ensureGlobalMcpConfig(): Promise<void> {
    const bridgePath = await stageBridge();
    // No `command: process.execPath` and no checkout-relative args: the bridge
    // carries a `#!/usr/bin/env node` shebang and is executed directly, so this
    // entry is byte-identical from every process, checkout and build.
    const desired = { command: bridgePath, args: [] as string[] };

    const configPath = agyMcpConfigPath();
    await mkdir(dirname(configPath), { recursive: true });

    // A cheap unlocked check first. The authoritative comparison happens again
    // under the lock; this only avoids taking the lock on the common path where
    // the entry is already correct.
    if (await inkEntryMatches(configPath, desired)) return;

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
        logger.warn(
          'Antigravity global MCP config is unreadable; leaving it alone rather than ' +
            'overwriting servers we cannot see',
          { path: configPath }
        );
        return;
      }

      const servers = { ...(existing.mcpServers || {}) };
      if (JSON.stringify(servers[INK_SERVER_KEY]) === JSON.stringify(desired)) return;
      servers[INK_SERVER_KEY] = desired;

      // Publish by rename. writeFile truncates in place, so a concurrent agy
      // start can read a half-written file and see no servers at all.
      const body = `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
      const tmp = scratchPath(configPath);
      await writeFile(tmp, body, 'utf-8');
      await rename(tmp, configPath);
      logger.info('Updated Antigravity global MCP config', { path: configPath, bridgePath });
    });
  }

  private async spawnProcess(
    args: string[],
    config: ClaudeRunnerConfig
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
          this.killProcess(proc);
          settled = true;
          // status/error, not just a marker string: run() decides success from
          // `status`, so resolving bare here reports a killed turn as a
          // successful one — the session goes idle and the marker can be
          // forwarded to a human as if it were the agent's answer.
          resolve({
            ...finish(),
            status: 'TIMEOUT',
            error: `Antigravity produced no output for ${idleSecs}s and was killed`,
            finalTextResponse: finalTextResponse || `[Process timed out after ${idleSecs}s idle]`,
          });
        }, IDLE_TIMEOUT_MS);
      };
      resetIdleTimer();

      const timeout = setTimeout(() => {
        if (settled) return;
        logger.error('Antigravity CLI hit hard timeout, killing', {
          timeoutMs: PROCESS_TIMEOUT_MS,
        });
        this.killProcess(proc);
        settled = true;
        resolve({
          ...finish(),
          status: 'TIMEOUT',
          error: `Antigravity exceeded the ${Math.round(PROCESS_TIMEOUT_MS / 1000)}s ceiling and was killed`,
          finalTextResponse: finalTextResponse || '[Process hit hard timeout]',
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

        if (code !== 0) {
          logger.warn('Antigravity CLI exited with non-zero code', { code, status, resultError });
          // Only fall back to stderr when the structured result told us nothing.
          // agy reports real failures (auth, tier, timeout) in the result event
          // on stdout; stderr is mostly language-server chatter.
          if (!status && responses.length === 0 && !finalTextResponse) {
            reject(
              new Error(
                `agy exited with code ${code}: ${resultError || stderr.trim() || 'no error output captured'}`
              )
            );
            return;
          }
        }

        resolve(finish());
      });
    });
  }

  private killProcess(proc: ChildProcess): void {
    // `proc.killed` only means a signal was DELIVERED, so it flips true the
    // instant SIGTERM is sent — gating the escalation on it means a
    // SIGTERM-resistant child is never actually force-killed. Track real exit.
    let exited = false;
    proc.once('exit', () => {
      exited = true;
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      return; // Already gone.
    }

    const escalation = setTimeout(() => {
      if (exited) return;
      try {
        proc.kill('SIGKILL');
      } catch {
        // Raced with a normal exit.
      }
    }, 5000);
    // Do not hold the event loop open purely to escalate a kill.
    escalation.unref?.();
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
 * Extract tool calls and send_response calls from a stream event.
 *
 * agy nests tool data at `step_update.tool_info` as {name, parameters,
 * output, error}, but the envelope shape has already moved once (Gemini's
 * `type` became `event`), so this walks the whole object breadth-first the
 * way CodexRunner and GeminiRunner do rather than trusting one path.
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

        if (name === 'mcp__inkwell__send_response') {
          const typed = input as Record<string, unknown>;
          const channel = (typed.channel as ChannelType) || 'telegram';
          const conversationId = typed.conversationId as string | undefined;
          const content = typed.content as string | undefined;
          if (channel && conversationId && content) {
            responses.push({
              channel,
              conversationId,
              content,
              format: typed.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
              replyToMessageId: typed.replyToMessageId as string | undefined,
              metadata: typed.metadata as Record<string, unknown> | undefined,
              media: typed.media as ChannelResponse['media'],
            });
            logger.debug('Captured send_response from Antigravity', { channel, conversationId });
          }
        }
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
