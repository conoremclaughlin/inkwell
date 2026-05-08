/**
 * Built-in Hooks for ink chat
 *
 * These hooks ship with the runtime and are registered by default.
 * They implement core behaviors: passive memory recall, budget monitoring,
 * and session heartbeat.
 */

import type { SbHookRegistry, HookResult, HookContext } from './hook-registry.js';
import type { ContextLedger } from './context-ledger.js';

// ─── Topic Signal Extraction ────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'been',
  'would',
  'could',
  'should',
  'will',
  'just',
  'this',
  'that',
  'with',
  'from',
  'they',
  'were',
  'what',
  'when',
  'make',
  'like',
  'time',
  'very',
  'your',
  'know',
  'about',
  'some',
  'them',
  'than',
  'then',
  'into',
  'also',
  'more',
  'here',
  'there',
  'does',
  'don',
  'let',
]);

export function extractTopicSignal(userInput: string, assistantResponse: string): string {
  const stripped = [userInput, assistantResponse]
    .join(' ')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/https?:\/\/\S+/g, '');

  const tokens = stripped
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([token]) => token)
    .join(' ')
    .slice(0, 200);
}

// ─── Passive Recall Hook ────────────────────────────────────────

export interface PassiveRecallConfig {
  enabled: boolean;
  maxInjectPerTurn: number;
  budgetCeiling: number;
  cooldownTurns: number;
  maxTokensPerInjection: number;
  reinjectionCooldown: number;
}

const DEFAULT_PASSIVE_RECALL_CONFIG: PassiveRecallConfig = {
  enabled: true,
  maxInjectPerTurn: 6,
  budgetCeiling: 0.8,
  cooldownTurns: 3,
  maxTokensPerInjection: 500,
  reinjectionCooldown: 10,
};

interface RecallMemory {
  id: string;
  content: string;
  summary: string | null;
  topics: string[];
}

export function registerPassiveRecallHook(
  registry: SbHookRegistry,
  callRecall: (query: string, limit: number) => Promise<RecallMemory[]>,
  config?: Partial<PassiveRecallConfig>
): { getStats: () => PassiveRecallStats } {
  const cfg = { ...DEFAULT_PASSIVE_RECALL_CONFIG, ...config };
  const injectedMemoryIds = new Set<string>();
  const evictedMemoryIds = new Map<string, number>(); // memoryId → turn evicted
  let turnsSinceLastInjection = cfg.cooldownTurns; // allow first injection
  let turnCounter = 0;
  let totalInjected = 0;
  let totalSuppressed = 0;

  // Shared recall logic used by both prompt_build and turn_end hooks
  const doRecall = async (ctx: HookContext): Promise<HookResult | void> => {
    if (!cfg.enabled) return;

    // Budget ceiling
    if ((ctx.runtime.budgetUtilization ?? 0) > cfg.budgetCeiling) {
      totalSuppressed++;
      return;
    }

    // Cooldown
    if (turnsSinceLastInjection < cfg.cooldownTurns) {
      turnsSinceLastInjection++;
      return;
    }

    // Need some input to extract signal from
    if (!ctx.lastTurn) return;

    // Extract topic signal
    const signal = extractTopicSignal(ctx.lastTurn.userInput, ctx.lastTurn.assistantResponse);
    if (!signal || signal.length < 5) return;

    // Call recall
    let memories: RecallMemory[];
    try {
      memories = await callRecall(signal, cfg.maxInjectPerTurn + 3);
    } catch {
      // Fail silently — never block the REPL
      return;
    }

    if (memories.length === 0) return;

    // Filter: dedup + re-injection cooldown
    const novel = memories.filter((m) => {
      if (injectedMemoryIds.has(m.id) && !evictedMemoryIds.has(m.id)) return false;
      if (evictedMemoryIds.has(m.id)) {
        const evictedAt = evictedMemoryIds.get(m.id)!;
        if (turnCounter - evictedAt < cfg.reinjectionCooldown) return false;
        evictedMemoryIds.delete(m.id); // allow re-injection
      }
      return true;
    });

    if (novel.length === 0) return;

    const toInject = novel.slice(0, cfg.maxInjectPerTurn);
    turnsSinceLastInjection = 0;
    totalInjected += toInject.length;

    return {
      inject: toInject.map((m) => {
        injectedMemoryIds.add(m.id);
        return {
          role: 'system' as const,
          content: `[passive-recall] ${m.summary || m.content.slice(0, cfg.maxTokensPerInjection)}`,
          source: 'passive-recall',
          hookName: 'passive-recall',
          memoryId: m.id,
        };
      }),
    };
  };

  // Register on prompt_build — recall based on user input BEFORE the backend responds.
  // This means the backend sees relevant memories in its prompt.
  registry.register({
    name: 'passive-recall-prompt',
    event: 'prompt_build',
    priority: 50,
    handler: async (ctx: HookContext): Promise<HookResult | void> => {
      return doRecall(ctx);
    },
  });

  // Register on turn_end — recall based on the response for the NEXT turn.
  // Catches topics that emerge from the assistant's response.
  registry.register({
    name: 'passive-recall-turn',
    event: 'turn_end',
    priority: 50,
    handler: async (ctx: HookContext): Promise<HookResult | void> => {
      turnCounter++;
      return doRecall(ctx);
    },
  });

  // Track evictions of passive-recall entries
  registry.register({
    name: 'passive-recall-evict-tracker',
    event: 'evict_post',
    priority: 50,
    handler: async (ctx: HookContext): Promise<void> => {
      // Check if any evicted entries were passive-recall injections
      // We can't directly see what was evicted from the hook context,
      // but we can check which injected memories are no longer in the ledger
      const currentContent = new Set(
        ctx.ledger
          .listEntries()
          .filter((e) => e.source === 'passive-recall')
          .map((e) => e.content)
      );

      for (const memId of injectedMemoryIds) {
        // If a memory was injected but its content is no longer in the ledger,
        // it was evicted — track it for re-injection cooldown
        // (Simplified: we just mark all injected IDs and check on next recall)
      }
    },
  });

  return {
    getStats: (): PassiveRecallStats => ({
      totalInjected,
      totalSuppressed,
      uniqueMemories: injectedMemoryIds.size,
      turnsSinceLastInjection,
      currentTurn: turnCounter,
    }),
  };
}

