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
import { mkdir, readFile, writeFile } from 'fs/promises';
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

interface AntigravityUsage {
  contextTokens: number;
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
    // The API compiles to CommonJS, so __dirname — not import.meta.url. It
    // resolves to src/services/sessions under tsx and dist/services/sessions
    // in a build; the package build step copies the .mjs across so both hold.
    const bridgePath = join(__dirname, BRIDGE_FILENAME);
    const desired = {
      command: process.execPath,
      args: [bridgePath],
    };

    const configPath = agyMcpConfigPath();
    let existing: { mcpServers?: Record<string, unknown> } = {};
    try {
      const raw = await readFile(configPath, 'utf-8');
      if (raw.trim()) existing = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      // Missing or unparseable — treat as empty rather than refusing to run.
      // Overwriting an unparseable file is the lesser harm: agy cannot read it
      // either, so nothing is lost that was working.
    }

    const servers = { ...(existing.mcpServers || {}) };
    const current = servers[INK_SERVER_KEY];
    if (JSON.stringify(current) === JSON.stringify(desired)) return;

    servers[INK_SERVER_KEY] = desired;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`,
      'utf-8'
    );
    logger.info('Updated Antigravity global MCP config', { path: configPath, bridgePath });
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
    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE so it doesn't leak into the subprocess and make agy
      // think it is nested inside a Claude Code session.
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const spawnEnv: Record<string, string> = {
        HOME: process.env.HOME || '',
        PATH: buildSpawnPath(agyBin),
        ...(config.agentId ? { AGENT_ID: config.agentId } : {}),
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
          resolve({
            ...finish(),
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
          finalTextResponse: finalTextResponse || '[Process hit hard timeout]',
        });
      }, PROCESS_TIMEOUT_MS);

      const consume = (line: string): void => {
        if (!line.trim()) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // Non-JSON on stdout in stream-json mode is noise.
        }

        const extracted = extractToolData(parsed);
        responses.push(...extracted.responses);
        toolCalls.push(...extracted.toolCalls);

        const text = extractTextDelta(parsed);
        if (text) finalTextResponse = (finalTextResponse || '') + text;

        // The final event carries the authoritative id, status and usage.
        if (parsed.event === 'result' && parsed.result) {
          const r = parsed.result as AgyResult;
          if (r.conversation_id) conversationId = r.conversation_id;
          if (r.status) status = r.status;
          if (r.error) resultError = r.error;
          if (r.response) finalTextResponse = r.response;
          if (r.usage) {
            usage = {
              contextTokens: r.usage.total_tokens || 0,
              inputTokens: r.usage.input_tokens || 0,
              outputTokens: r.usage.output_tokens || 0,
            };
          }
        }
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
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          // Already dead.
        }
      }, 5000);
    } catch {
      // Already dead.
    }
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
  const queue: unknown[] = [event];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = current as Record<string, unknown>;

    const name = obj.name;
    if (typeof name === 'string' && name.length > 0) {
      const rawInput = obj.parameters ?? obj.input ?? obj.args ?? obj.arguments;
      const input = normalizeInput(rawInput);

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
