/**
 * SB Runtime Hook Registry
 *
 * Internal hook system for the sb chat REPL. Hooks are in-process TypeScript
 * functions that fire at lifecycle events. They can inject context into the
 * ledger, evict entries, or block pre-* pipeline stages.
 *
 * Uses our canonical hook naming (on-session-start, on-turn-end, on-prompt, etc.)
 * which maps to backend-specific events via the adaptor in hooks.ts.
 */

import type { ContextLedger, LedgerRole } from './context-ledger.js';

// ─── Types ──────────────────────────────────────────────────────

export type SbHookEvent =
  | 'session_start'
  | 'session_end'
  | 'prompt_build'
  | 'turn_start'
  | 'turn_end'
  | 'tool_pre'
  | 'tool_post'
  | 'compact_pre'
  | 'compact_post'
  | 'evict_post'
  | 'budget_warning'
  | 'idle';

export interface HookContext {
  event: SbHookEvent;
  ledger: ContextLedger;
  runtime: HookRuntimeState;
  /** Last turn content — available on on-turn-end, on-prompt */
  lastTurn?: {
    userInput: string;
    assistantResponse: string;
    turnIndex: number;
  };
  /** Event-specific data */
  trigger?: Record<string, unknown>;
}

export interface HookRuntimeState {
  sessionId?: string;
  agentId?: string;
  backend?: string;
  budgetUtilization?: number; // 0-1
  turnCount: number;
}

export interface InjectedLedgerEntry {
  role: LedgerRole;
  content: string;
  source: string;
  /** Hook that produced this injection */
  hookName?: string;
  /** PCP memory ID if this came from recall */
  memoryId?: string;
  /** Relevance score if available */
  score?: number;
}

export interface HookResult {
  /** Entries to inject into the ledger */
  inject?: InjectedLedgerEntry[];
  /** Entry IDs to evict from the ledger */
  evict?: number[];
  /** Block the pipeline (only for pre-* hooks) */
  block?: boolean;
  blockReason?: string;
}

export interface SbHook {
  name: string;
  event: SbHookEvent;
  /** Lower = earlier. Default 100. */
  priority: number;
  handler: (ctx: HookContext) => Promise<HookResult | void>;
}

// ─── Pre-* events that support blocking ─────────────────────────

const BLOCKING_EVENTS = new Set<SbHookEvent>(['tool_pre', 'compact_pre']);

// ─── Registry ───────────────────────────────────────────────────

export class SbHookRegistry {
  private hooks: SbHook[] = [];
  private _fireLog: Array<{ event: SbHookEvent; hookName: string; timestamp: string }> = [];

  register(hook: Omit<SbHook, 'priority'> & { priority?: number }): void {
    this.hooks.push({
      ...hook,
      priority: hook.priority ?? 100,
    });
    // Keep sorted by priority (lower first)
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  unregister(name: string): boolean {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((h) => h.name !== name);
    return this.hooks.length < before;
  }

  listHooks(): Array<{ name: string; event: SbHookEvent; priority: number }> {
    return this.hooks.map((h) => ({
      name: h.name,
      event: h.event,
      priority: h.priority,
    }));
  }

  /** Get the fire log (for testing/debugging) */
  getFireLog(): typeof this._fireLog {
    return [...this._fireLog];
  }

  /** Clear the fire log */
  clearFireLog(): void {
    this._fireLog = [];
  }

  /**
   * Fire all hooks registered for an event.
   *
   * Hooks run sequentially in priority order. Each hook can:
   * - Inject entries (applied to ledger immediately, visible to subsequent hooks)
   * - Evict entries (applied to ledger immediately)
   * - Block the pipeline (only for pre-* events)
   *
   * Returns aggregated results from all hooks.
   */
  async fire(
    event: SbHookEvent,
    ctx: Omit<HookContext, 'event'>
  ): Promise<{
    injected: number;
    evicted: number;
    blocked: boolean;
    blockReason?: string;
  }> {
    const eventHooks = this.hooks.filter((h) => h.event === event);
    if (eventHooks.length === 0) {
      return { injected: 0, evicted: 0, blocked: false };
    }

    const fullCtx: HookContext = { event, ...ctx };
    let totalInjected = 0;
    let totalEvicted = 0;

    for (const hook of eventHooks) {
      try {
        const result = await hook.handler(fullCtx);
        this._fireLog.push({
          event,
          hookName: hook.name,
          timestamp: new Date().toISOString(),
        });

        if (!result) continue;

        // Apply injections immediately — later hooks see them
        if (result.inject && result.inject.length > 0) {
          for (const entry of result.inject) {
            ctx.ledger.addEntry(entry.role, entry.content, entry.source);
            totalInjected++;
          }
        }

        // Apply evictions immediately
        if (result.evict && result.evict.length > 0) {
          const evictResult = ctx.ledger.evictEntries(result.evict);
          totalEvicted += evictResult.removedEntries.length;
        }

        // Block check (only for pre-* events)
        if (result.block && BLOCKING_EVENTS.has(event)) {
          return {
            injected: totalInjected,
            evicted: totalEvicted,
            blocked: true,
            blockReason: result.blockReason || `Blocked by hook: ${hook.name}`,
          };
        }
      } catch (err) {
        // Hooks must never crash the REPL — fail silently, move on
        // eslint-disable-next-line no-console
        console.warn(`[sb-hook] "${hook.name}" failed on ${event}:`, err);
      }
    }

    return { injected: totalInjected, evicted: totalEvicted, blocked: false };
  }
}
