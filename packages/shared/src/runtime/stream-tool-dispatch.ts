import {
  extractToolBlocks,
  MAX_TOOL_CALLS_PER_ITERATION,
  snapshotCalls,
  type LocalToolCall,
} from './agent-loop.js';
import { screenIteration } from './spawn-agent.js';
import {
  executeToolCalls,
  type ToolCallExecutorPorts,
  type ToolCallResult,
} from './tool-call-executor.js';

export interface StreamDispatchResult {
  /** The same canonical extraction used during streaming, including diagnostics. */
  extracted: ReturnType<typeof extractToolBlocks>;
  admitted: LocalToolCall[];
  notRun: Array<{ call: LocalToolCall; reason: string }>;
  /** Source position orders this attempt's relay; it is not invocation identity. */
  results: Array<ToolCallResult & Pick<LocalToolCall, 'sourceStart'>>;
  /** Partial outcomes remain available on failure; this is not a successful batch. */
  failure?: { kind: 'parser' | 'executor'; message: string };
}

interface InvocationProgress {
  call: LocalToolCall;
  invocationId?: string;
  dispatched: boolean;
  result?: ToolCallResult;
}

/**
 * Opt-in, one-provider-attempt admission core. Hosts do not use it yet: durable
 * owner/turn recovery and bounded teardown must be wired before activation.
 * Waiting semantics are unchanged; wait:false and its receipt supervisor are
 * deliberately not implemented by this first slice.
 *
 * The existing executor consumes an incremental source instead of a completed
 * array. There is no second policy, intent barrier, or read/write scheduler.
 */
export function createStreamToolDispatch(options: {
  enabled?: boolean;
  executor: ToolCallExecutorPorts;
  /** Session bookkeeping, before queueing. A throw refuses this and later admissions. */
  onAdmission?(call: LocalToolCall): void;
}): StreamToolDispatch | undefined {
  return options.enabled === true
    ? new StreamToolDispatch(options.executor, options.onAdmission)
    : undefined;
}

class StreamToolDispatch {
  private text = '';
  // Offsets are parser provenance only. The executor still mints invocation
  // identities; these keys must never be used as durable effect identities.
  private seen = new Map<number, string>();
  private ended = false;
  private heldExclusive = false;
  private refusedSuffix = false;
  private admitted: LocalToolCall[] = [];
  private notRun: StreamDispatchResult['notRun'] = [];
  private queue: LocalToolCall[] = [];
  private wake: (() => void) | undefined;
  private failure: { error: unknown } | undefined;
  private parserFailure: string | undefined;
  private progress = new Map<Record<string, unknown>, InvocationProgress>();
  private finishing: Promise<StreamDispatchResult> | undefined;
  private readonly execution: Promise<ToolCallResult[]>;

  constructor(
    private readonly executor: ToolCallExecutorPorts,
    private readonly onAdmission?: (call: LocalToolCall) => void
  ) {
    // Catch at creation, not at finish: a port can fail while generation is
    // still running. Observe it without letting a rejection go unhandled.
    this.execution = executeToolCalls(this.source(), {
      ...executor,
      commitIntent: (call, invocationId) => {
        this.progress.get(call.args)!.invocationId = invocationId;
        return executor.commitIntent(call, invocationId);
      },
      callTool: (tool, args, ctx) => {
        this.progress.get(args)!.dispatched = true;
        return executor.callTool(tool, args, ctx);
      },
      onResult: (result) => {
        // Retain the outcome BEFORE a reporting port can throw. This does not
        // replace the host's journal; persistence can still fail independently.
        this.progress.get(result.args)!.result = result;
        executor.onResult?.(result);
      },
    }).catch((error: unknown) => {
      this.failure = { error };
      return [];
    });
  }

  /** Only fresh provider output belongs here, never journal or reseeded context. */
  append(delta: string): void {
    if (this.ended) throw new Error('Tool stream already ended');
    this.text += delta;
    // A partial closer cannot complete without a newline. This exact gate
    // avoids reparsing a large JSON payload on every tiny provider delta.
    if (delta.includes('\n')) this.scan(true);
  }

  /**
   * Also called after a provider failure: already admitted calls still settle.
   * Repeated final extraction returns those outcomes, never dispatches again.
   */
  finish(options: { endOfResponse: boolean }): Promise<StreamDispatchResult> {
    // The first close owns finality. Repeated final extraction cannot upgrade
    // a failed attempt to a successful EOF or dispatch its tail later.
    return (this.finishing ??= this.finalize(options.endOfResponse));
  }

