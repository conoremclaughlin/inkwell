import type { ToolCallExecutorPorts } from './tool-call-executor.js';

/**
 * Commit through the session's existing ordered log. Await queued
 * writes, not just the reserved eid. No fsync, transaction or replay claim.
 * Receives unresolved model args; credential expansion belongs to dispatch.
 * CLI parent and clone use this today. Backend-owned tools, manual /mcp call
 * and host auto-forward do not go through this executor/barrier.
 */
export function createToolIntentCommitter(log: {
  append(entry: Record<string, unknown>): number;
  flush(): Promise<void>;
}): ToolCallExecutorPorts['commitIntent'] {
  return async (call, invocationId) => {
    log.append({ type: 'tool_intent', invocationId, tool: call.tool, args: call.args });
    await log.flush();
  };
}
