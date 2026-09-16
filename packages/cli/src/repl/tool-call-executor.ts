/**
 * Tool Call Executor
 *
 * Executes local tool calls with policy-aware approval pausing.
 * Extracted from the inline loop in chat.ts to enable:
 * - Proper approval prompts for `promptable` tools (the missing path)
 * - Testability in isolation
 * - Future extension for remote approval
 */

import type { ToolPolicyState } from './tool-policy.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';
import { isClientLocalTool } from './context-tools.js';
import { impossibleCallRefusal } from './tool-dispatch.js';

export interface LocalToolCall {
  tool: string;
  args: Record<string, unknown>;
  raw: string;
}

export interface ToolCallResult {
  tool: string;
  args: Record<string, unknown>;
  status: 'executed' | 'blocked' | 'approved' | 'denied' | 'error';
  result?: PcpToolCallResult;
  reason?: string;
  error?: string;
}

export interface ToolCallExecutorDeps {
  /** Policy engine for permission decisions */
  policy: ToolPolicyState;
  /**
   * Execute a PCP MCP tool call.
   *
   * The cancellation signal arrives as an ARGUMENT rather than being captured
   * by the closure. That is deliberate: every dispatcher that reaches a
   * long-running tool needs it, and a closure is a place to forget it — which
   * is exactly what happened when `callPiTool` was called without one, leaving
   * a cancelled clone's `bash` running after its slot had been freed.
   */
  callTool: (
    tool: string,
    args: Record<string, unknown>,
    ctx: { signal?: AbortSignal }
  ) => Promise<PcpToolCallResult>;
  /** Current session ID for session-scoped grants */
  sessionId?: string;
  /** Prompt callback for tools requiring approval — returns true if approved */
  promptForApproval: (
    tool: string,
    reason: string,
    args?: Record<string, unknown>
  ) => Promise<boolean>;
  /** Called after each tool call with the result */
  onResult?: (result: ToolCallResult) => void;
  /**
   * Cancels the batch.
   *
   * Checked BETWEEN calls, not just at the start. A batch can sit for minutes
   * inside a single approval prompt, and cancelling during the first call must
   * not leave the rest of the batch to run — which is exactly what happened
   * when only the caller checked, after the whole batch had returned.
   */
  signal?: AbortSignal;
}

/**
 * Execute a list of local tool calls sequentially with policy checks.
 *
 * For each call:
 * 1. Check policy via canCallPcpTool()
 * 2. If allowed → execute immediately
 * 3. If promptable → pause and call promptForApproval()
 *    - If approved → re-check policy (grant was applied) and execute
 *    - If denied → report as denied
 * 4. If blocked (not promptable) → report as blocked
 */
export async function executeToolCalls(
  calls: LocalToolCall[],
  deps: ToolCallExecutorDeps
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  for (const call of calls) {
    if (deps.signal?.aborted) {
      // Report the remainder rather than dropping it silently: the agent asked
      // for these, and "cancelled" is a different answer from "never mentioned".
      const cancelled: ToolCallResult = {
        tool: call.tool,
        args: call.args,
        status: 'denied',
        reason: 'Cancelled before this call ran',
      };
      results.push(cancelled);
      deps.onResult?.(cancelled);
      continue;
    }
    const result = await executeOneToolCall(call, deps);
    results.push(result);
    deps.onResult?.(result);
  }

  return results;
}

async function executeOneToolCall(
  call: LocalToolCall,
  deps: ToolCallExecutorDeps
): Promise<ToolCallResult> {
  const { policy, callTool, sessionId, promptForApproval } = deps;

  // Client-local tools (context management + signaling) always bypass policy.
  // They operate on the in-memory ledger — no external side effects, no PCP
  // server calls. Eviction removes from working memory but the JSONL transcript
  // retains the full immutable log. The SB must have full control over its own
  // context window without permission gates.
  if (isClientLocalTool(call.tool)) {
    return executeTool(call, callTool, deps.signal);
  }

  // A structurally impossible call — a foreign MCP namespace, or a coding tool
  // named in the wrong case — is answered before policy,
  // because there is nothing here to authorize. Nothing runs and nothing is
  // reached; the only output is a message naming the right spelling.
  //
  // Behind policy it was worse than useless: `safe` prompts the human and
  // spends a grant to approve a call that was never going to execute, and
  // `minimal` blocks it outright — so the one profile most likely to be
  // running unattended is the one where the correction never arrives and the
  // caller keeps reading "blocked" as "the tool is gone".

  const impossible = impossibleCallRefusal(call.tool);
  if (impossible) {
    return { tool: call.tool, args: call.args, status: 'executed', result: impossible };
  }

  // 1. Check policy — strip MCP namespace prefix for policy lookup
  const policyToolName = call.tool.replace(/^mcp__inkwell__/, '');
  const decision = policy.canCallPcpTool(policyToolName, sessionId);

  if (decision.allowed) {
    // Allowed — execute immediately
    return executeTool(call, callTool, deps.signal);
  }

  if (!decision.promptable) {
    // Blocked — not promptable, skip
    return {
      tool: call.tool,
      args: call.args,
      status: 'blocked',
      reason: decision.reason,
    };
  }

  // Promptable — pause for approval (pass args so the notification shows what's being approved)
  const approved = await promptForApproval(call.tool, decision.reason, call.args);
  if (deps.signal?.aborted) {
    // The wait ended because the turn was cancelled. Whatever the channel
    // returned, acting on it now would run work the user just stopped.
    return {
      tool: call.tool,
      args: call.args,
      status: 'denied',
      reason: 'Cancelled while waiting for approval',
    };
  }
  if (!approved) {
    return {
      tool: call.tool,
      args: call.args,
      status: 'denied',
      reason: 'User denied tool call',
    };
  }

  // Re-check policy after approval (the grant was applied by the prompt handler)
  // Use the stripped name — same as the initial policy check above
  const postApprovalDecision = policy.canCallPcpTool(policyToolName, sessionId);
  if (!postApprovalDecision.allowed) {
    // Edge case: approval was granted but policy still blocks (e.g., deny overrides grant)
    return {
      tool: call.tool,
      args: call.args,
      status: 'blocked',
      reason: postApprovalDecision.reason,
    };
  }

  // Execute after approval
  const result = await executeTool(call, callTool, deps.signal);
  result.status = result.status === 'executed' ? 'approved' : result.status;
  return result;
}

async function executeTool(
  call: LocalToolCall,
  callTool: (
    tool: string,
    args: Record<string, unknown>,
    ctx: { signal?: AbortSignal }
  ) => Promise<PcpToolCallResult>,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  try {
    const result = await callTool(call.tool, call.args, { signal });
    return {
      tool: call.tool,
      args: call.args,
      status: 'executed',
      result,
    };
  } catch (err) {
    return {
      tool: call.tool,
      args: call.args,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
