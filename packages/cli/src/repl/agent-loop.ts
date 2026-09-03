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
  /**
   * Calls were made and every one was refused — blocked by policy or denied by
   * the user. Distinct from `no-tools` (the agent stopped asking) because for a
   * clone the difference is everything: one is a finished report, the other is
   * work that never happened behind a confident-sounding preamble.
   */
  | 'all-refused'
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

/**
 * What the loop needs from its host.
 *
 * The split is deliberate: the LOOP sequences, the HOST authorizes. Nothing here
 * exposes `ToolPolicyState`, because a shadow clone must run under a narrowed,
 * immutable policy snapshot rather than the parent's live one — `canCallPcpTool`
 * consumes one-use grants as a side effect (tool-policy.ts), so concurrent
 * clones sharing a policy object would consume the parent's grants
 * nondeterministically. A clone supplies its own `tools.execute` closure over
 * its own snapshot and the loop is none the wiser.
 */
export interface AgentLoopPorts {
  ui: {
    printLine(text: string): void;
    printEvent(text: string): void;
    /** Begin a waiting indicator; returns the stop function. */
    startWaiting(label?: string): () => void;
  };
  tools: {
    /**
     * Execute one iteration's calls and report what happened. Policy, approvals,
     * and credential resolution are the host's business.
     */
    execute(
      calls: LocalToolCall[],
      ctx: { iteration: number; signal?: AbortSignal }
    ): Promise<ToolResultRecord[]>;
    /**
     * Vet an iteration's FULL extracted call list before anything runs.
     *
     * Runs pre-truncation on purpose: a rule like "spawn_agent must be alone"
     * checked after `.slice()` could be evaded by a spawn in sixth position.
     * Returning a refusal rejects the iteration whole — no call runs — and the
     * reason is fed back so the model can correct rather than guess.
     *
     * Omit to accept every iteration and simply truncate.
     */
    screen?(allCalls: LocalToolCall[]): { calls: LocalToolCall[] } | { rejected: string };
  };
  backend: {
    /**
     * Run ONE backend turn and return its raw outcome.
     *
     * The host owns everything specialized about a spawn: provider-session
     * seeding and reuse, recovery when a resumed session has vanished, media
     * delivery flags, passthrough args, SIGINT and abort-handler wiring. The
     * loop only decides *what to say next* and *whether to say it again*.
     *
     * `body` is the raw continuation text when `isContinuation` is true; the
     * host decides whether it needs wrapping in a full prompt envelope, because
     * only the host knows whether the provider session is being reused (in which
     * case the model already holds the history and wants the delta alone).
     */
    runTurn(
      body: string,
      ctx: { iteration: number; isContinuation: boolean; signal?: AbortSignal }
    ): Promise<BackendTurnOutcome>;
  };
  /** Parent-only observability (Ctrl+T inspector). Clones omit this entirely. */
  observe?: {
    recordToolCall(call: ToolResultRecord): void;
  };
}

