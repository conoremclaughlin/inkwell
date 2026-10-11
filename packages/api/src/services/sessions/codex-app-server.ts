/** Owned app-server child for an admitted standard Codex run, never a daemon attachment. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { buildSessionEnv, resolveSpawnTarget, writeRuntimeSessionHint } from '@inklabs/shared';
import { createNativeSessionSteering } from '@inklabs/shared/runtime';
import { CodexRpcError, createCodexAppServerProtocol } from './codex-app-server-protocol.js';
import { resolveBinaryPath, buildSpawnPath } from './resolve-binary.js';
import { stopProcessAndWait, probeGroup, isGroupId } from './stop-process.js';
import type { ClaudeRunnerConfig, RunnerResult, ChannelResponse, ToolCall } from './types.js';

/** Preserve the runner's MCP/auth overrides; only the transport changes. */
export function buildCodexAppServerArgs(input: {
  config: ClaudeRunnerConfig;
  promptPath: string;
  writableRoots: readonly string[];
}): string[] {
  const { config } = input;
  if (!config.inkMcpUrl || config.container)
    throw new Error("Native Codex requires this host's explicit MCP endpoint and local child");
  const url = new URL(config.inkMcpUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid native Codex MCP endpoint');
  const settings: Record<string, unknown> = {
    approval_policy: 'never',
    sandbox_mode: config.sandboxBypass ? 'danger-full-access' : 'workspace-write',
    'sandbox_workspace_write.writable_roots': input.writableRoots,
    model_instructions_file: input.promptPath,
    'mcp_servers.inkwell.url': config.inkMcpUrl,
    'mcp_servers.inkwell.bearer_token_env_var': 'INK_ACCESS_TOKEN',
    'mcp_servers.inkwell.env_http_headers.x-ink-context': 'INK_CONTEXT',
    'mcp_servers.inkwell.env_http_headers.x-ink-agent-id': 'AGENT_ID',
    'mcp_servers.inkwell.env_http_headers.x-ink-session-id': 'INK_SESSION_ID',
    'mcp_servers.inkwell.env_http_headers.x-ink-studio-id': 'INK_STUDIO_ID',
  };
  return [
    ...Object.entries(settings).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]),
    'app-server',
    '--listen',
    'stdio://',
  ];
}

