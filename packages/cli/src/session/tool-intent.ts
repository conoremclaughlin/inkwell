import type { ToolCallExecutorDeps } from '../repl/tool-call-executor.js';
import type { SessionLog } from './session-log.js';

/**
 * CLI implementation of the executor's pre-dispatch barrier. Both parent and
 * clone use their own existing log; no second journal or process-global state.
 * Intents are bookkeeping, not observer projection or model input. An append
 * ID alone is not commitment for an asynchronous sink: always await flush.
 *
 * The current CLI still uses its synchronous sink (no power-loss/fsync claim).
 * This does not cover backend-owned tools, manual /mcp call or host auto-forward.
 */
export function toolIntentCommitter(log: SessionLog): ToolCallExecutorDeps['commitIntent'] {
  return async (call, invocationId) => {
    log.append({ type: 'tool_intent', invocationId, tool: call.tool, args: call.args });
    await log.flush();
  };
}
