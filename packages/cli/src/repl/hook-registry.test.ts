import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  SbHookRegistry,
  type SbHookEvent,
  type HookContext,
  type HookResult,
  type HookRuntimeState,
} from './hook-registry.js';

// ─── Test helpers ───────────────────────────────────────────────

function makeLedger(): ContextLedger {
  return new ContextLedger();
}

function makeRuntime(overrides?: Partial<HookRuntimeState>): HookRuntimeState {
  return {
    agentId: 'wren',
    backend: 'claude',
    turnCount: 0,
    ...overrides,
  };
}

function makeCtx(ledger?: ContextLedger, runtime?: HookRuntimeState): Omit<HookContext, 'event'> {
  return {
    ledger: ledger ?? makeLedger(),
    runtime: runtime ?? makeRuntime(),
  };
}

// ─── Registration ───────────────────────────────────────────────

describe('SbHookRegistry: registration', () => {
  it('registers and lists hooks', () => {
    const registry = new SbHookRegistry();
    registry.register({
      name: 'test-hook',
      event: 'turn_end',
      handler: async () => {},
    });

    const hooks = registry.listHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual({
      name: 'test-hook',
      event: 'turn_end',
      priority: 100,
    });
  });

  it('unregisters hooks by name', () => {
    const registry = new SbHookRegistry();
    registry.register({ name: 'a', event: 'turn_end', handler: async () => {} });
    registry.register({ name: 'b', event: 'turn_end', handler: async () => {} });

    expect(registry.unregister('a')).toBe(true);
    expect(registry.listHooks()).toHaveLength(1);
    expect(registry.listHooks()[0].name).toBe('b');
  });

  it('returns false when unregistering non-existent hook', () => {
    const registry = new SbHookRegistry();
    expect(registry.unregister('ghost')).toBe(false);
  });

  it('sorts by priority (lower first)', () => {
    const registry = new SbHookRegistry();
    registry.register({ name: 'low', event: 'turn_end', priority: 50, handler: async () => {} });
    registry.register({
      name: 'high',
      event: 'turn_end',
      priority: 200,
      handler: async () => {},
    });
    registry.register({ name: 'default', event: 'turn_end', handler: async () => {} }); // 100

    const names = registry.listHooks().map((h) => h.name);
    expect(names).toEqual(['low', 'default', 'high']);
  });
});

// ─── Firing ─────────────────────────────────────────────────────

describe('SbHookRegistry: fire', () => {
  it('fires hooks matching the event', async () => {
    const registry = new SbHookRegistry();
    const calls: string[] = [];

    registry.register({
      name: 'turn-hook',
      event: 'turn_end',
      handler: async () => {
        calls.push('turn');
      },
    });
    registry.register({
      name: 'prompt-hook',
      event: 'prompt_build',
      handler: async () => {
        calls.push('prompt');
      },
    });

    await registry.fire('turn_end', makeCtx());
    expect(calls).toEqual(['turn']);
  });

  it('fires hooks in priority order', async () => {
    const registry = new SbHookRegistry();
    const order: number[] = [];

    registry.register({
      name: 'last',
      event: 'turn_end',
      priority: 200,
      handler: async () => {
        order.push(200);
      },
    });
    registry.register({
      name: 'first',
      event: 'turn_end',
      priority: 10,
      handler: async () => {
        order.push(10);
      },
    });
    registry.register({
      name: 'middle',
      event: 'turn_end',
      priority: 100,
      handler: async () => {
        order.push(100);
      },
    });

    await registry.fire('turn_end', makeCtx());
    expect(order).toEqual([10, 100, 200]);
  });

  it('returns zero counts when no hooks match', async () => {
    const registry = new SbHookRegistry();
    const result = await registry.fire('turn_end', makeCtx());
    expect(result).toEqual({ injected: 0, evicted: 0, blocked: false });
  });

  it('records fire log entries', async () => {
    const registry = new SbHookRegistry();
    registry.register({
      name: 'logger',
      event: 'turn_end',
      handler: async () => {},
    });

    await registry.fire('turn_end', makeCtx());

    const log = registry.getFireLog();
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('turn_end');
    expect(log[0].hookName).toBe('logger');
  });
});

// ─── Context injection ──────────────────────────────────────────

