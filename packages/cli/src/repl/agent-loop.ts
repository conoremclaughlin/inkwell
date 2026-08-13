/**
 * Agent Loop
 *
 * The ink runtime's turn primitive: drive a backend, extract the tool calls it
 * emitted as text, execute them through ink's policy pipeline, feed the results
 * back, repeat until the agent is done.
 *
 * This module owns the *pure* pieces of that loop — tool-call extraction, the
 * stop predicate, display stripping — so they can be tested directly and reused
 * by callers other than the REPL (shadow clones; see
 * `ink://specs/ink-runtime-shadow-clones`). The stateful loop body still lives
 * in `commands/chat.ts` and moves here next.
 *
 * Tool calls travel as TEXT, not native tool-use blocks: backends like the
 * claude CLI expose their own tools, not ink's, so the runtime asks the model to
 * emit fenced ```ink-tool blocks and parses them back out.
 */

export interface LocalToolCall {
  tool: string;
  args: Record<string, unknown>;
  raw: string;
  /** Parsed from the deprecated <tool_call> XML variant, not an ink-tool fence. */
  variantFormat?: boolean;
}

/** One executed (or refused) tool call, as the loop accumulates them. */
export interface ToolResultRecord {
  tool: string;
  result: unknown;
  status: string;
  args?: unknown;
}

/**
 * Why a turn's tool loop stopped. Today the loop's exit is implicit; naming it
 * lets a caller distinguish "the agent finished" from "we ran out of budget",
 * which a shadow clone must report back to its parent.
 */
export type AgentLoopStopReason =
  | 'no-tools'
  | 'terminal-signal'
  | 'iteration-cap'
  | 'backend-failure'
  | 'aborted';

/**
 * Default per-turn iteration budget.
 *
 * This is not as tight as it looks: ONE iteration is a full backend turn, which
 * for a CLI backend runs its own agentic loop internally and can take ~20
 * minutes. Five iterations is a large budget, not a small one — it is a guard
 * against runaway re-invocation, not a work limit.
 */
export const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 5;

/** Max tool calls honored per iteration, in the model's emission order. */
export const MAX_TOOL_CALLS_PER_ITERATION = 5;

export function extractLocalToolCalls(responseText: string): LocalToolCall[] {
  const indexed: Array<{ index: number; call: LocalToolCall }> = [];

  for (const match of responseText.matchAll(/```ink-tool\s*([\s\S]*?)```/gi)) {
    const payload = (match[1] || '').trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const tool = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
      if (!tool) continue;
      const args =
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      indexed.push({ index: match.index ?? 0, call: { tool, args, raw: match[0] || '' } });
    } catch {
      continue;
    }
  }

  // Variant tolerance: a long-lived session whose history predates
  // wholly-in-ink can drift into emitting tool calls as
  // `<tool_call>{"name":"mcp__inkwell__X","arguments":{...}}</tool_call>`
  // XML text — imitating its own pre-#462 native-MCP history (Myra,
  // 2026-08-10: the calls silently never ran, raw XML leaked to Telegram
  // via the fallback router, and text-form signal_status never halted the
  // continuation loop). Parse and execute the variant so the turn WORKS;
  // the continuation prompt separately steers the model back to the fence.
  for (const match of responseText.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const payload = (match[1] || '').trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!rawName) continue;
      // Strip the MCP namespace here (not just at execution) so client-local
      // dispatch and terminal-signal detection see the bare tool name.
      const tool = rawName.replace(/^mcp__inkwell__/, '');
      const args =
        parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
          ? (parsed.arguments as Record<string, unknown>)
          : {};
      indexed.push({
        index: match.index ?? 0,
        call: { tool, args, raw: match[0] || '', variantFormat: true },
      });
    } catch {
      continue;
    }
  }

  // Preserve the model's emission order across both formats.
  indexed.sort((a, b) => a.index - b.index);
  return indexed.map((entry) => entry.call);
}

export function stripLocalToolBlocks(responseText: string): string {
  return responseText
    .replace(/```ink-tool[\s\S]*?```/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

/**
 * True when a signal_status tool result reports a TERMINAL status
 * (completed or blocked) — the agent explicitly ending its turn.
 *
 * The local-tool loop re-invokes the backend as long as any tool executed, and
 * signal_status counts as an executed tool. Without treating a terminal signal
 * as a stop condition, a single turn keeps re-invoking the backend up to the
 * iteration cap; the agent, re-prompted to "continue", just re-signals
 * completion each round — the multiplied signal_status calls and duplicate
 * backend/Claude sessions seen per heartbeat. 'continuing' is NOT terminal: the
 * agent is asking for another round, so the loop should proceed.
 */
export function isTerminalSignalToolResult(result: unknown): boolean {
  const text = (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  if (!text) return false;
  try {
    const status = (JSON.parse(text)?.signal as { status?: string } | undefined)?.status;
    return status === 'completed' || status === 'blocked';
  } catch {
    return false;
  }
}

/**
 * The loop's stop decision, for one iteration's results.
 *
 * Order matters: a terminal signal wins even when real work ran alongside it.
 * The 3 PM heartbeat shape — calendar lookup + send_response + remember +
 * signal_status(completed) in one iteration — has executed tools AND a
 * completion signal; checking `hasExecutedTools` first would keep the loop
 * alive and re-invoke the backend, which is the 4x-signal_status /
 * 5-backend-sessions multiplication this predicate exists to prevent.
 *
 * Returns the reason to stop, or null to continue.
 */
export function toolLoopStopReason(
  iterationResults: ReadonlyArray<Pick<ToolResultRecord, 'tool' | 'status' | 'result'>>,
  iteration: number,
  maxIterations: number = DEFAULT_MAX_TOOL_LOOP_ITERATIONS
): AgentLoopStopReason | null {
  const signaledDone = iterationResults.some(
    (r) => r.tool === 'signal_status' && isTerminalSignalToolResult(r.result)
  );
  if (signaledDone) return 'terminal-signal';

  const hasExecutedTools = iterationResults.some(
    (r) => r.status === 'executed' || r.status === 'approved'
  );
  if (!hasExecutedTools) return 'no-tools';

  if (iteration >= maxIterations) return 'iteration-cap';

  return null;
}
