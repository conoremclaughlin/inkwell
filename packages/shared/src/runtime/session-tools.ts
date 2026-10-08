/** The parent's full local tool composition: policy, intent, dispatch and context. */
import {
  bareToolName,
  createLocalToolDispatcher,
  impossibleCallRefusal,
  type LocalToolDispatchDeps,
  type LocalToolDispatcher,
} from './tool-dispatch.js';
import {
  handleClientLocalTool,
  isClientLocalTool,
  type SignalSink,
  type ProviderContextMeasurement,
} from './context-tools.js';
import { SPAWN_AGENT_TOOL, COLLECT_AGENTS_TOOL, isCloneHandoffTool } from './spawn-agent.js';
import { compactForLedger } from './session-history.js';
import { runSessionToolBatch, type SessionToolBatchPorts } from './session-tool-batch.js';
import type { ToolPolicyState } from './tool-policy.js';
import type { LocalToolCall } from './agent-loop.js';
import type { InkToolCallResult } from './tool-result.js';
import type { SessionTurnPorts } from './session-turn.js';

export interface SessionToolsPorts {
  sessionId(): string | undefined;
  ledger: SessionToolBatchPorts['ledger'];
  log: SessionToolBatchPorts['log'];
  policy: Pick<ToolPolicyState, 'inspectInkTool' | 'canCallInkTool'>;
  signalState: SignalSink;
  mintInvocationId: SessionToolBatchPorts['mintInvocationId'];
  beginContextMutation: SessionToolBatchPorts['beginContextMutation'];
  takeImages: SessionToolBatchPorts['takeImages'];
  /** Session-owned image capture; it wraps the whole dispatcher, including MCP results. */
  capture(dispatch: LocalToolDispatcher): LocalToolDispatcher;
  dispatch: Pick<
    LocalToolDispatchDeps,
    | 'cwd'
    | 'loadCodingTools'
    | 'callPi'
    | 'callInk'
    | 'viewImage'
    | 'resolveCredentials'
    | 'toolParameters'
  >;
  spawnAgent(
    args: Record<string, unknown>,
    ctx: { signal?: AbortSignal }
  ): Promise<InkToolCallResult>;
  collectAgents(args: Record<string, unknown>): Promise<InkToolCallResult>;
  compact(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<InkToolCallResult>;
  measurement(): ProviderContextMeasurement | undefined;
  recordEviction(
    actor: 'sb',
    reason: string,
    removedTokens: number,
    refs: Parameters<SessionTurnPorts['recordEviction']>[3]
  ): void;
}

/** No alternate loop or permissive fallback: both hosts supply the same capabilities. */
export function createSessionTools(ports: SessionToolsPorts) {
  return async (
    calls: LocalToolCall[],
    turn: Pick<SessionToolBatchPorts, 'signal' | 'promptForApproval' | 'onResult'>
  ) =>
    runSessionToolBatch(calls, {
      ...turn,
      ledger: ports.ledger,
      log: ports.log,
      policy: ports.policy,
      sessionId: ports.sessionId(),
      mintInvocationId: ports.mintInvocationId,
      impossibleCallRefusal,
      beginContextMutation: ports.beginContextMutation,
      isHandoffTool: isCloneHandoffTool,
      takeImages: ports.takeImages,
      callTool: ports.capture(
        createLocalToolDispatcher({
          ...ports.dispatch,
          audience: 'parent',
          mayLookUpParameters: () => {
            const decision = ports.policy.inspectInkTool('describe_tool', ports.sessionId());
            return decision.allowed && !decision.wouldConsumeGrant;
          },
          isHardDenied: (tool) => {
            const decision = ports.policy.inspectInkTool(bareToolName(tool), ports.sessionId());
            return !decision.allowed && !decision.promptable;
          },
          head: (tool, args, ctx) => {
            if (bareToolName(tool) === SPAWN_AGENT_TOOL) return ports.spawnAgent(args, ctx);
            if (bareToolName(tool) === COLLECT_AGENTS_TOOL) return ports.collectAgents(args);
            if (bareToolName(tool) === 'compact_context') return ports.compact(args, ctx);
            if (!isClientLocalTool(tool)) return null;
            return handleClientLocalTool(tool, args, ports.ledger, ports.signalState, {
              providerUsage: ports.measurement,
              onEvict: (eviction) =>
                ports.recordEviction(
                  'sb',
                  compactForLedger(JSON.stringify(eviction.args ?? {}), 200),
                  eviction.tokensFreed,
                  eviction.refs
                ),
            });
          },
        })
      ),
    });
}