/** Raw result of one backend turn, as the host reports it back to the loop. */
export interface BackendTurnOutcome {
  success: boolean;
  /** Parsed assistant text when streaming; absent for stateless/raw backends. */
  responseText?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * Resolve a turn's display text.
 *
 * In streaming mode `responseText` is the parsed assistant text and `stdout` is
 * the raw NDJSON event stream, so stdout must never be used as the reply there.
 * A turn that produced nothing at all still needs *something* to put in the
 * ledger, hence the placeholder.
 */
export function resolveResponseText(outcome: BackendTurnOutcome): string {
  let text = (outcome.responseText ?? outcome.stdout).trim();
  if (!text && outcome.stderr.trim()) text = outcome.stderr.trim();
  return text || '(no output)';
}

/**
 * Build the continuation body fed back to the backend after tools ran.
 *
 * When the model used the deprecated <tool_call> XML variant its calls were
 * executed anyway (see extractLocalToolCalls), but the format is corrected HERE,
 * while the results prove the runtime heard it — so the drift does not reinforce.
 */
export function buildContinuationBody(
  results: ReadonlyArray<ToolResultRecord>,
  calls: ReadonlyArray<LocalToolCall>,
  dropped: ReadonlyArray<LocalToolCall> = []
): string {
  const toolResultsSummary = results
    .map((r) => {
      const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return `Tool ${r.tool} (${r.status}): ${resultStr}`;
    })
    .join('\n\n');

  const formatCorrection = calls.some((c) => c.variantFormat)
    ? '\n\nFORMAT NOTE: your tool calls used <tool_call> XML — the ink runtime executed them this time, but the ONLY supported format is a fenced block:\n```ink-tool\n{"tool":"<name>","args":{...}}\n```\nUse ink-tool fences (bare tool names, no mcp__inkwell__ prefix) from now on.'
    : '';

  // Nothing ran. Without saying so, a model reads the results block as ordinary
  // output and either retries the same refused call or writes its answer as if
  // the work had happened.
  //
  // But WHY nothing ran decides what to say next, and the two answers are
  // opposites. A refusal is settled: someone denied it or wrote the rule, and
  // retrying re-asks a question already answered. A failure is not settled at
  // all — a bad argument, a transient upstream — and correcting it and trying
  // again is exactly right. Telling a model "every one was refused, do not
  // retry them" when a validation error named the offending field talks it out
  // of the one move that would work.
  const nothingRan = results.length > 0 && !results.some((r) => RAN_STATUSES.has(r.status));
  const refusalNote = !nothingRan
    ? ''
    : hasUnseenFailure(results)
      ? '\n\nNOTE: none of those calls ran, and at least one FAILED rather than being refused — the error text above says why. A failure is not a refusal: if it names a bad argument or a transient condition, fix it and try again. Do not report the work as done, and do not describe a failure as a refusal.'
      : '\n\nNOTE: none of those calls ran — every one was refused. Do not retry them. Work with the tools you do have, and if the task cannot be completed without a refused tool, say so plainly and stop.';

  // A capped call is indistinguishable from a call never made unless we say so.
  //
  // MAX_TOOL_CALLS_PER_ITERATION silently discarded everything past the fifth,
  // in emission order, and the results block that came back listed only the
  // survivors — with no count, no gap, nothing to compare against. A model has
  // no way to notice: the block it reads is well-formed and internally
  // consistent, it simply describes less work than was asked for.
  //
  // Myra emitted 8 update_memory calls; 5 ran. The 3 that vanished were the
  // ones downgrading critical-salience memories asserting a security compromise
  // that had not happened, and she only caught it because she read back rather
  // than trusting the turn. Had she trusted it she would have reported all
  // eight done and left a false compromise claim at critical salience for a
  // future session to recall as fact. Silent drops land behind the work you
  // already believe you finished, which is precisely where nobody looks.
  //
  // Naming them matters as much as counting them: "3 were dropped" invites a
  // guess about which, and a model that guesses wrong re-runs a write that
  // already succeeded.
  const droppedNote =
    dropped.length > 0
      ? `\n\nNOTE: you emitted ${results.length + dropped.length} tool calls and only ${results.length} ran. ` +
        `These were NOT executed and had no effect: ${dropped.map((c) => c.tool).join(', ')}. ` +
        `At most ${MAX_TOOL_CALLS_PER_ITERATION} calls run per iteration, in the order you emit them. ` +
        `Re-emit the ones you still need — they did not happen. Do not report them as done.`
      : '';

  return `[Tool results from previous turn]\n${toolResultsSummary}${formatCorrection}${refusalNote}${droppedNote}\n\nContinue your response based on these tool results. If you need more tools, emit ink-tool blocks. Otherwise, provide your final answer.`;
}

/**
 * Build the FINAL relay body: the loop is ending (iteration cap or an
 * all-refused iteration), but this iteration's results never reached the
 * model. Dropping them is a silent failure — a send_response that errored on
 * the capped iteration reads to the agent as delivered, and it exits
 * confidently wrong (the Aug 13 Telegram audio drop; PR #491). The relay's
 * output is final: its ink-tool blocks are NOT executed.
 */
export function buildFinalRelayBody(
  results: ReadonlyArray<ToolResultRecord>,
  dropped: ReadonlyArray<LocalToolCall> = []
): string {
  const toolResultsSummary = results
    .map((r) => {
      const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return `Tool ${r.tool} (${r.status}): ${resultStr}`;
    })
    .join('\n\n');
  // Undelivered calls have to be named here too. This body ends the turn, so a
  // call the cap discarded on the final iteration will never get another
  // chance — and an agent that is not told exits reporting work it never did.
  const droppedNote =
    dropped.length > 0
      ? `\n\nNOT EXECUTED — these calls were emitted but never ran, and the loop has now ended: ${dropped
          .map((c) => c.tool)
          .join(', ')}. They had no effect. Say so rather than reporting them as done.`
      : '';
  return (
    `[Tool results from previous turn — FINAL]\n${toolResultsSummary}${droppedNote}\n\n` +
    'The tool loop has ended; no further tool calls will be executed this turn. ' +
    'Review these results and provide your final answer. If a call above failed, ' +
    'say so plainly instead of reporting the work as done.'
  );
}

export interface AgentLoopInput {
  /** The opening prompt, already enveloped by the host. */
  prompt: string;
  /** Local tool routing off (`backend`) means the loop never extracts calls. */
  toolRouting: 'backend' | 'local';
  maxIterations?: number;
  signal?: AbortSignal;
  /**
   * Tell the agent when every call in an iteration was refused, and let it try
   * again, instead of ending the turn.
   *
   * Off for the REPL: a human is watching the scrollback, sees the refusal, and
   * can redirect — re-prompting there would just nag someone who already said
   * no. On for a shadow clone, where nobody is watching: a clone that silently
   * gives up hands its parent a confident preamble in place of the work, which
   * is exactly the failure the live smoke test surfaced.
   */
  continueOnBlocked?: boolean;
}

/**
 * Drive a backend to completion: run a turn, execute whatever tools it asked
 * for, feed the results back, repeat until it stops asking.
 *
 * This is the whole of what a shadow clone needs and the whole of what the REPL
 * turn shares with one. Everything specialized — spawn configuration, provider
 * session lifecycle, approval policy, TUI — lives behind the ports.
 */
export async function runAgentLoop(
  input: AgentLoopInput,
  ports: AgentLoopPorts
): Promise<AgentLoopResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_TOOL_LOOP_ITERATIONS;
  const allToolResults: ToolResultRecord[] = [];

