import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { SbHookRegistry } from './hook-registry.js';
import { registerBuiltinHooks } from './builtin-hooks.js';

const memory = (id: string) => ({ id, content: `fixture ${id}`, summary: null, topics: [] });

function session(callRecall = vi.fn(async () => [memory('shared-id')]), cooldownTurns = 0) {
  const ledger = new ContextLedger();
  const hooks = new SbHookRegistry();
  const { passiveRecall } = registerBuiltinHooks(hooks, {
    callRecall,
    passiveRecallConfig: { cooldownTurns },
    budgetThresholds: [0.8],
  });
  const ctx = {
    ledger,
    runtime: { turnCount: 0, budgetUtilization: 0 },
    lastTurn: { userInput: 'fixture session routing', assistantResponse: '', turnIndex: 0 },
  };
  return { ledger, hooks, passiveRecall, ctx, callRecall };
}

describe('built-in hooks: actual implementation, fake recall only', () => {
  it('one pending recall does not block or inject into another session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = session(
      vi.fn(async () => {
        await gate;
        return [memory('a')];
      })
    );
    const b = session(vi.fn(async () => [memory('b')]));
    const pending = a.hooks.fire('prompt_build', a.ctx);
    await b.hooks.fire('prompt_build', b.ctx);
    expect(a.ledger.listEntries()).toEqual([]);
    expect(b.ledger.listEntries().map((e) => e.content)).toEqual(['[passive-recall] fixture b']);
    release();
    await pending;
    expect(a.ledger.listEntries().map((e) => e.content)).toEqual(['[passive-recall] fixture a']);
    expect(b.passiveRecall.getStats().totalInjected).toBe(1);
  });

  it('bootstrap dedup belongs to one session even when both receive the same memory ID', async () => {
    const a = session();
    const b = session();
    a.passiveRecall.seedBootstrapIds(['shared-id']);
    await Promise.all([a.hooks.fire('prompt_build', a.ctx), b.hooks.fire('prompt_build', b.ctx)]);
    expect(a.ledger.listEntries()).toEqual([]);
    expect(b.ledger.listEntries()).toHaveLength(1);
    expect(a.passiveRecall.getStats().totalInjected).toBe(0);
    expect(b.passiveRecall.getStats().totalInjected).toBe(1);
  });

  it('applies dedup across prompt/turn hooks and counts turns independently', async () => {
    const a = session();
    const b = session();
    await a.hooks.fire('prompt_build', a.ctx);
    await a.hooks.fire('turn_end', a.ctx);
    expect(a.callRecall).toHaveBeenCalledTimes(2);
    expect(a.ledger.listEntries()).toHaveLength(1);
    expect(a.passiveRecall.getStats().currentTurn).toBe(1);
    expect(b.passiveRecall.getStats().currentTurn).toBe(0);
  });

  it('preserves recall cooldown, including empty successful recall', async () => {
    const a = session(
      vi.fn(async () => []),
      2
    );
    await a.hooks.fire('prompt_build', a.ctx);
    await a.hooks.fire('turn_end', a.ctx);
    await a.hooks.fire('prompt_build', a.ctx);
    expect(a.callRecall).toHaveBeenCalledTimes(1);
    await a.hooks.fire('turn_end', a.ctx);
    expect(a.callRecall).toHaveBeenCalledTimes(2);
  });

  it('budget suppression and once-per-threshold warnings do not leak across sessions', async () => {
    const a = session();
    const b = session();
    a.ctx.runtime.budgetUtilization = 0.9;
    b.ctx.runtime.budgetUtilization = 0.9;
    await a.hooks.fire('prompt_build', a.ctx);
    await a.hooks.fire('prompt_build', a.ctx);
    await b.hooks.fire('prompt_build', b.ctx);
    expect(a.callRecall).not.toHaveBeenCalled();
    expect(b.callRecall).not.toHaveBeenCalled();
    expect(a.passiveRecall.getStats().totalSuppressed).toBe(2);
    expect(b.passiveRecall.getStats().totalSuppressed).toBe(1);
    for (const s of [a, b]) {
      expect(s.ledger.listEntries()).toHaveLength(1);
      expect(s.ledger.listEntries()[0].source).toBe('budget-monitor');
    }
  });

  it('recall failure does not prevent the next registered hook from running', async () => {
    const a = session(
      vi.fn(async () => {
        throw new Error('fixture unavailable');
      })
    );
    const after = vi.fn(async () => {});
    a.hooks.register({ name: 'after', event: 'prompt_build', handler: after });
    await a.hooks.fire('prompt_build', a.ctx);
    expect(after).toHaveBeenCalledOnce();
    expect(a.ledger.listEntries()).toEqual([]);
  });

  it('characterizes the existing eviction-tracker gap: removed memory stays deduplicated', async () => {
    const a = session();
    await a.hooks.fire('prompt_build', a.ctx);
    a.ledger.evictBySource('passive-recall');
    await a.hooks.fire('evict_post', a.ctx);
    // The production tracker currently never populates evictedMemoryIds.
    // This is baseline evidence, NOT a requirement to keep the defect forever.
    for (let i = 0; i < 12; i++) await a.hooks.fire('turn_end', a.ctx);
    expect(a.callRecall).toHaveBeenCalledTimes(13);
    expect(a.ledger.listEntries()).toEqual([]);
  });
});
