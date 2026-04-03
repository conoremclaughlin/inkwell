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
  /** Execute a PCP MCP tool call */
  callTool: (tool: string, args: Record<string, unknown>) => Promise<PcpToolCallResult>;
  /** Current session ID for session-scoped grants */
  sessionId?: string;
  /** Prompt callback for tools requiring approval — returns true if approved */
  promptForApproval: (tool: string, reason: string) => Promise<boolean>;
  /** Called after each tool call with the result */
  onResult?: (result: ToolCallResult) => void;
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
    return executeTool(call, callTool);
  }

  // 1. Check policy — strip MCP namespace prefix for policy lookup
  const policyToolName = call.tool.replace(/^mcp__inkwell__/, '');
  const decision = policy.canCallPcpTool(policyToolName, sessionId);

  if (decision.allowed) {
    // Allowed — execute immediately
    return executeTool(call, callTool);
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

  // Promptable — pause for approval
  const approved = await promptForApproval(call.tool, decision.reason);
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
  const result = await executeTool(call, callTool);
  result.status = result.status === 'executed' ? 'approved' : result.status;
  return result;
}

async function executeTool(
  call: LocalToolCall,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<PcpToolCallResult>
): Promise<ToolCallResult> {
  try {
    const result = await callTool(call.tool, call.args);
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
