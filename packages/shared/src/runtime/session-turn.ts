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
  compact(reason: string): Promise<void>;
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

  constructor(private readonly ports: SessionTurnPorts) {}

  get turnCount(): number {
    return this.completedTurns;
  }

  async run<T>(
    submitted: SessionTurnInput,
    execute: (turn: PreparedSessionTurn) => Promise<SessionTurnExecution<T>>
  ): Promise<SessionTurnResult<T> | undefined> {
    if (this.running) throw new Error('Session turn already running');
    if (!submitted.raw.trim()) return undefined;
    this.running = true;
    const input = { ...submitted };
    try {
      this.recordInput(input);
      await this.ports.inputRecorded?.();
      await this.ports.compact('pre-turn budget check');
      const occupancy = this.ports.occupancy();
      const promptHooks = await this.fireHooks('prompt_build', input.raw, '', occupancy);
      // No provider dispatch after an unobserved asynchronous input/hook write failure.
      await this.ports.log.flush();
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
      const autoEviction =
        !aborted && !state.compactionInFlight ? this.evictConsumed(state) : undefined;
      // Previously fire-and-forget in runChat: a slow recall could inject into
      // the NEXT prompt, or append after one-shot shutdown closed the log.
      // Hook handlers isolate their own errors; persistence failures do not.
      const endHooks = await this.fireHooks(
        'turn_end',
        input.raw,
        loop.assistantDisplayText,
        this.ports.occupancy()
      );
      await this.ports.log.flush();
      return { execution, endHooks, autoEviction };
    } finally {
      this.running = false;
    }
  }

  private recordInput(input: SessionTurnInput): void {
    const { ledger, log } = this.ports;
    if (input.source === 'user') {
      ledger.addEntry('user', input.raw, 'repl');
      log.append({ type: 'user', content: input.raw });
    } else if (input.source === 'system') {
      const label = input.displayLabel || 'system';
      ledger.addEntry('system', input.raw, label);
      log.append({ type: 'system_turn', content: input.raw, label });
    } else {
      ledger.addEntry('system', compactForLedger(`[auto-run inbox] ${input.raw}`, 500), 'auto-run');
      log.append({ type: 'auto_turn', content: input.raw });
    }
  }

  private async fireHooks(
    event: 'prompt_build' | 'turn_end',
    userInput: string,
    assistantResponse: string,
    occupancy: ContextOccupancy
  ): Promise<SessionHookResult> {
    const state = this.ports.state();
    const result = await this.ports.hooks.fire(event, {
      ledger: this.ports.ledger,
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
