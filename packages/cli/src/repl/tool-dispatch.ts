/**
 * Local Tool Dispatch
 *
 * Where a local tool call actually goes: in-process Pi coding tools, or the PCP
 * server.
 *
 * This exists as a factory rather than two inline closures because the two
 * hosts — the REPL turn and a shadow clone — differ only in their *heads* (what
 * each refuses, and which ledger client-local tools operate on) and share their
 * *tail* exactly. Twice now the tail drifted between them: `callPiTool` was
 * called without a cancellation signal in both, so cancelling mid-`bash` freed
 * the clone's slot while the command kept running.
 *
 * The signal being *available* to a closure is not enough — a closure is a
 * place to forget it, and TypeScript will not complain about an ignored
 * parameter. Making the tail one function that both hosts construct means
 * forwarding is not a thing either host can omit, and means a test can drive
 * the same dispatcher production does.
 */

import type { PcpToolCallResult } from '../lib/pcp-client.js';
import { isPiTool } from './pi-tools.js';

export interface ToolDispatchContext {
  /** Cancels an in-flight tool. Reaches the tool itself, not just the wait. */
  signal?: AbortSignal;
}

export type LocalToolDispatcher = (
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext
) => Promise<PcpToolCallResult>;

export interface LocalToolDispatchDeps {
  /** Working directory Pi tools are scoped to. */
  cwd: string;
  /** Run an in-process Pi coding tool. */
  callPi: (
    tool: string,
    args: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal
  ) => Promise<PcpToolCallResult>;
  /** Call a tool on the PCP server. */
  callPcp: (tool: string, args: Record<string, unknown>) => Promise<PcpToolCallResult>;
  /**
   * Resolve `$VAR` / `${VAR}` references in args.
   *
   * The model emits references; values are injected here at the execution layer
   * so credentials never enter transcripts or context.
   */
  resolveCredentials: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Host-specific handling, tried first.
   *
   * Return a result to stop here (a refusal, a client-local tool, a fan-out);
   * return null to fall through to the shared tail.
   */
  head?: (
    tool: string,
    args: Record<string, unknown>,
    ctx: ToolDispatchContext
  ) => Promise<PcpToolCallResult | null> | PcpToolCallResult | null;
}

/** Strip the MCP namespace the model may emit; PcpClient wants bare names. */
export function bareToolName(tool: string): string {
  return tool.replace(/^mcp__inkwell__/, '');
}

export function createLocalToolDispatcher(deps: LocalToolDispatchDeps): LocalToolDispatcher {
  return async (tool, args, ctx) => {
    const handled = await deps.head?.(tool, args, ctx);
    if (handled) return handled;

    if (isPiTool(tool)) {
      // ctx.signal, not a captured variable: the executor hands it over per
      // call, and this is the only place either host reaches a Pi tool.
      return deps.callPi(tool, args, deps.cwd, ctx.signal);
    }

    return deps.callPcp(bareToolName(tool), deps.resolveCredentials(args));
  };
}
