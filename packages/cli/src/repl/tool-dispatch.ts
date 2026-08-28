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

/**
 * A tool named for an MCP server this runtime does not host.
 *
 * The ink chat loop has no generic MCP client — it reaches exactly two places,
 * the Inkwell server and in-process coding tools. So `mcp__github__*` is not a
 * misconfiguration that a token or a config file could fix; there is nothing
 * here for it to connect to.
 *
 * Worth its own branch because the fallthrough's answer — posting the literal
 * name to Inkwell and relaying `-32602 tool not found` — is indistinguishable
 * from a typo, and the difference is what the reader should do next. Myra spent
 * two attempts across two days on `mcp__github__list_issues` before falling
 * back to searching Gmail, because nothing told her the capability was absent
 * rather than misspelled.
 */
const FOREIGN_MCP_NAMESPACE = /^mcp__([a-z0-9_-]+)__(.+)$/i;

function foreignNamespaceRefusal(tool: string): PcpToolCallResult | null {
  const match = FOREIGN_MCP_NAMESPACE.exec(tool);
  if (!match) return null;
  const [, server] = match;
  return {
    content: [
      {
        type: 'text',
        text:
          `${tool} is not available: this runtime hosts no "${server}" MCP server, ` +
          `so no configuration or credential will make it resolve.\n\n` +
          `Reachable from here: Inkwell tools (called bare, with no "mcp__" prefix) ` +
          `and in-process coding tools (read, edit, write, bash, grep, find, ls) ` +
          `scoped to the working directory.\n\n` +
          `Do not retry this as a bare name — dropping the prefix does not make a ` +
          `"${server}" tool into an Inkwell one, and the retry will fail the same way. ` +
          `A shell command via bash may cover it; otherwise it needs a human to add it.`,
      },
    ],
    isError: true,
  } as PcpToolCallResult;
}

/**
 * A coding tool named in the wrong case — `Bash` for `bash`, `Read` for `read`.
 *
 * The names a model reaches for under pressure are its priors, and the priors
 * here are Claude Code's capitalised ones. Myra called `Bash` seven times and
 * `Read` four; each fell through to the server, which hosts neither, and came
 * back "tool not found".
 *
 * That is the failure she described from the inside afterwards: three wrong
 * shapes — `Bash`, the prefixed name, a fenced block — all returned the same
 * not-found, so the repetitions read as *consistent evidence the tool is gone*
 * rather than as three different misspellings. An error that cannot distinguish
 * a wrong convention from an absent capability makes retrying actively harmful,
 * because each attempt confirms the wrong conclusion.
 *
 * Corrected rather than silently accepted, deliberately. Auto-routing `Bash`
 * would work and teach nothing, and it would hide exactly the convention drift
 * that made this diagnosable — the Aug 24 regime change was only visible
 * because the miscased calls were logged under the name actually emitted.
 */
export function miscasedPiToolCorrection(tool: string): PcpToolCallResult | null {
  const lower = tool.toLowerCase();
  if (lower === tool || !isPiTool(lower)) return null;
  return {
    content: [
      {
        type: 'text',
        text:
          `${tool} is not a tool here, but "${lower}" is — coding tools in this ` +
          `runtime are lowercase. Retry as "${lower}" with the same arguments.\n\n` +
          `The full set: read, edit, write, bash, grep, find, ls.`,
      },
    ],
    isError: true,
  } as PcpToolCallResult;
}

export function createLocalToolDispatcher(deps: LocalToolDispatchDeps): LocalToolDispatcher {
  return async (tool, args, ctx) => {
    // Normalize ONCE, before anything branches on the name.
    //
    // A text-protocol model names tools from memory, and a long-lived session
    // drifts toward its priors: after weeks on one native session Myra began
    // emitting `mcp__inkwell__bash` and `mcp__inkwell__signal_status` instead
    // of the bare names she had been taught. Every branch below used to test
    // the RAW name, so only the last one — the PCP fallthrough — stripped the
    // namespace. A namespaced coding tool or ledger tool therefore sailed past
    // its own handler and was posted to the server, which has no `bash` and no
    // `signal_status`, and came back `-32602 tool not found`.
    //
    // Read literally that error says the tool does not exist, so she concluded
    // she had no shell and stopped reaching for one — while holding a working,
    // unsandboxed `bash` she had already run 205 times. Normalizing at the one
    // chokepoint both hosts share means a future branch cannot reintroduce
    // this by testing the raw name.
    const name = bareToolName(tool);

    const handled = await deps.head?.(name, args, ctx);
    if (handled) return handled;

    if (isPiTool(name)) {
      // ctx.signal, not a captured variable: the executor hands it over per
      // call, and this is the only place either host reaches a Pi tool.
      return deps.callPi(name, args, deps.cwd, ctx.signal);
    }

    // After the head and Pi tools, so a host that DOES serve a namespaced name
    // still wins. `name` is already inkwell-stripped, so anything still
    // carrying an `mcp__<server>__` prefix names a server we do not host.
    const foreign = foreignNamespaceRefusal(name);
    if (foreign) return foreign;

    // Also after the head, so a host that genuinely serves a capitalised name
    // keeps it. Only reached once nothing else claimed the call.
    const miscased = miscasedPiToolCorrection(name);
    if (miscased) return miscased;

    return deps.callPcp(name, deps.resolveCredentials(args));
  };
}
