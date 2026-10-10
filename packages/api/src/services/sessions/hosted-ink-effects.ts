/** Files/network/presentation adapter for the shared session; tool execution is an explicit host port. */
import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, isAbsolute } from 'path';
import { encodeContextToken } from '@inklabs/shared';
import {
  createSessionToolHost,
  createSkillInstructionHost,
  sessionCredentialsForProfile,
  requestHostedToolApproval,
  type CodingToolHostPorts,
} from '@inklabs/shared/node-host';
import {
  sanitizeArgsForApproval,
  ToolPolicyState,
  type ToolPolicySnapshot,
  type ToolPolicyScopeRef,
  type SessionPromptSkill,
} from '@inklabs/shared/runtime';
import { hostedCloneLog } from './hosted-ink-log';
import type { PrepareHostedInkEffects } from './hosted-ink-executor';
import type { HostedInkSessionInput } from './hosted-ink-session';

export interface HostedInkEffectHost {
  home: string;
  tempDir: string;
  inkFiles: string;
  /** No ambient machine default: the server chooses its policy store explicitly. */
  policyPath: string;
  mcpUrl: string;
  /** Must not run synchronous Pi work on the API event loop or inherit API secrets. */
  coding(
    input: HostedInkSessionInput,
    signal: AbortSignal,
    sessionEnv: (signal: AbortSignal) => Promise<Readonly<NodeJS.ProcessEnv>>
  ): Promise<{ ports: CodingToolHostPorts; close(): Promise<void> }>;
  credentials(
    input: HostedInkSessionInput,
    signal: AbortSignal
  ): Promise<Readonly<Record<string, string>>>;
  activeSkills(
    input: HostedInkSessionInput,
    signal: AbortSignal
  ): Promise<readonly SessionPromptSkill[]>;
  publish(sessionId: string, type: string, data: Record<string, unknown>): void;
}

async function readPolicy(path: string): Promise<ToolPolicySnapshot | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid hosted tool policy');
    return parsed as ToolPolicySnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Store operations serialize, not agent loops. Each grant merges with the latest file. */