  private async finalize(endOfResponse: boolean): Promise<StreamDispatchResult> {
    const partial = !endOfResponse;
    if (!this.ended) {
      this.scan(partial);
      if (this.heldExclusive) {
        const extracted = extractToolBlocks(this.text, { canonicalOnly: true, partial });
        const screen = screenIteration(extracted.calls, MAX_TOOL_CALLS_PER_ITERATION);
        if (!endOfResponse) {
          for (const call of extracted.calls)
            this.refuse(
              call,
              'Not run: the provider failed before the exclusive response was complete.'
            );
        } else if (screen.ok) {
          for (const call of screen.calls) this.admit(call);
        } else {
          for (const call of extracted.calls) this.refuse(call, screen.reason);
        }
      }
      this.ended = true;
      this.wake?.();
    }
    await this.execution;
    const results: StreamDispatchResult['results'] = [];
    for (const state of this.progress.values()) {
      if (state.result) results.push({ ...state.result, sourceStart: state.call.sourceStart });
      else if (!state.dispatched) {
        this.refuse(state.call, 'Executor failed before dispatch; not run.');
      } else {
        results.push({
          tool: state.call.tool,
          args: state.call.args,
          invocationId: state.invocationId,
          sourceStart: state.call.sourceStart,
          status: 'error',
          dispatchState: 'unknown',
          error: 'Executor failed without a confirmed outcome; do not retry automatically.',
        });
      }
    }
    return {
      extracted: extractToolBlocks(this.text, { canonicalOnly: true, partial }),
      admitted: snapshotCalls(this.admitted),
      notRun: this.notRun.map(({ call, reason }) => ({ call: snapshotCalls([call])[0]!, reason })),
      results,
      ...(this.failure
        ? {
            failure: {
              kind: 'executor' as const,
              message:
                this.failure.error instanceof Error
                  ? this.failure.error.message
                  : String(this.failure.error),
            },
          }
        : this.parserFailure
          ? { failure: { kind: 'parser' as const, message: this.parserFailure } }
          : {}),
    };
  }

  private scan(partial: boolean): void {
    const { calls } = extractToolBlocks(this.text, { canonicalOnly: true, partial });
    const current = new Map(calls.map((call) => [call.sourceStart!, call.raw]));
    if ([...this.seen].some(([start, raw]) => current.get(start) !== raw)) {
      this.parserFailure ??=
        'Canonical extraction changed an already observed block; further admission stopped.';
    }
    for (const call of calls) {
      if (this.seen.has(call.sourceStart!)) continue;
      this.seen.set(call.sourceStart!, call.raw);
      if (this.parserFailure) {
        this.refuse(call, this.parserFailure);
        continue;
      }
      if (this.heldExclusive) continue;
      if (this.refusedSuffix) {
        this.refuse(call, 'Not run: follows a refused exclusive call.');
        continue;
      }
      // Use the existing canonical exclusivity screen, including MCP spelling.
      const screen = screenIteration([call], MAX_TOOL_CALLS_PER_ITERATION);
      if (screen.ok && screen.spawn) {
        if (this.admitted.length === 0) {
          this.heldExclusive = true;
        } else {
          this.refusedSuffix = true;
          this.refuse(
            call,
            `Not run: ${call.tool} must be first and alone. ` +
              `Earlier admitted calls (${this.admitted.map((c) => c.tool).join(', ')}) ` +
              'retain their own outcomes; this call and every following call were not run.'
          );
        }
        continue;
      }
      this.admit(call);
    }
  }

  private admit(call: LocalToolCall): void {
    if (this.executor.signal?.aborted) {
      this.refuse(call, 'Cancelled before admission; not run.');
    } else if (this.failure) {
      this.refuse(call, 'Executor failed before admission; not run.');
    } else if (this.parserFailure) {
      this.refuse(call, this.parserFailure);
    } else if (this.admitted.length >= MAX_TOOL_CALLS_PER_ITERATION) {
      this.refuse(call, 'Per-response tool cap reached; not run.');
    } else {
      const copy = snapshotCalls([call])[0]!;
      try {
        this.onAdmission?.(copy);
      } catch (error) {
        this.failure = { error };
        this.refuse(call, 'Session admission failed; not run.');
        return;
      }
      this.admitted.push(copy);
      this.progress.set(copy.args, { call: copy, dispatched: false });
      this.queue.push(copy);
      this.wake?.();
    }
  }

  private refuse(call: LocalToolCall, reason: string): void {
    if (!this.notRun.some((entry) => entry.call.sourceStart === call.sourceStart)) {
      this.notRun.push({ call, reason });
    }
  }

  private async *source(): AsyncGenerator<LocalToolCall> {
    while (true) {
      const call = this.queue.shift();
      if (call) yield call;
      else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
