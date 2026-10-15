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
  results: ToolCallResult[];
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
}): StreamToolDispatch | undefined {
  return options.enabled === true ? new StreamToolDispatch(options.executor) : undefined;
}

class StreamToolDispatch {
  private text = '';
  private seen = 0;
  private ended = false;
  private heldExclusive = false;
  private refusedSuffix = false;
  private admitted: LocalToolCall[] = [];
  private notRun: StreamDispatchResult['notRun'] = [];
  private queue: LocalToolCall[] = [];
  private wake: (() => void) | undefined;
  private failure: { error: unknown } | undefined;
  private readonly execution: Promise<ToolCallResult[]>;

  constructor(private readonly executor: ToolCallExecutorPorts) {
    // Catch at creation, not at finish: a port can fail while generation is
    // still running. Observe it without letting a rejection go unhandled.
    this.execution = executeToolCalls(this.source(), executor).catch((error: unknown) => {
      this.failure = { error };
      return [];
    });
  }

  /** Only fresh provider output belongs here, never journal or reseeded context. */
  append(delta: string): void {
    if (this.ended) throw new Error('Tool stream already ended');
    this.text += delta;
    this.scan(true);
  }

  /**
   * Also called after a provider failure: already admitted calls still settle.
   * Repeated final extraction returns those outcomes, never dispatches again.
   */
  async finish(): Promise<StreamDispatchResult> {
    if (!this.ended) {
      this.scan(false);
      if (this.heldExclusive) {
        const extracted = extractToolBlocks(this.text, { canonicalOnly: true });
        const screen = screenIteration(extracted.calls, MAX_TOOL_CALLS_PER_ITERATION);
        if (screen.ok) {
          for (const call of screen.calls) this.admit(call);
        } else {
          this.notRun.push(...extracted.calls.map((call) => ({ call, reason: screen.reason })));
        }
      }
      this.ended = true;
      this.wake?.();
    }
    const results = await this.execution;
    if (this.failure) throw this.failure.error;
    return {
      extracted: extractToolBlocks(this.text, { canonicalOnly: true }),
      admitted: snapshotCalls(this.admitted),
      notRun: this.notRun.map(({ call, reason }) => ({ call: snapshotCalls([call])[0]!, reason })),
      results,
    };
  }

  private scan(partial: boolean): void {
    const { calls } = extractToolBlocks(this.text, { canonicalOnly: true, partial });
    for (const call of calls.slice(this.seen)) {
      this.seen++;
      if (this.heldExclusive) continue;
      if (this.refusedSuffix) {
        this.notRun.push({ call, reason: 'Not run: follows a refused exclusive call.' });
        continue;
      }
      // Use the existing canonical exclusivity screen, including MCP spelling.
      const screen = screenIteration([call], MAX_TOOL_CALLS_PER_ITERATION);
      if (screen.ok && screen.spawn) {
        if (this.admitted.length === 0) {
          this.heldExclusive = true;
        } else {
          this.refusedSuffix = true;
          this.notRun.push({
            call,
            reason:
              `Not run: ${call.tool} must be first and alone. ` +
              `Earlier admitted calls (${this.admitted.map((c) => c.tool).join(', ')}) ` +
              'retain their own outcomes; this call and every following call were not run.',
          });
        }
        continue;
      }
      this.admit(call);
    }
  }

  private admit(call: LocalToolCall): void {
    if (this.executor.signal?.aborted) {
      this.notRun.push({ call, reason: 'Cancelled before admission; not run.' });
    } else if (this.failure) {
      this.notRun.push({ call, reason: 'Executor failed before admission; not run.' });
    } else if (this.admitted.length >= MAX_TOOL_CALLS_PER_ITERATION) {
      this.notRun.push({ call, reason: 'Per-response tool cap reached; not run.' });
    } else {
      const copy = snapshotCalls([call])[0]!;
      this.admitted.push(copy);
      this.queue.push(copy);
      this.wake?.();
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