  let iteration = 0;

  // Fail fast. A turn cancelled before it started must not spend a backend
  // invocation proving it — the opening spawn is the single most expensive
  // thing the loop does.
  if (input.signal?.aborted) {
    return {
      responseText: '',
      assistantDisplayText: '',
      toolResults: [],
      iterations: 0,
      success: false,
      stopReason: 'aborted',
    };
  }

  let outcome = await ports.backend.runTurn(input.prompt, {
    iteration,
    isContinuation: false,
    signal: input.signal,
  });

  let responseText = resolveResponseText(outcome);
  let calls: LocalToolCall[] = [];
  let stopReason: AgentLoopStopReason = 'no-tools';
  // Set only where an EXECUTED iteration is itself what reaches the cap.
  // Tracking "the last results seen" as ambient state relays the wrong thing:
  // a screen rejection at the cap would replay the previous iteration's
  // already-seen results and omit the refusal that actually ended the loop.
  let relayResults: ToolResultRecord[] = [];
  let lastDropped: LocalToolCall[] = [];

  for (;;) {
    responseText = resolveResponseText(outcome);

    const extracted =
      input.toolRouting === 'local' ? extractLocalToolCalls(responseText) : ([] as LocalToolCall[]);

    // Screening sees every call the model emitted, before the per-iteration cap
    // discards any — a rule about what may accompany what cannot be enforced on
    // a truncated list.
    const screened = ports.tools.screen
      ? ports.tools.screen(extracted)
      : { calls: extracted.slice(0, MAX_TOOL_CALLS_PER_ITERATION) };

    if ('rejected' in screened) {
      // Refused whole. Tell the model why and let it try again; the iteration
      // still counts, so a model that keeps re-emitting the same bad shape runs
      // out of budget rather than spinning.
      iteration++;
      const record: ToolResultRecord = {
        tool: 'iteration',
        result: screened.rejected,
        status: 'rejected',
      };
      allToolResults.push(record);
      ports.ui.printEvent(`  ⋯ iteration refused — ${screened.rejected}`);

      if (iteration >= maxIterations) {
        stopReason = 'iteration-cap';
        ports.ui.printLine(`(tool loop limit reached — ${maxIterations} iterations)`);
        break;
      }

      if (input.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }

      const stopWaitingAfterRejection = ports.ui.startWaiting();
      try {
        outcome = await ports.backend.runTurn(buildContinuationBody([record], extracted), {
          iteration,
          isContinuation: true,
          signal: input.signal,
        });
      } finally {
        stopWaitingAfterRejection();
      }
      if (!outcome.success) {
        stopReason = 'backend-failure';
        break;
      }
      continue;
    }

    calls = screened.calls;

    // Whatever the model emitted that is not going to run — whether the default
    // cap discarded it or a host `screen` did. Computed by identity rather than
    // by count so the note can NAME the calls, and so it stays honest if a
    // screen reorders rather than truncates.
    const dropped = extracted.filter((c) => !calls.includes(c));
    // Mirrored outward so the FINAL relay can carry it too: a turn that ends at
    // the iteration cap with calls still undelivered would otherwise exit
    // silently, which is the same swallow one level up.
    lastDropped = dropped;
    if (dropped.length > 0) {
      ports.ui.printEvent(
        `  ⋯ ${dropped.length} of ${extracted.length} tool calls not run (cap ${MAX_TOOL_CALLS_PER_ITERATION}/iteration): ${dropped.map((c) => c.tool).join(', ')}`
      );
    }

    if (calls.length === 0) {
      stopReason = 'no-tools';
      break;
    }

    const results = await ports.tools.execute(calls, { iteration, signal: input.signal });
    allToolResults.push(...results);
    for (const r of results) ports.observe?.recordToolCall(r);

    iteration++;

    // An abort observed here is authoritative, and checking for it is not
    // optional bookkeeping. A cancelled approval comes back as a DENIAL, which
    // reads as `all-refused` — and with `continueOnBlocked` that starts another
    // backend turn, so cancelling a clone would spawn the very work it was
    // meant to stop, then report `no-tools` success.
    if (input.signal?.aborted) {
      stopReason = 'aborted';
      break;
    }

    const reason = toolLoopStopReason(results, iteration, maxIterations);
    // Everything was refused. Telling the agent so — once, and only where nobody
    // is watching the scrollback for it — is the difference between a clone that
    // routes around its envelope and one that hands back a preamble.
    const retryAfterRefusal =
      reason === 'all-refused' && input.continueOnBlocked === true && iteration < maxIterations;
    if (reason && !retryAfterRefusal) {
      stopReason = reason;
      if (reason === 'iteration-cap') {
        relayResults = results;
        ports.ui.printLine(`(tool loop limit reached — ${maxIterations} iterations)`);
      } else if (hasUnseenFailure(results)) {
        // A call that THREW is not a refusal, and nobody watched it happen.
        //
        // Deliberately keyed on the RESULTS, not on which stop reason produced
        // them. Two reasons reach here today and both used to swallow:
        //
        //   all-refused    — a lone failing call. A denial or block was
        //                    witnessed (the human clicked no, or wrote the
        //                    rule), so ending quietly is right; an `error` was
        //                    witnessed by nobody. Which one you got depended on
        //                    turn COMPOSITION, not on the call: the same
        //                    create_reminder with the same invalid `runAt`
        //                    reported a precise -32602 alongside a success and
        //                    returned nothing at all when alone.
        //
        //   terminal-signal — the heartbeat shape, and the one that matters
        //                    most. `send_response: error` +
        //                    `signal_status(completed): executed` stopped as
        //                    terminal, relayed nothing, and the agent exited
        //                    believing it had delivered. That is the Aug 13
        //                    Telegram audio drop this relay was built for,
        //                    arriving through the one branch it never covered
        //                    (Lumen, PR #552).
        //
        // Keying on the results rather than the reason also means a stop reason
        // added later cannot quietly reintroduce this — the same default-to-loud
        // argument as hasUnseenFailure itself, one level up.
        //
        // Terminal semantics are preserved: this only populates the FINAL relay,
        // whose output is not extracted, so nothing re-executes and no signal is
        // multiplied.
        relayResults = results;
      }
      break;
    }

    const ranTools = Array.from(new Set(results.map((r) => r.tool))).join(', ');
    ports.ui.printEvent(
      retryAfterRefusal
        ? `  ⋯ ${ranTools} refused — continuing (${iteration}/${maxIterations})…`
        : `  ⋯ ran ${ranTools} — continuing (${iteration}/${maxIterations})…`
    );

    const stopWaiting = ports.ui.startWaiting();
    try {
      outcome = await ports.backend.runTurn(buildContinuationBody(results, calls, dropped), {
        iteration,
        isContinuation: true,
        signal: input.signal,
      });
    } finally {
      stopWaiting();
    }

    if (!outcome.success) {
      // Deliberately do NOT re-resolve responseText here. It still holds the
      // last SUCCESSFUL turn's text, and that is what the REPL displays and
      // writes to the ledger. Overwriting it with the failed spawn's stderr
      // would publish backend diagnostics as the assistant's answer — and the
      // host already reports stderr separately from `lastRunResult`.
      stopReason = 'backend-failure';
      break;
    }
  }

