import type { AgentLoopResult } from './agent-loop.js';
import {
  AUTO_EVICT_KEEP_RECENT_TURNS,
  AUTO_EVICT_MIN_SHARE,
  AUTO_EVICT_MIN_TOKENS,
  AUTO_EVICT_TOMBSTONE_SOURCE,
  autoEvictTombstone,
  selectConsumedToolResults,
} from './auto-evict.js';
import {
  entryRefHash,
  estimateTokens,
  type ContextLedger,
  type LedgerRole,
} from './context-ledger.js';
import type { ContextOccupancy } from './context-tools.js';
import type { SbHookRegistry } from './hook-registry.js';
import { compactForLedger } from './session-history.js';
import type { BackendTokenUsage } from './token-usage.js';

export interface SessionTurnInput {
  raw: string;
  source: 'user' | 'inbox-auto' | 'system';
  displayLabel?: string;
}

export interface SessionTurnState {
  sessionId?: string;
  sbSlug: string;
  backend: string;
  model?: string;
  bootstrapContext?: string;
  maxContextTokens: number;
  compactionInFlight: boolean;
}

export type SessionHookResult = Awaited<ReturnType<SbHookRegistry['fire']>>;

export interface PreparedSessionTurn {
  input: Readonly<SessionTurnInput>;
  occupancy: ContextOccupancy;
  promptHooks: SessionHookResult;
}

export interface SessionTurnExecution<T> {
  loop: AgentLoopResult;
  backend: {
    success: boolean;
    exitCode: number;
    durationMs: number;
    stderr: string;
    usage?: BackendTokenUsage;
  };
  /** Host-only presentation/diagnostic state; never persisted by the coordinator. */
  value: T;
}

export interface SessionTurnResult<T> {
  execution: SessionTurnExecution<T>;
  endHooks: SessionHookResult;
  autoEviction?: { entries: number; removedTokens: number; tools: string[] };
}

export interface SessionTurnPorts {
  /** Finite whole-event budget. Default 5 seconds; the host may choose a smaller deadline. */
  endHookTimeoutMs?: number;
  /** Same bounded hook contract before dispatch; default 5 seconds. */
  promptHookTimeoutMs?: number;
  ledger: ContextLedger;
  hooks: SbHookRegistry;
  /** Append reserves an eid; flush confirms queued writes. Not a DB transaction. */
  log: {
    append(event: Record<string, unknown>): number;
    flush(): Promise<void>;
  };
  state(): SessionTurnState;
  occupancy(): ContextOccupancy;
  /** Host status/admission signaling. Admission itself must precede run(). */
  inputRecorded?(): Promise<void>;
  compact(reason: string, signal?: AbortSignal): Promise<void>;
  /** The existing persistent eviction path also invalidates native provider history. */
  recordEviction(
    actor: 'system',
    reason: string,
    removedTokens: number,
    refs: Array<{ eid?: number; hash: string; role: LedgerRole; source?: string; preview: string }>
  ): void;
}

/**
 * Per-session context lifecycle around the existing agent loop. Hosts still own
 * provider/tool composition, admission, cancellation, live controls and views.
 * This is not a replacement loop or an ownership fence. Ordinary inputs must
 * use the host's serial drain; a second concurrent run is a wiring error.
 */
export class SessionTurnCoordinator {
  private running = false;
  private completedTurns = 0;