export async function runOwnedCodexAppServer(input: {
  args: string[];
  message: string;
  config: ClaudeRunnerConfig;
  backendSessionId?: string;
  ceilingMs?: number;
}): Promise<RunnerResult> {
  const { config } = input;
  const binding = config.nativeSteering;
  if (!binding) throw new Error('Native Codex requires an admitted steering binding');
  const log = await binding.openLog();
  let result: RunnerResult | undefined;
  try {
    const binary = await resolveBinaryPath('codex');
    const runtimeLinkId = randomUUID();
    binding.assertCurrent();
    config.signal?.throwIfAborted();
    const refusal = config.admitSpawn?.();
    if (refusal !== undefined) {
      result = {
        success: false,
        backendSessionId: input.backendSessionId ?? null,
        responses: [],
        refusedBeforeSpawn: true,
        error: refusal,
      };
      return result;
    }
    if (config.inkSessionId)
      writeRuntimeSessionHint(
        config.workingDirectory,
        config.inkSessionId,
        config.sbSlug || 'unknown',
        'codex',
        runtimeLinkId,
        config.studioId
      );
    const target = resolveSpawnTarget({
      binary,
      args: input.args,
      cwd: config.workingDirectory,
      pipeStdin: true,
      env: {
        ...config.launchEnv,
        HOME: process.env.HOME || '',
        PATH: buildSpawnPath(binary),
        ...(config.sbSlug ? { SB_SLUG: config.sbSlug, AGENT_ID: config.sbSlug } : {}),
        ...(config.constitutionInjected ? { INK_CONSTITUTION_INJECTED: '1' } : {}),
        ...buildSessionEnv({
          inkSessionId: config.inkSessionId,
          runtimeLinkId,
          studioId: config.studioId,
          accessToken: config.inkAccessToken,
          delegationSecret: config.inkDelegationSecret,
          sbSlug: config.sbSlug,
          runtime: 'codex',
          repoRoot: config.repoRoot,
        }),
      },
    });
    // Nothing asynchronous between the final owner check and spawn.
    binding.assertCurrent();
    const killGroup = config.killProcessGroup === true;
    let stopOwned = () => {};
    let confirmExit!: (result: { childExited: boolean }) => void;
    const exited = new Promise<{ childExited: boolean }>((resolve) => {
      confirmExit = resolve;
    });
    const ownership = binding.ownChild({ abort: () => stopOwned(), settled: exited });
    let released = false;
    let survivorPoll: ReturnType<typeof setInterval> | undefined;
    const giveBack = () => {
      if (released) return;
      released = true;
      clearInterval(survivorPoll);
      ownership.release();
      confirmExit({ childExited: true });
    };
    // Reserve before spawn, without yielding. A failed spawn started nothing.
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(target.binary, target.args, {
        cwd: target.cwd,
        env: target.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: killGroup,
      });
    } catch (error) {
      giveBack();
      throw error;
    }
    result = await new Promise<RunnerResult>((resolve) => {
      let finishing = false,
        closed = false;
      let terminalFailure: string | undefined;
      let stopAttemptFinished = false;
      let leaderExited = false;
      const reconcileExit = () => {
        // Never signal a remembered group again. Only an observed leader exit
        // and, for detached children, a read-only empty-group probe release it.
        if (!stopAttemptFinished || released) return;
        if (!(leaderExited || closed || proc.exitCode !== null || proc.signalCode !== null)) return;
        if (killGroup && (!isGroupId(proc.pid) || probeGroup(proc.pid) !== 'empty')) return;
        giveBack();
      };
      let release: (() => void) | undefined;
      let mailbox: ReturnType<typeof createNativeSessionSteering> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let finalTextResponse: string | undefined;
      let usage: RunnerResult['usage'];
      const responses: ChannelResponse[] = [],
        toolCalls: ToolCall[] = [];
      const seenTools = new Set<string>();
      let closeProcess!: () => void;
      const processClosed = new Promise<void>((done) => {
        closeProcess = done;
      });
      const protocol = createCodexAppServerProtocol({
        assertCurrent: binding.assertCurrent,
        write: (line) => {
          if (closed || proc.stdin.destroyed || proc.stdin.writableEnded)
            throw new Error('Codex input is closed');
          proc.stdin.write(line);
        },
        inserted: (messageId) => {
          void mailbox?.observeInserted(messageId);
        },
        terminal: (error) => {
          void finish(error);
        },
        event: (method, params) => {
          if (method === 'thread/tokenUsage/updated') {
            const total = (
              params.tokenUsage as
                | { total?: { inputTokens?: unknown; outputTokens?: unknown } }
                | undefined
            )?.total;
            if (
              typeof total?.inputTokens === 'number' &&
              typeof total.outputTokens === 'number' &&
              Number.isFinite(total.inputTokens) &&
              Number.isFinite(total.outputTokens)
            )
              usage = {
                inputTokens: total.inputTokens,
                outputTokens: total.outputTokens,
                cumulative: true,
              };
          }
          if (method !== 'item/completed') return;
          const item = params.item as Record<string, unknown> | undefined;
          if (item?.type === 'agentMessage' && typeof item.text === 'string')
            finalTextResponse = item.text;
          if (item?.type !== 'mcpToolCall' || typeof item.id !== 'string' || seenTools.has(item.id))
            return;
          seenTools.add(item.id);
          const args =
            item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
              ? (item.arguments as Record<string, unknown>)
              : {};
          const name = `mcp__${item.server}__${item.tool}`;
          toolCalls.push({ toolUseId: item.id, toolName: name, input: args });
          if (
            name === 'mcp__inkwell__send_response' &&
            item.status === 'completed' &&
            typeof args.channel === 'string' &&
            typeof args.conversationId === 'string' &&
            typeof args.content === 'string'
          )
            responses.push({
              channel: args.channel as ChannelResponse['channel'],
              conversationId: args.conversationId,
              content: args.content,
              format: args.format as ChannelResponse['format'],
              replyToMessageId: args.replyToMessageId as string | undefined,
              metadata: args.metadata as ChannelResponse['metadata'],
              media: args.media as ChannelResponse['media'],
            });
        },
      });

      async function finish(error?: string) {
        // A native final frame starts cleanup, not a successful process exit.
        // Retain failures that arrive while that cleanup is already waiting.
        terminalFailure ??= error;
        if (finishing) return;
        finishing = true;
        clearTimeout(timeout);
        config.signal?.removeEventListener('abort', onAbort);
        protocol.close();
        // Synchronous admission fence precedes every await and process stop.
        const settlement = mailbox?.close(error ? 'provider_failed' : 'turn_finished');
        try {
          proc.stdin.end();
        } catch {
          error ??= 'Codex app-server input close failed';
        }
        let stopUnconfirmed: RunnerResult['stopUnconfirmed'];
        if (!closed) {
          // EOF lets app-server flush its own transcript. A wedged transport
          // is then stopped with the existing confirmed-exit primitive.
          let grace: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            processClosed,
            new Promise<void>((done) => {
              grace = setTimeout(done, 500);
            }),
          ]);
          clearTimeout(grace);
        }
        // Leader close is not proof that an owned process group is empty.
        if (!closed || killGroup) {
          try {
            const stop = await stopProcessAndWait(proc, { group: killGroup });
            leaderExited ||= stop.exited;
            if (!stop.exited || (killGroup && stop.group !== 'empty'))
              stopUnconfirmed = {
                leaderExited: stop.exited,
                ...(killGroup && proc.pid ? { pgid: proc.pid } : {}),
                ...(stop.group ? { group: stop.group } : {}),
              };
          } catch {
            stopUnconfirmed = {
              leaderExited: closed,
              ...(killGroup ? { pgid: proc.pid, group: 'unknown' } : {}),
            };
          }
        }
        stopAttemptFinished = true;
        if (!stopUnconfirmed) giveBack();
        else {
          reconcileExit();
          if (!released) {
            survivorPoll = setInterval(reconcileExit, 1000);
            survivorPoll.unref();
          }
        }
        try {
          await settlement;
          await log.flush();
        } catch {
          error = 'Native steering persistence could not be confirmed';
        }
        try {
          release?.();
        } catch {
          error ??= 'Native steering port release failed';
        }
        error ??= terminalFailure;
        const classification = protocol.refusalClassification ?? protocol.failureClassification;
        resolve({
          success: !error && !stopUnconfirmed,
          backendSessionId: protocol.threadId ?? input.backendSessionId ?? null,
          responses,
          toolCalls,
          finalTextResponse,
          usage,
          ...(error ? { error } : {}),
          ...(classification ? { classification } : {}),
          ...(stopUnconfirmed
            ? { stopUnconfirmed, error: error ?? 'Codex process stop was not confirmed' }
            : {}),
        });
      }
      const onAbort = () => {
        void finish('Codex turn cancelled');
      };
      stopOwned = onAbort;
      const decoder = new StringDecoder('utf8');
      let remainder = '';
      proc.stdout.on('data', (data: Buffer) => {
        if (finishing) return;
        remainder += decoder.write(data);
        // Bound every frame and incomplete remainder, not an accumulated run.
        const lines = remainder.split('\n');
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
            void finish('Codex frame exceeded its bound');
            break;
          }
          if (!line.trim()) continue;
          try {
            protocol.receive(JSON.parse(line));
          } catch {
            void finish('Invalid Codex app-server stream');
            break;
          }
        }
        if (Buffer.byteLength(remainder) > 4 * 1024 * 1024)
          void finish('Codex frame exceeded its bound');
      });
      // Drain stderr without retaining or logging possible private provider text.
      proc.stderr.on('data', () => {});
      proc.stdout.on('error', () => {
        void finish('Codex app-server output failed');
      });
      proc.stderr.on('error', () => {
        void finish('Codex app-server diagnostics stream failed');
      });
      proc.stdin.on('error', () => {
        void finish('Codex app-server input failed');
      });
      proc.on('error', () => {
        void finish('Codex app-server process failed');
      });
      proc.on('close', (code, signal) => {
        if (code !== 0 || signal) terminalFailure ??= 'Codex app-server did not exit successfully';
        closed = true;
        closeProcess();
        reconcileExit();
        if (!finishing) {
          remainder += decoder.end();
          if (remainder.trim()) {
            try {
              protocol.receive(JSON.parse(remainder));
            } catch {
              /* incomplete frame */
            }
          }
          if (!finishing) void finish('Codex exited before its native turn completed');
        }
      });
      if (input.ceilingMs !== undefined)
        timeout = setTimeout(() => {
          void finish('Codex timeout: configured ceiling exceeded');
        }, input.ceilingMs);
      if (config.signal?.aborted) onAbort();
      else config.signal?.addEventListener('abort', onAbort, { once: true });
      // Tracking callbacks can fail too. The owned child's handlers and stop
      // path must already exist before a caller is told about its PID.
      try {
        if (proc.pid !== undefined)
          config.onSpawned?.({ pid: proc.pid, ...(killGroup ? { pgid: proc.pid } : {}) });
      } catch {
        void finish('Codex launch tracking failed');
      }
      if (!finishing)
        void protocol
          .start({
            backendSessionId: input.backendSessionId,
            text: input.message,
            cwd: config.workingDirectory,
            model: config.model,
            effort: config.effort,
            sandbox: config.sandboxBypass ? 'danger-full-access' : 'workspace-write',
          })
          .then(() => {
            if (finishing) return;
            binding.assertCurrent();
            mailbox = createNativeSessionSteering({
              turnEpoch: binding.turnEpoch,
              log,
              assertCurrent: binding.assertCurrent,
              dispatch: protocol.steer,
            });
            release = binding.bind(mailbox.submit);
          })
          .catch((error: unknown) => {
            if (finishing) return;
            const classification =
              error instanceof CodexRpcError ? error.classification : undefined;
            void finish(classification?.summary ?? 'Codex app-server initialization failed');
          });
    });
    return result;
  } finally {
    try {
      await log.close();
    } catch (error) {
      // Never discard the surviving-process fence just because the journal's
      // final close also failed. The caller must retain both facts.
      if (!result) throw error;
      result.success = false;
      result.error = 'Native steering journal close could not be confirmed';
    }
  }
}