  // FINAL RELAY (PR #491 port): the loop exited at the iteration cap, so the
  // capped iteration's results never reached the model — a send_response
  // that errored there reads to the agent as delivered, and it exits
  // confidently wrong (the Aug 13 Telegram audio drop). One last round-trip
  // shows them; its output is FINAL — ink-tool blocks in it are not executed
  // (extraction stops with the loop). A terminal signal is still excluded: the
  // agent already knows what it signaled, and re-invoking recreates the
  // multiplied-signal bug.
  //
  // The cap is no longer the only way results get stranded. `all-refused`
  // reached here too whenever the ONLY call in a turn threw, and the original
  // exclusion rested on an assumption that is false for most of this fleet —
  // "in the REPL the human watched it happen". Myra is neither a human at a
  // scrollback nor a clone with continueOnBlocked; a validation error simply
  // vanished, three times, and read as the tool doing nothing. `relayResults`
  // is only populated for that case when the iteration actually contains an
  // `error` (see hasUnseenFailure), so a witnessed denial still ends the turn
  // quietly and nobody gets nagged for saying no.
  if (relayResults.length > 0 && outcome.success && !input.signal?.aborted) {
    ports.ui.printEvent('  ⋯ relaying final tool results (no further execution)…');
    const stopRelayWaiting = ports.ui.startWaiting();
    let relay: BackendTurnOutcome;
    try {
      relay = await ports.backend.runTurn(buildFinalRelayBody(relayResults, lastDropped), {
        iteration,
        isContinuation: true,
        signal: input.signal,
      });
    } finally {
      stopRelayWaiting();
    }
    if (relay.success) {
      outcome = relay;
      responseText = resolveResponseText(relay);
    }
    // A failed relay keeps the last successful text — the results are still
    // in allToolResults for the host's own reporting.
  }