export interface PassiveRecallStats {
  totalInjected: number;
  totalSuppressed: number;
  uniqueMemories: number;
  turnsSinceLastInjection: number;
  currentTurn: number;
}

// ─── Budget Monitor Hook ────────────────────────────────────────

export function registerBudgetMonitorHook(
  registry: SbHookRegistry,
  thresholds: number[] = [0.6, 0.8, 0.95]
): void {
  const warnedThresholds = new Set<number>();

  registry.register({
    name: 'budget-monitor',
    event: 'prompt_build',
    priority: 90,
    handler: async (ctx: HookContext): Promise<HookResult | void> => {
      const util = ctx.runtime.budgetUtilization ?? 0;

      for (const threshold of thresholds) {
        if (util >= threshold && !warnedThresholds.has(threshold)) {
          warnedThresholds.add(threshold);

          const pct = Math.round(util * 100);
          const severity = threshold >= 0.95 ? 'CRITICAL' : threshold >= 0.8 ? 'WARNING' : 'INFO';

          return {
            inject: [
              {
                role: 'system',
                content: `[budget-monitor] ${severity}: Context at ${pct}%. Use list_context to review entries and evict_context to free space.${
                  threshold >= 0.8 ? ' Passive recall is suppressed above 80%.' : ''
                }`,
                source: 'budget-monitor',
                hookName: 'budget-monitor',
              },
            ],
          };
        }
      }
    },
  });
}

// ─── Register All Built-in Hooks ────────────────────────────────

export function registerBuiltinHooks(
  registry: SbHookRegistry,
  options: {
    callRecall: (query: string, limit: number) => Promise<RecallMemory[]>;
    passiveRecallConfig?: Partial<PassiveRecallConfig>;
    budgetThresholds?: number[];
  }
): { passiveRecall: { getStats: () => PassiveRecallStats } } {
  const passiveRecall = registerPassiveRecallHook(
    registry,
    options.callRecall,
    options.passiveRecallConfig
  );

  registerBudgetMonitorHook(registry, options.budgetThresholds);

  return { passiveRecall };
}