  constructor(private readonly ports: SessionTurnPorts) {
    const ms = ports.endHookTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 60_000) {
      throw new RangeError('End-hook timeout must be an integer from 1 to 60000 ms');
    }
    this.endHookTimeoutMs = ms;
    const promptMs = ports.promptHookTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(promptMs) || promptMs < 1 || promptMs > 60_000) {
      throw new RangeError('Prompt-hook timeout must be an integer from 1 to 60000 ms');
    }
    this.promptHookTimeoutMs = promptMs;
  }

  private readonly endHookTimeoutMs: number;
  private readonly promptHookTimeoutMs: number;

  get turnCount(): number {
    return this.completedTurns;
  }

  async run<T>(
    submitted: SessionTurnInput,
    execute: (turn: PreparedSessionTurn) => Promise<SessionTurnExecution<T>>,
    /**
     * Committed assistant outcome, before the bounded recall tail. Not completion.
     * Hosts must not throw here: a throw propagates AFTER persistence, skipping
     * the tail; callers must not retry the already committed outcome.
     */
    onOutcome?: (execution: SessionTurnExecution<T>) => void,
    /** Cancels hook waits and fences dispatch; host I/O must also honor it. */
    signal?: AbortSignal
  ): Promise<SessionTurnResult<T> | undefined> {
    if (this.running) throw new Error('Session turn already running');
    signal?.throwIfAborted();
    if (!submitted.raw.trim()) return undefined;
    this.running = true;
    const input = { ...submitted };
    let inputEid: number | undefined;
    let executionEntered = false;
    try {
      inputEid = this.recordInput(input);
      await this.ports.inputRecorded?.();
      signal?.throwIfAborted();
      await this.ports.compact('pre-turn budget check', signal);
      signal?.throwIfAborted();
      const occupancy = this.ports.occupancy();
      const promptHooks = await this.fireBoundedHooks(
        'prompt_build',
        input.raw,
        '',
        occupancy,
        signal
      );
      signal?.throwIfAborted();
      // No provider dispatch after an unobserved asynchronous input/hook write failure.
      await this.ports.log.flush();
      signal?.throwIfAborted();
      executionEntered = true;
      const execution = await execute({ input, occupancy, promptHooks });
      const { loop, backend } = execution;
      const state = this.ports.state();
      const aborted = loop.stopReason === 'aborted';
      const common = {
        type: 'assistant',
        backend: state.backend,
        model: state.model || null,
        exitCode: backend.exitCode,
        durationMs: backend.durationMs,
        stderr: backend.stderr || null,
        usage: backend.usage || null,
      };
      if (aborted) {
        this.ports.log.append({ ...common, success: false, content: null, cancelled: true });
      } else {
        this.ports.ledger.addEntry('assistant', loop.assistantDisplayText, state.backend);
        this.ports.log.append({
          ...common,
          success: backend.success,
          content: loop.assistantDisplayText,
          rawContent: loop.responseText,
          approxTokens: estimateTokens(loop.assistantDisplayText),
        });
      }
      this.completedTurns++;
      await this.ports.log.flush();
      onOutcome?.(execution);
      const autoEviction =
        !aborted && !state.compactionInFlight ? this.evictConsumed(state) : undefined;
      // Previously fire-and-forget in runChat: a slow recall could inject into
      // the NEXT prompt, or append after one-shot shutdown closed the log.
      // Hook handlers isolate their own errors; persistence failures do not.
      let endHooks: SessionHookResult = {
        injected: 0,
        injectedEntries: [],
        evicted: 0,
        blocked: false,
      };
      if (!aborted && !signal?.aborted) {
        endHooks = await this.fireBoundedHooks(
          'turn_end',
          input.raw,
          loop.assistantDisplayText,
          this.ports.occupancy(),
          signal
        );
      }
      await this.ports.log.flush();
      return { execution, endHooks, autoEviction };
    } catch (error) {
      if (signal?.aborted && inputEid !== undefined && !executionEntered) {
        // Input stays history, but is not an unfinished command to replay.
        // This says ONLY that ordinary execution was not entered: preparation,
        // hooks or compaction may already have performed their own effects.
        // Finish while the host log is still writable. A failed append/flush
        // propagates as uncertainty, never as a confirmed cancellation receipt.
        this.ports.log.append({
          type: 'input_cancelled',
          inputEid,
          stage: 'before_ordinary_dispatch',
        });
        await this.ports.log.flush();
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  private recordInput(input: SessionTurnInput): number {
    const { ledger, log } = this.ports;
    if (input.source === 'user') {
      ledger.addEntry('user', input.raw, 'repl');
      return log.append({ type: 'user', content: input.raw });
    } else if (input.source === 'system') {
      const label = input.displayLabel || 'system';
      ledger.addEntry('system', input.raw, label);
      return log.append({ type: 'system_turn', content: input.raw, label });
    } else {
      ledger.addEntry('system', compactForLedger(`[auto-run inbox] ${input.raw}`, 500), 'auto-run');
      return log.append({ type: 'auto_turn', content: input.raw });
    }
  }

  private async fireBoundedHooks(
    event: 'prompt_build' | 'turn_end',
    userInput: string,
    assistantResponse: string,
    occupancy: ContextOccupancy,
    signal?: AbortSignal
  ): Promise<SessionHookResult> {
    const timeoutMs = event === 'prompt_build' ? this.promptHookTimeoutMs : this.endHookTimeoutMs;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.fireHooks(
        event,
        userInput,
        assistantResponse,
        occupancy,
        controller.signal
      );
      if (result.interrupted && !signal?.aborted) {
        this.ports.log.append({ type: 'hook_timeout', event, timeoutMs });
      }
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async fireHooks(
    event: 'prompt_build' | 'turn_end',
    userInput: string,
    assistantResponse: string,
    occupancy: ContextOccupancy,
    signal?: AbortSignal
  ): Promise<SessionHookResult> {
    const state = this.ports.state();
    const result = await this.ports.hooks.fire(event, {
      ledger: this.ports.ledger,
      signal,
      runtime: {
        sessionId: state.sessionId,
        sbSlug: state.sbSlug,
        backend: state.backend,
        budgetUtilization: occupancy.utilization,
        turnCount: this.completedTurns,
      },
      lastTurn: {
        userInput,
        assistantResponse,
        turnIndex: event === 'prompt_build' ? this.completedTurns + 1 : this.completedTurns,
      },
    });
    for (const entry of result.injectedEntries) {
      this.ports.log.append({
        type: 'hook_injection',
        role: entry.role,
        content: entry.content,
        source: entry.source,
        memoryId: entry.memoryId,
      });
    }
    return result;
  }

  private evictConsumed(state: SessionTurnState): SessionTurnResult<never>['autoEviction'] {
    const effectiveBudget = Math.max(
      1,
      state.maxContextTokens - estimateTokens(state.bootstrapContext ?? '')
    );
    const sweep = selectConsumedToolResults(this.ports.ledger.listEntries(), {
      keepRecentTurns: AUTO_EVICT_KEEP_RECENT_TURNS,
      minTokens: Math.max(
        AUTO_EVICT_MIN_TOKENS,
        Math.floor(effectiveBudget * AUTO_EVICT_MIN_SHARE)
      ),
    });
    if (!sweep) return undefined;
    const removed = this.ports.ledger.evictEntries(sweep.ids);
    this.ports.recordEviction(
      'system',
      `auto: ${sweep.ids.length} consumed tool results older than ${AUTO_EVICT_KEEP_RECENT_TURNS} turns`,
      removed.removedTokens,
      removed.removedEntries.map((entry) => ({
        ...(entry.eid !== undefined ? { eid: entry.eid } : {}),
        hash: entryRefHash(entry.role, entry.content),
        role: entry.role,
        source: entry.source,
        preview: entry.content.slice(0, 100),
      }))
    );
    const tombstone = autoEvictTombstone(sweep, AUTO_EVICT_KEEP_RECENT_TURNS);
    const eid = this.ports.log.append({
      type: 'context_note',
      source: AUTO_EVICT_TOMBSTONE_SOURCE,
      content: tombstone,
    });
    this.ports.ledger.addEntry('system', tombstone, AUTO_EVICT_TOMBSTONE_SOURCE, eid);
    return { entries: sweep.ids.length, removedTokens: removed.removedTokens, tools: sweep.tools };
  }
}