  // An aborted turn (SIGINT kills the child) exits >=128 and has no usable text.
  // But cancellation can also be observed WITHOUT a killed child — an approval
  // wait unblocking on the signal — so an already-decided `aborted` stands.
  const aborted =
    stopReason === 'aborted' ||
    input.signal?.aborted === true ||
    (!outcome.success && outcome.exitCode !== undefined && outcome.exitCode >= 128);

  // Any failed final outcome is a failure, whichever branch broke the loop.
  // Without this, an opening turn that fails with no parsed tool calls exits via
  // the `no-tools` branch and reports as completion — which for a clone means
  // failed work is indistinguishable from finished work.
  const finalStopReason: AgentLoopStopReason = aborted
    ? 'aborted'
    : !outcome.success
      ? 'backend-failure'
      : stopReason;

  const assistantDisplayText = aborted
    ? ''
    : input.toolRouting === 'local'
      ? stripLocalToolBlocks(responseText) ||
        (calls.length > 0 || allToolResults.length > 0
          ? '(local tool call emitted; see tool results above)'
          : responseText)
      : responseText;

  return {
    responseText,
    assistantDisplayText,
    toolResults: allToolResults,
    iterations: iteration,
    // A cancelled turn is not a successful one, even when the last backend
    // process exited 0 — cancellation can be observed while nothing is running
    // (an approval wait unblocking), so the child's exit code says nothing
    // about whether the turn achieved anything.
    success: outcome.success && !aborted,
    stopReason: finalStopReason,
  };
}

