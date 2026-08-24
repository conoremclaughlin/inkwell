import { describe, expect, it, vi } from 'vitest';
import { CloneRegistry, formatCloneLine, isSettled, type CloneRecord } from './clone-registry.js';

function seed(registry: CloneRegistry, label = 'audit auth paths') {
  const id = registry.nextId();
  return registry.register({
    id,
    label,
    prompt: 'Find every auth entry point.',
    parentSessionId: 'sess-1',
    transcriptPath: `/tmp/parent.${id}.jsonl`,
  });
}

describe('CloneRegistry', () => {
  it('registers a clone as running with a readable id', () => {
    const registry = new CloneRegistry();
    const record = seed(registry);

    expect(record.id).toBe('clone-1');
    expect(record.status).toBe('running');
    expect(record.iterations).toBe(0);
    expect(record.toolCalls).toBe(0);
    expect(registry.get('clone-1')).toEqual(record);
    expect(registry.runningCount).toBe(1);
  });

  it('hands out sequential ids', () => {
    const registry = new CloneRegistry();
    expect([seed(registry).id, seed(registry).id, seed(registry).id]).toEqual([
      'clone-1',
      'clone-2',
      'clone-3',
    ]);
  });

  it('keeps spawn order, which is how the parent thinks about them', () => {
    const registry = new CloneRegistry();
    seed(registry, 'first');
    seed(registry, 'second');
    seed(registry, 'third');
    expect(registry.list().map((r) => r.label)).toEqual(['first', 'second', 'third']);
  });

  it('stamps endedAt when a clone settles', () => {
    const registry = new CloneRegistry();
    seed(registry);

    const settled = registry.update('clone-1', { status: 'completed', summary: 'done' });
    expect(settled?.status).toBe('completed');
    expect(settled?.endedAt).toBeGreaterThanOrEqual(settled!.startedAt);
    expect(registry.runningCount).toBe(0);
  });

  it('refuses to resurrect a settled clone', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.update('clone-1', { status: 'completed', summary: 'done' });

    // A loop still unwinding must not overwrite the recorded outcome.
    registry.update('clone-1', { iterations: 99 });
    registry.update('clone-1', { status: 'running' });

    const record = registry.get('clone-1');
    expect(record?.status).toBe('completed');
    expect(record?.iterations).toBe(0);
    expect(record?.summary).toBe('done');
  });

  it('will not swap one terminal state for another', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.update('clone-1', { status: 'completed', summary: 'done' });

    // Terminal is terminal. An earlier version allowed this, and produced
    // incoherent records like {status:'completed', error:'cancelled'} when a
    // cancelled clone's loop finished unwinding.
    registry.update('clone-1', { status: 'aborted', error: 'cancelled' });
    const record = registry.get('clone-1');
    expect(record?.status).toBe('completed');
    expect(record?.summary).toBe('done');
    expect(record?.error).toBeUndefined();
  });

  it('reports progress while a clone is still running', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.update('clone-1', { iterations: 2, toolCalls: 7 });

    const record = registry.get('clone-1');
    expect(record?.status).toBe('running');
    expect(record?.iterations).toBe(2);
    expect(record?.toolCalls).toBe(7);
    expect(record?.endedAt).toBeUndefined();
  });

  it('filters by status', () => {
    const registry = new CloneRegistry();
    seed(registry, 'a');
    seed(registry, 'b');
    registry.update('clone-1', { status: 'completed' });

    expect(registry.list({ status: 'running' }).map((r) => r.id)).toEqual(['clone-2']);
    expect(registry.list({ status: 'settled' }).map((r) => r.id)).toEqual(['clone-1']);
  });

  it('notifies subscribers and can be unsubscribed', () => {
    const registry = new CloneRegistry();
    const seen: string[] = [];
    const unsubscribe = registry.onChange((c) => seen.push(`${c.kind}:${c.record.id}`));

    seed(registry);
    registry.update('clone-1', { iterations: 1 });
    registry.update('clone-1', { status: 'completed' });
    unsubscribe();
    seed(registry);

    expect(seen).toEqual(['registered:clone-1', 'updated:clone-1', 'settled:clone-1']);
  });

  it('survives a subscriber that throws', () => {
    const registry = new CloneRegistry();
    const good = vi.fn();
    registry.onChange(() => {
      throw new Error('TUI exploded');
    });
    registry.onChange(good);

    expect(() => seed(registry)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('ignores updates to an unknown clone', () => {
    const registry = new CloneRegistry();
    expect(registry.update('clone-99', { status: 'completed' })).toBeUndefined();
  });
});

describe('isSettled', () => {
  it('treats every non-running state as final', () => {
    expect(isSettled('running')).toBe(false);
    expect(isSettled('completed')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('aborted')).toBe(true);
  });
});

describe('formatCloneLine', () => {
  const base: CloneRecord = {
    id: 'clone-1',
    label: 'audit auth paths',
    prompt: 'p',
    status: 'running',
    transcriptPath: '/tmp/x.clone-1.jsonl',
    startedAt: Date.now() - 5000,
    iterations: 2,
    toolCalls: 7,
  };

  it('shows live progress while running', () => {
    const line = formatCloneLine(base);
    expect(line).toContain('🌀 clone-1 · audit auth paths');
    expect(line).toContain('2 turn(s), 7 tool call(s)');
  });

  it('shows the outcome once settled', () => {
    const line = formatCloneLine({
      ...base,
      status: 'completed',
      stopReason: 'terminal-signal',
      endedAt: base.startedAt + 12_000,
    });
    expect(line).toContain('✅ clone-1');
    expect(line).toContain('terminal-signal');
    expect(line).toContain('(12s)');
  });

  it('leads with the error when one exists', () => {
    const line = formatCloneLine({
      ...base,
      status: 'failed',
      error: 'backend backend-failure',
      endedAt: base.startedAt + 1000,
    });
    expect(line).toContain('⚠️');
    expect(line).toContain('backend backend-failure');
  });
});

describe('CloneRegistry cancellation', () => {
  it('asks a clone to stop without pretending it already has', () => {
    const registry = new CloneRegistry();
    seed(registry);
    let aborted = false;
    registry.attachCanceller('clone-1', () => {
      aborted = true;
    });

    expect(registry.cancel('clone-1')).toBe(true);
    expect(aborted).toBe(true);

    // Still counted as running: the backend child is alive until the loop
    // unwinds, and runningCount is what the concurrency ceiling reads. Freeing
    // the slot here would let a new fan-out overlap the one being cancelled.
    expect(registry.get('clone-1')?.status).toBe('running');
    expect(registry.get('clone-1')?.cancelRequested).toBe(true);
    expect(registry.runningCount).toBe(1);
  });

  it('settles a cancelled clone as aborted even when its loop reports success', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.attachCanceller('clone-1', () => {});
    registry.cancel('clone-1');

    // The race: cancel fires, then the still-unwinding loop writes its own
    // outcome. The user's decision outranks whatever the backend managed last.
    registry.update('clone-1', {
      status: 'completed',
      summary: 'late success',
      stopReason: 'terminal-signal',
    });

    const record = registry.get('clone-1');
    expect(record?.status).toBe('aborted');
    expect(record?.error).toBe('cancelled');
    expect(registry.runningCount).toBe(0);
  });

  it('settles a cancelled clone as aborted when its loop reports failure too', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.cancel('clone-1');
    registry.update('clone-1', { status: 'failed', error: 'backend backend-failure' });

    expect(registry.get('clone-1')?.status).toBe('aborted');
  });

  it('refuses to cancel an unknown or already-settled clone', () => {
    const registry = new CloneRegistry();
    seed(registry);
    registry.update('clone-1', { status: 'completed' });

    expect(registry.cancel('clone-1')).toBe(false);
    expect(registry.cancel('clone-99')).toBe(false);
    expect(registry.get('clone-1')?.status).toBe('completed');
  });

  it('cancels a clone that never registered a canceller', () => {
    const registry = new CloneRegistry();
    seed(registry);
    expect(registry.cancel('clone-1')).toBe(true);
    expect(registry.get('clone-1')?.cancelRequested).toBe(true);
  });

  it('stops everything still running and reports how many', () => {
    const registry = new CloneRegistry();
    seed(registry, 'a');
    seed(registry, 'b');
    seed(registry, 'c');
    const stopped: string[] = [];
    for (const id of ['clone-1', 'clone-2', 'clone-3']) {
      registry.attachCanceller(id, () => stopped.push(id));
    }
    registry.update('clone-2', { status: 'completed' });

    // The finished one is left alone; the other two are asked to stop. This is
    // the session-exit path — a live clone holds a backend child, which holds
    // Node.
    expect(registry.cancelAll()).toBe(2);
    expect(stopped).toEqual(['clone-1', 'clone-3']);
    expect(registry.get('clone-2')?.status).toBe('completed');

    // They stay counted as running until their loops unwind, so a second pass
    // still sees them — but the cancellers were consumed, so nothing re-fires.
    expect(registry.cancelAll()).toBe(2);
    expect(stopped).toEqual(['clone-1', 'clone-3']);

    // Once they settle, they are gone from the count and cancelling is a no-op.
    registry.update('clone-1', { status: 'completed' });
    registry.update('clone-3', { status: 'completed' });
    expect(registry.runningCount).toBe(0);
    expect(registry.cancelAll()).toBe(0);
    // Both settled as aborted, because cancellation was requested first.
    expect(registry.get('clone-1')?.status).toBe('aborted');
    expect(registry.get('clone-3')?.status).toBe('aborted');
  });

  it('releases the canceller once a clone settles on its own', () => {
    const registry = new CloneRegistry();
    seed(registry);
    let called = 0;
    registry.attachCanceller('clone-1', () => {
      called += 1;
    });
    registry.update('clone-1', { status: 'completed' });

    // Dropped rather than kept: a long session should not accumulate one
    // closure per clone it has ever run.
    expect(registry.cancel('clone-1')).toBe(false);
    expect(called).toBe(0);
  });
});