describe('SbHookRegistry: injection', () => {
  it('injects entries into the ledger', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();
    ledger.addEntry('user', 'hello');

    registry.register({
      name: 'recall',
      event: 'turn_end',
      handler: async (): Promise<HookResult> => ({
        inject: [
          {
            role: 'system',
            content: 'Relevant memory: session routing gotcha...',
            source: 'passive-recall',
            hookName: 'recall',
            memoryId: 'mem-123',
            score: 0.85,
          },
        ],
      }),
    });

    const result = await registry.fire('turn_end', makeCtx(ledger));
    expect(result.injected).toBe(1);

    const entries = ledger.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].source).toBe('passive-recall');
    expect(entries[1].content).toContain('session routing');
  });

  it('supports multiple injections per hook', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();

    registry.register({
      name: 'multi-recall',
      event: 'turn_end',
      handler: async (): Promise<HookResult> => ({
        inject: [
          { role: 'system', content: 'Memory A', source: 'passive-recall' },
          { role: 'system', content: 'Memory B', source: 'passive-recall' },
        ],
      }),
    });

    const result = await registry.fire('turn_end', makeCtx(ledger));
    expect(result.injected).toBe(2);
    expect(ledger.listEntries()).toHaveLength(2);
  });

  it('later hooks see earlier injections', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();
    let entriesSeenBySecondHook = 0;

    registry.register({
      name: 'injector',
      event: 'turn_end',
      priority: 10,
      handler: async (): Promise<HookResult> => ({
        inject: [{ role: 'system', content: 'injected', source: 'test' }],
      }),
    });

    registry.register({
      name: 'observer',
      event: 'turn_end',
      priority: 20,
      handler: async (ctx) => {
        entriesSeenBySecondHook = ctx.ledger.listEntries().length;
      },
    });

    await registry.fire('turn_end', makeCtx(ledger));
    expect(entriesSeenBySecondHook).toBe(1); // sees the injection from first hook
  });
});

// ─── Eviction via hooks ─────────────────────────────────────────

describe('SbHookRegistry: eviction', () => {
  it('evicts entries specified by hook', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();
    const e1 = ledger.addEntry('inbox', 'stale message', 'pcp-inbox');
    ledger.addEntry('user', 'keep this');

    registry.register({
      name: 'cleanup',
      event: 'turn_end',
      handler: async (): Promise<HookResult> => ({
        evict: [e1.id],
      }),
    });

    const result = await registry.fire('turn_end', makeCtx(ledger));
    expect(result.evicted).toBe(1);
    expect(ledger.listEntries()).toHaveLength(1);
    expect(ledger.listEntries()[0].content).toBe('keep this');
  });

  it('inject + evict in same hook', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();
    const old = ledger.addEntry('system', 'old bootstrap', 'bootstrap');

    registry.register({
      name: 'refresh',
      event: 'session_start',
      handler: async (): Promise<HookResult> => ({
        evict: [old.id],
        inject: [{ role: 'system', content: 'fresh bootstrap', source: 'bootstrap' }],
      }),
    });

    const result = await registry.fire('session_start', makeCtx(ledger));
    expect(result.injected).toBe(1);
    expect(result.evicted).toBe(1);
    expect(ledger.listEntries()).toHaveLength(1);
    expect(ledger.listEntries()[0].content).toBe('fresh bootstrap');
  });
});

// ─── Blocking (pre-* events only) ──────────────────────────────

describe('SbHookRegistry: blocking', () => {
  it('blocks pipeline on pre-tool event', async () => {
    const registry = new SbHookRegistry();

    registry.register({
      name: 'guard',
      event: 'tool_pre',
      handler: async (): Promise<HookResult> => ({
        block: true,
        blockReason: 'Tool not allowed in current context',
      }),
    });

    const result = await registry.fire('tool_pre', makeCtx());
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('not allowed');
  });

  it('does NOT block on non-pre events even if hook requests it', async () => {
    const registry = new SbHookRegistry();

    registry.register({
      name: 'bad-blocker',
      event: 'turn_end',
      handler: async (): Promise<HookResult> => ({
        block: true,
        blockReason: 'Should be ignored',
      }),
    });

    const result = await registry.fire('turn_end', makeCtx());
    expect(result.blocked).toBe(false);
  });

  it('stops executing remaining hooks after block', async () => {
    const registry = new SbHookRegistry();
    const calls: string[] = [];

    registry.register({
      name: 'blocker',
      event: 'compact_pre',
      priority: 10,
      handler: async (): Promise<HookResult> => {
        calls.push('blocker');
        return { block: true, blockReason: 'Stop' };
      },
    });

    registry.register({
      name: 'after-blocker',
      event: 'compact_pre',
      priority: 20,
      handler: async () => {
        calls.push('after');
      },
    });

    await registry.fire('compact_pre', makeCtx());
    expect(calls).toEqual(['blocker']); // second hook never ran
  });
});