export function createHostedInkEffects(host: HostedInkEffectHost): PrepareHostedInkEffects {
  for (const path of [host.home, host.tempDir, host.inkFiles, host.policyPath])
    if (!isAbsolute(path)) throw new Error('Hosted effect paths must be absolute');
  const policyWrites = new Map<string, Promise<void>>();
  async function persistGrant(path: string, tool: string, scope: ToolPolicyScopeRef) {
    const write = (policyWrites.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const latest = new ToolPolicyState('backend', { snapshot: await readPolicy(path) });
        latest.persistentGrant(tool, scope);
        const tmp = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        try {
          await writeFile(tmp, JSON.stringify(latest.snapshot(), null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
          await rename(tmp, path);
        } finally {
          await rm(tmp, { force: true });
        }
      });
    policyWrites.set(path, write);
    try {
      await write;
    } finally {
      if (policyWrites.get(path) === write) policyWrites.delete(path);
    }
  }
  return async (input, ports) => {
    const signal = ports.signal;
    signal.throwIfAborted();
    const path = input.options.toolPolicyPath ?? host.policyPath;
    if (!isAbsolute(path)) throw new Error('Hosted policy path must be absolute');
    const policy = new ToolPolicyState('backend', {
      snapshot: await readPolicy(path),
      context: { sbSlug: input.sbSlug, studioId: input.studioId },
    });
    const activeSkills = await host.activeSkills(input, signal);
    const credentials = await sessionCredentialsForProfile(
      input.options.requireProfile ?? input.options.profile,
      () => host.credentials(input, signal)
    );
    signal.throwIfAborted();
    const coding = await host.coding(input, signal, async (callSignal) => {
      callSignal.throwIfAborted();
      const env = await ports.provider.context!.host.sessionEnv({
        hardTimeoutMs: Math.max(1, ports.deadlineAt - Date.now()),
      });
      callSignal.throwIfAborted();
      return {
        ...env,
        INK_SERVER_URL: new URL(host.mcpUrl).origin,
        INK_SESSION_ID: input.sessionId,
        ...(input.studioId ? { INK_STUDIO_ID: input.studioId } : {}),
        SB_SLUG: input.sbSlug,
        AGENT_ID: input.sbSlug,
        INK_CONTEXT: encodeContextToken({
          sessionId: input.sessionId,
          studioId: input.studioId ?? 'main',
          sbSlug: input.sbSlug!,
          runtime: 'ink',
          cliAttached: false,
        }),
      };
    });
    let toolkit: ReturnType<typeof createSessionToolHost>;
    try {
      signal.throwIfAborted();
      toolkit = createSessionToolHost({
        cwd: input.workingDirectory,
        home: host.home,
        tempDir: host.tempDir,
        imageRoots: [input.workingDirectory, host.inkFiles],
        credentials,
        coding: coding.ports,
        logPath: ports.sessionLog.path,
      });
    } catch (error) {
      await coding.close();
      throw error;
    }
    const emit = (type: string, data: Record<string, unknown>) => {
      if (!signal.aborted) host.publish(input.sessionId, type, data);
    };
    type Ticket = {
      tool: string;
      reason: string;
      args: Record<string, unknown>;
      signal?: AbortSignal;
      policy?: ToolPolicyState;
      origin: { origin: 'parent' | 'clone'; cloneId?: string; cloneLabel?: string };
    };
    const approve = async (ticket: Ticket) => {
      const target = ticket.policy ?? policy;
      const tool = ticket.tool.replace(/^mcp__inkwell__/, '');
      const decision = target.inspectInkTool(tool, input.sessionId);
      if (decision.allowed && !decision.wouldConsumeGrant) return true;
      if (!decision.allowed && !decision.promptable) return false;
      const cancelled = ticket.signal ? AbortSignal.any([signal, ticket.signal]) : signal;
      cancelled.throwIfAborted();
      const providerHost = ports.provider.context!.host;
      const env = await providerHost.sessionEnv({
        hardTimeoutMs: Math.max(1, ports.deadlineAt - Date.now()),
      });
      cancelled.throwIfAborted();
      if (!env.INK_ACCESS_TOKEN) throw new Error('Approval has no session credential');
      const response = await requestHostedToolApproval(
        {
          serverUrl: new URL(host.mcpUrl).origin,
          headers: {
            Authorization: `Bearer ${env.INK_ACCESS_TOKEN}`,
            'x-ink-context': encodeContextToken({
              sessionId: input.sessionId,
              studioId: input.studioId ?? 'main',
              sbSlug: input.sbSlug!,
              runtime: 'ink',
              cliAttached: false,
            }),
          },
        },
        {
          tool,
          args: sanitizeArgsForApproval(tool, ticket.args),
          reason: ticket.reason,
          sessionId: input.sessionId,
          studioId: input.studioId,
          origin: ticket.origin,
          signal: cancelled,
          onCreated: (requestId) =>
            emit('approval_request', { requestId, tool, origin: ticket.origin }),
        }
      );
      cancelled.throwIfAborted();
      if (response.status !== 'granted') return false;
      if (['grant-agent', 'allow', 'grant-studio'].includes(response.action ?? '')) {
        const scope = response.action === 'grant-studio' ? 'studio' : 'agent';
        const id = scope === 'studio' ? target.getContext().studioId : target.getContext().sbSlug;
        if (id) {
          // A clone keeps its own non-persisting capability envelope, as in the CLI.
          if (target === policy) await persistGrant(path, tool, { scope, id });
          cancelled.throwIfAborted();
          target.persistentGrant(tool, { scope, id });
        } else target.grantToolForSession(input.sessionId, tool);
      } else if (response.action === 'grant-session')
        target.grantToolForSession(input.sessionId, tool);
      return true;
    };
    return {
      policy,
      toolHost: toolkit,
      activeSkills,
      manualSkills: createSkillInstructionHost(input.workingDirectory, host.home),
      // Terminal control receipts must survive Stop; they describe the old
      // generation, not new provider output or permission to run another turn.
      controlReceipt: (receipt) =>
        host.publish(input.sessionId, 'session_control_receipt', {
          ...receipt,
          turnEpoch: input.turnEpoch,
        }),
      mintId: randomUUID,
      // Launch profiles are per-run, not edits of a shared machine policy. Approved
      // persistent grants await their merged write above before returning true.
      flushPolicy: async () => {},
      close: async () => {
        try {
          await toolkit.close();
        } finally {
          await coding.close();
        }
      },
      cloneLog: (path) => hostedCloneLog(ports.sessionLog.path, path),
      approve: (tool, reason, args, signal) =>
        approve({ tool, reason, args, signal, origin: { origin: 'parent' } }),
      approveClone: approve,
      presentation: {
        ui: {
          printLine: (text) => emit('runtime_notice', { text }),
          printEvent: (text) => emit('runtime_notice', { text }),
          startWaiting: (label) => {
            emit('runtime_wait', { label });
            return () => emit('runtime_wait', { done: true });
          },
        },
        render: (lines) => {
          for (const line of lines)
            emit('text', { text: line.text, continuation: line.continuation, provisional: true });
        },
        progress: (event) => emit(typeof event.type === 'string' ? event.type : 'progress', event),
        toolStarted: (name) => emit('tool_call', { toolName: name, status: 'running' }),
        modelReported: (model, windowChanged) => emit('model', { model, windowChanged }),
        toolResult: (result) => emit('tool_call', { toolName: result.tool, status: result.status }),
        compacted: (result) =>
          emit(
            'compaction',
            typeof result === 'object' && result !== null ? { ...result } : { result }
          ),
        notice: (text) => emit('runtime_notice', { text }),
      },
    };
  };
}