export interface AgentLoopResult {
  /** Raw backend text of the final turn, tool blocks included. */
  responseText: string;
  /** Display text with tool blocks stripped — what a clone hands back as its summary. */
  assistantDisplayText: string;
  toolResults: ToolResultRecord[];
  iterations: number;
  success: boolean;
  stopReason: AgentLoopStopReason;
}

/**
 * End of the JSON object/array that starts at (or after whitespace from)
 * `from` — walked with a string/escape-aware depth counter. Needed because
 * an ink-tool payload's strings can legally contain ``` (markdown artifact
 * content), which breaks any first-``` fence regex.
 */
function scanJsonValueEnd(text: string, from: number): { start: number; end: number } | null {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  const open = text[i];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return { start: i, end: j + 1 };
    }
  }
  return null;
}

interface InkToolBlock {
  /** Offset of the opening ``` in the response text. */
  start: number;
  /** Offset just past the closing ``` (or past the JSON when unfenced). */
  end: number;
  /** The payload between the fences (the JSON value when scanned). */
  payload: string;
}

/**
 * Locate every ```ink-tool block. The payload JSON is found by scanning the
 * actual value, so ``` embedded in its strings does not truncate the block —
 * a first-``` regex here both dropped the tool call (truncated JSON fails to
 * parse) AND leaked the raw JSON tail into the rendered message (Myra's IRA
 * spec, 2026-08-10). Fallbacks: a payload that isn't a JSON value keeps the
 * legacy to-first-``` treatment; a scanned JSON with a missing closing fence
 * is still accepted (executing beats leaking).
 */
export function findInkToolBlocks(text: string): InkToolBlock[] {
  const blocks: InkToolBlock[] = [];
  const openRe = /```ink-tool[ \t]*\r?\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text))) {
    const payloadStart = m.index + m[0].length;
    const scanned = scanJsonValueEnd(text, payloadStart);
    if (scanned) {
      const closeMatch = /^[ \t\r\n]*```/.exec(text.slice(scanned.end));
      const end = closeMatch ? scanned.end + closeMatch[0].length : scanned.end;
      blocks.push({ start: m.index, end, payload: text.slice(scanned.start, scanned.end) });
      openRe.lastIndex = end;
      continue;
    }
    const closeIdx = text.indexOf('```', payloadStart);
    if (closeIdx === -1) break;
    blocks.push({
      start: m.index,
      end: closeIdx + 3,
      payload: text.slice(payloadStart, closeIdx).trim(),
    });
    openRe.lastIndex = closeIdx + 3;
  }
  return blocks;
}