// ─── Error resilience ───────────────────────────────────────────

describe('SbHookRegistry: error handling', () => {
  it('continues after a hook throws', async () => {
    const registry = new SbHookRegistry();
    const calls: string[] = [];

    // Suppress console.warn in test
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.register({
      name: 'crasher',
      event: 'turn_end',
      priority: 10,
      handler: async () => {
        throw new Error('boom');
      },
    });

    registry.register({
      name: 'survivor',
      event: 'turn_end',
      priority: 20,
      handler: async () => {
        calls.push('survived');
      },
    });

    const result = await registry.fire('turn_end', makeCtx());
    expect(calls).toEqual(['survived']);
    expect(result.blocked).toBe(false);

    warnSpy.mockRestore();
  });

  it('handles hooks returning undefined gracefully', async () => {
    const registry = new SbHookRegistry();

    registry.register({
      name: 'noop',
      event: 'turn_end',
      handler: async () => undefined,
    });

    const result = await registry.fire('turn_end', makeCtx());
    expect(result).toEqual({ injected: 0, evicted: 0, blocked: false });
  });
});

// ─── Passive recall simulation ──────────────────────────────────

describe('Passive recall: simulated integration', () => {
  it('injects relevant memories on topic shift', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();

    // Simulate a conversation about session routing
    ledger.addEntry('user', 'How does session routing work for triggered agents?');
    ledger.addEntry('assistant', 'When an agent is triggered via send_to_inbox...');

    // Mock passive recall hook — would normally call PCP recall()
    const mockMemories = [
      {
        id: 'mem-abc',
        content: 'backendSessionId collision between agents sharing the same worktree',
        score: 0.82,
      },
      {
        id: 'mem-def',
        content: 'Myra session continuity breaks when context compaction drops tool schemas',
        score: 0.71,
      },
    ];

    const injectedIds = new Set<string>();
    const COOLDOWN = 3;
    let turnsSinceLastInjection = COOLDOWN; // allow first injection

    registry.register({
      name: 'passive-recall',
      event: 'turn_end',
      handler: async (ctx): Promise<HookResult | void> => {
        // Budget ceiling check
        if ((ctx.runtime.budgetUtilization ?? 0) > 0.8) return;

        // Cooldown check
        if (turnsSinceLastInjection < COOLDOWN) {
          turnsSinceLastInjection++;
          return;
        }

        // Filter already-injected
        const novel = mockMemories.filter((m) => !injectedIds.has(m.id));
        if (novel.length === 0) return;

        // Inject top 2
        const toInject = novel.slice(0, 2);
        turnsSinceLastInjection = 0;

        return {
          inject: toInject.map((m) => {
            injectedIds.add(m.id);
            return {
              role: 'system' as const,
              content: `Relevant memory (score: ${m.score}): ${m.content}`,
              source: 'passive-recall',
              hookName: 'passive-recall',
              memoryId: m.id,
              score: m.score,
            };
          }),
        };
      },
    });

    // First turn — should inject
    const r1 = await registry.fire('turn_end', makeCtx(ledger, makeRuntime({ turnCount: 1 })));
    expect(r1.injected).toBe(2);
    expect(ledger.listEntries()).toHaveLength(4); // 2 original + 2 injected

    // Verify injected content
    const injected = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(injected).toHaveLength(2);
    expect(injected[0].content).toContain('backendSessionId collision');
    expect(injected[1].content).toContain('Myra session continuity');

    // Second turn (within cooldown) — should NOT inject
    const r2 = await registry.fire('turn_end', makeCtx(ledger, makeRuntime({ turnCount: 2 })));
    expect(r2.injected).toBe(0);

    // After cooldown — but memories already injected, so nothing new
    turnsSinceLastInjection = COOLDOWN;
    const r3 = await registry.fire('turn_end', makeCtx(ledger, makeRuntime({ turnCount: 5 })));
    expect(r3.injected).toBe(0); // dedup prevents re-injection
  });

  it('suppresses injection above budget ceiling', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();

    registry.register({
      name: 'passive-recall',
      event: 'turn_end',
      handler: async (ctx): Promise<HookResult | void> => {
        if ((ctx.runtime.budgetUtilization ?? 0) > 0.8) return;
        return {
          inject: [{ role: 'system', content: 'A memory', source: 'passive-recall' }],
        };
      },
    });

    // At 50% budget — inject
    const r1 = await registry.fire(
      'turn_end',
      makeCtx(ledger, makeRuntime({ budgetUtilization: 0.5 }))
    );
    expect(r1.injected).toBe(1);

    // At 85% budget — suppress
    const r2 = await registry.fire(
      'turn_end',
      makeCtx(ledger, makeRuntime({ budgetUtilization: 0.85 }))
    );
    expect(r2.injected).toBe(0);
  });

  it('evicted memories can be re-injected after cooldown', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();

    const evictedIds = new Set<string>();
    const injectedIds = new Set<string>();
    let turnsSinceEviction = 0;
    const REINJECTION_COOLDOWN = 5;

    registry.register({
      name: 'passive-recall-with-reinject',
      event: 'turn_end',
      handler: async (): Promise<HookResult | void> => {
        const memId = 'mem-xyz';
        const content = 'Important routing detail';

        // Allow re-injection if evicted AND cooldown passed
        if (injectedIds.has(memId) && !evictedIds.has(memId)) return;
        if (evictedIds.has(memId) && turnsSinceEviction < REINJECTION_COOLDOWN) return;

        injectedIds.add(memId);
        evictedIds.delete(memId);

        return {
          inject: [
            {
              role: 'system',
              content,
              source: 'passive-recall',
              memoryId: memId,
            },
          ],
        };
      },
    });

    // First injection
    const r1 = await registry.fire('turn_end', makeCtx(ledger));
    expect(r1.injected).toBe(1);
    const injectedEntry = ledger.listEntries()[0];

    // Evict it (simulating budget pressure)
    ledger.evictEntries([injectedEntry.id]);
    evictedIds.add('mem-xyz');
    expect(ledger.listEntries()).toHaveLength(0);

    // Try re-injection too soon
    turnsSinceEviction = 2;
    const r2 = await registry.fire('turn_end', makeCtx(ledger));
    expect(r2.injected).toBe(0);

    // Re-injection after cooldown
    turnsSinceEviction = REINJECTION_COOLDOWN;
    const r3 = await registry.fire('turn_end', makeCtx(ledger));
    expect(r3.injected).toBe(1);
    expect(ledger.listEntries()[0].content).toBe('Important routing detail');
  });
});

// ─── Budget monitor simulation ──────────────────────────────────

describe('Budget monitor: simulated integration', () => {
  it('injects warning at 80% threshold', async () => {
    const registry = new SbHookRegistry();
    const ledger = makeLedger();
    let lastWarningLevel: number | null = null;

    registry.register({
      name: 'budget-monitor',
      event: 'prompt_build',
      handler: async (ctx): Promise<HookResult | void> => {
        const util = ctx.runtime.budgetUtilization ?? 0;
        if (util >= 0.8 && lastWarningLevel !== 80) {
          lastWarningLevel = 80;
          return {
            inject: [
              {
                role: 'system',
                content: `Context budget at ${Math.round(util * 100)}%. Consider using list_context and evict_context to free space.`,
                source: 'budget-monitor',
              },
            ],
          };
        }
      },
    });

    // Below threshold — no warning
    const r1 = await registry.fire(
      'prompt_build',
      makeCtx(ledger, makeRuntime({ budgetUtilization: 0.6 }))
    );
    expect(r1.injected).toBe(0);

    // At threshold — warning injected
    const r2 = await registry.fire(
      'prompt_build',
      makeCtx(ledger, makeRuntime({ budgetUtilization: 0.82 }))
    );
    expect(r2.injected).toBe(1);
    expect(ledger.listEntries()[0].content).toContain('82%');

    // Same threshold — no duplicate warning
    const r3 = await registry.fire(
      'prompt_build',
      makeCtx(ledger, makeRuntime({ budgetUtilization: 0.85 }))
    );
    expect(r3.injected).toBe(0);
  });
});