export function extractLocalToolCalls(responseText: string): LocalToolCall[] {
  const indexed: Array<{ index: number; call: LocalToolCall }> = [];

  for (const block of findInkToolBlocks(responseText)) {
    if (!block.payload) continue;
    try {
      const parsed = JSON.parse(block.payload) as Record<string, unknown>;
      // Strip the MCP namespace HERE, not at dispatch. The bare name has to be
      // canonical for the whole pipeline, because everything downstream of this
      // point branches on `call.tool`: the client-local policy bypass, the
      // ToolCallResult the terminal-signal detector reads, ledger exclusion and
      // friendly formatting. Normalizing only at dispatch fixes execution and
      // leaves all of those reading `mcp__inkwell__signal_status` — the call
      // runs, and the loop still never learns the turn was signalled complete.
      //
      // The XML-variant path below has stripped since 2026-08-10, for this
      // exact reason and for this exact agent. The fence — the primary path —
      // was never given the same treatment, so the older, rarer format was the
      // correct one. Both paths now agree; a test pins them against each other
      // rather than against my belief about either.
      const rawName = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
      const tool = rawName.replace(/^mcp__inkwell__/, '');
      if (!tool) continue;
      const args =
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      indexed.push({
        index: block.start,
        call: { tool, args, raw: responseText.slice(block.start, block.end) },
      });
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
  // Remove ink-tool blocks by the SAME scan the extractor uses — a regex
  // here would disagree with extraction on payloads containing ``` and leak
  // the JSON tail as visible text.
  let out = '';
  let cursor = 0;
  for (const block of findInkToolBlocks(responseText)) {
    out += responseText.slice(cursor, block.start);
    cursor = block.end;
  }
  out += responseText.slice(cursor);
  return out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
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
/** An outcome where the call actually ran. Nothing to report as unseen. */
const RAN_STATUSES: ReadonlySet<string> = new Set(['executed', 'approved']);

/**
 * Outcomes somebody AUTHORED and watched happen.
 *
 * `denied` is a human clicking no. `blocked` is a policy rule someone wrote.
 * `rejected` is an iteration the screen refused, and the loop already feeds
 * that reason back on its own path. Relaying these would re-prompt a person
 * about a decision they just made.
 */
const WITNESSED_REFUSAL_STATUSES: ReadonlySet<string> = new Set(['blocked', 'denied', 'rejected']);

/**
 * True when an iteration contains a failure the agent has not been told about.
 *
 * A DENYLIST of authored refusals, not an allowlist of known failures, and the
 * direction matters more than the contents (Myra, 2026-08-31):
 *
 *   an allowlist of failure kinds can only ever be wrong toward SILENCE.
 *
 * Listing `error` and relaying only that would repair this bug while leaving
 * its shape in place: invent `'timeout'` in a transport layer next year and it
 * inherits the exact defect, discovered — as this one was — by accident, late,
 * possibly with a consequence attached. Inverting it can only be wrong toward
 * NOISE: a genuinely new refusal kind relays until someone adds it below, which
 * is a line of code and a mild annoyance, and it reports itself immediately.
 *
 * The asymmetry is not incidental to this codebase; it is the whole subject of
 * the defect group this fix came from.
 *
 * Enumerating refusals is safe in a way enumerating failures is not, because
 * refusals are *authored*: whoever adds a new one is, by construction, in a
 * position to know they are adding a refusal and to put it here. Failures are
 * emergent — a new exception path, a validation layer added in a file that has
 * nothing to do with this loop — and nobody writing those has read this
 * predicate. What makes a refusal swallowable is its provenance, not its name.
 */
export function hasUnseenFailure(
  iterationResults: ReadonlyArray<Pick<ToolResultRecord, 'status'>>
): boolean {
  return iterationResults.some(
    (r) => !RAN_STATUSES.has(r.status) && !WITNESSED_REFUSAL_STATUSES.has(r.status)
  );
}

export function toolLoopStopReason(
  iterationResults: ReadonlyArray<Pick<ToolResultRecord, 'tool' | 'status' | 'result'>>,
  iteration: number,
  maxIterations: number = DEFAULT_MAX_TOOL_LOOP_ITERATIONS
): AgentLoopStopReason | null {
  const signaledDone = iterationResults.some(
    (r) => r.tool === 'signal_status' && isTerminalSignalToolResult(r.result)
  );
  if (signaledDone) return 'terminal-signal';

  // Reachable only when the agent DID emit calls, so "nothing executed" means
  // "everything was refused" — never "it stopped asking".
  const hasExecutedTools = iterationResults.some(
    (r) => r.status === 'executed' || r.status === 'approved'
  );
  if (!hasExecutedTools) return 'all-refused';

  if (iteration >= maxIterations) return 'iteration-cap';

  return null;
}
