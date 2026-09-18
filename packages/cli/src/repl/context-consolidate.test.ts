/**
 * Ref-selected consolidation: `compact_context` given a named set instead of
 * an age cutoff (task 44f2783e).
 *
 * The case that drove the design is the one asserted hardest below — a set that
 * starts MID-ledger. The oldest-N path removes a prefix, so its summary is
 * always entry 0, and both the transcript event and its hydration had that
 * baked in. A named set does not have to be a prefix, and a summary written at
 * the front on reattach would give the reattached session the same entries in a
 * different order than it held live.
 */
import { describe, it, expect } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { runCompaction, type CompactionDeps } from './compaction.js';
import { parseCompactContextArgs } from './context-tools.js';

function deps(ledger: ContextLedger, persisted: Record<string, unknown>[]): CompactionDeps {
  return {
    ledger,
    keepRecentDefault: 2,
    summarize: async () => ({ text: 'RUNTIME SUMMARY' }),
    persist: (event) => {
      persisted.push(event);
    },
    recordUsage: () => {},
    log: () => {},
  };
}

/** A ledger of entries big enough that a short summary genuinely shrinks it. */
function seed(ledger: ContextLedger, labels: string[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const label of labels) {
    const entry = ledger.addEntry('user', `${label} ${'x'.repeat(400)}`);
    refs.set(label, ledger.summarizeEntries().find((e) => e.id === entry.id)!.ref);
  }
  return refs;
}

describe('parseCompactContextArgs — refs', () => {
  it('accepts a ref list', () => {
    expect(parseCompactContextArgs({ refs: ['sha1:aaa', 'sha1:bbb'] })).toEqual({
      refs: ['sha1:aaa', 'sha1:bbb'],
    });
  });

  it('refuses refs together with keepRecent — they are alternative selectors', () => {
    const out = parseCompactContextArgs({ refs: ['sha1:aaa'], keepRecent: 5 });
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toMatch(/alternative selectors/);
  });

  it('refuses an empty ref list rather than silently compacting the oldest', () => {
    const out = parseCompactContextArgs({ refs: [] });
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toMatch(/omit it to compact the oldest/);
  });

  it('refuses a non-string ref instead of dropping it', () => {
    expect(parseCompactContextArgs({ refs: ['sha1:aaa', 7] })).toHaveProperty('error');
  });
});

describe('runCompaction with a named set', () => {
  it('removes exactly the named entries and leaves the rest in place', async () => {
    const ledger = new ContextLedger();
    const refs = seed(ledger, ['A', 'B', 'C', 'D']);
    const ids = ledger.findEntriesByRefs([{ hash: refs.get('B')! }, { hash: refs.get('C')! }]);
    const persisted: Record<string, unknown>[] = [];

    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 'BC done', entryIds: ids },
      deps(ledger, persisted)
    );

    expect(outcome.ok).toBe(true);
    const order = ledger.listEntries().map((e) => e.content.slice(0, 1));
    // A survives before the summary, D survives after it.
    expect(order).toEqual(['A', '[', 'D']);
    expect(ledger.listEntries()[1].content).toContain('BC done');
  });

  it('reports the summary position, and the persisted event carries the same one', async () => {
    const ledger = new ContextLedger();
    const refs = seed(ledger, ['A', 'B', 'C', 'D']);
    const ids = ledger.findEntriesByRefs([{ hash: refs.get('C')! }]);
    const persisted: Record<string, unknown>[] = [];

    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 'C done', entryIds: ids },
      deps(ledger, persisted)
    );

    expect(outcome.ok).toBe(true);
    // C is the third entry; A and B survive before it.
    expect(outcome.ok && outcome.summaryIndex).toBe(2);
    // The event is written BEFORE the mutation, so its index is computed
    // separately from the ledger's. They must agree, or reattach reorders.
    expect(persisted[0].summaryIndex).toBe(2);
    expect(ledger.listEntries()[2].content).toContain('C done');
  });

  it('an oldest-N compaction still records index 0 — the legacy shape is unchanged', async () => {
    const ledger = new ContextLedger();
    seed(ledger, ['A', 'B', 'C', 'D']);
    const persisted: Record<string, unknown>[] = [];

    const outcome = await runCompaction(
      { reason: 'test', actor: 'system', summaryText: 'old stuff', keepRecent: 2 },
      deps(ledger, persisted)
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summaryIndex).toBe(0);
    expect(persisted[0].summaryIndex).toBe(0);
    expect(ledger.listEntries()[0].content).toContain('old stuff');
  });

  it('refuses a set whose summary is not smaller than what it replaces', async () => {
    const ledger = new ContextLedger();
    const small = ledger.addEntry('user', 'tiny');
    const persisted: Record<string, unknown>[] = [];

    const outcome = await runCompaction(
      {
        reason: 'test',
        actor: 'sb',
        summaryText: 'a summary very much longer than the entry it claims to replace'.repeat(5),
        entryIds: [small.id],
      },
      deps(ledger, persisted)
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/not smaller/);
    // Refused means untouched — the entry is still there and nothing persisted.
    expect(ledger.listEntries()).toHaveLength(1);
    expect(persisted).toHaveLength(0);
  });

  it('refuses when no named entry is in the ledger any more', async () => {
    const ledger = new ContextLedger();
    seed(ledger, ['A']);
    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 's', entryIds: [9999] },
      deps(ledger, [])
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/none of those refs match/);
  });

  it('a failed persist leaves the ledger untouched', async () => {
    const ledger = new ContextLedger();
    const refs = seed(ledger, ['A', 'B', 'C']);
    const ids = ledger.findEntriesByRefs([{ hash: refs.get('B')! }]);
    const before = ledger.listEntries().map((e) => e.content);

    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 'B done', entryIds: ids },
      {
        ...deps(ledger, []),
        persist: () => {
          throw new Error('disk full');
        },
      }
    );

    expect(outcome.ok).toBe(false);
    expect(ledger.listEntries().map((e) => e.content)).toEqual(before);
  });

  it('entries appended while the summarizer runs survive and do not shift the set', async () => {
    const ledger = new ContextLedger();
    const refs = seed(ledger, ['A', 'B', 'C']);
    const ids = ledger.findEntriesByRefs([{ hash: refs.get('A')! }, { hash: refs.get('B')! }]);
    const persisted: Record<string, unknown>[] = [];

    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', entryIds: ids },
      {
        ...deps(ledger, persisted),
        summarize: async () => {
          // An inbox poll lands mid-summarization.
          ledger.addEntry('inbox', 'LATE arrival');
          return { text: 'AB done' };
        },
      }
    );

    expect(outcome.ok).toBe(true);
    const order = ledger.listEntries().map((e) => e.content.slice(0, 4));
    // The summary took A's place; C and the late arrival both survive.
    expect(order[0]).toContain('[Con');
    expect(order.some((c) => c.startsWith('LATE'))).toBe(true);
    expect(order.some((c) => c.startsWith('C '))).toBe(true);
  });

  it('names the set as consolidated, not as "earlier" entries', async () => {
    const ledger = new ContextLedger();
    const refs = seed(ledger, ['A', 'B', 'C']);
    const ids = ledger.findEntriesByRefs([{ hash: refs.get('C')! }]);
    const outcome = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 'C done', entryIds: ids },
      deps(ledger, [])
    );
    expect(outcome.ok).toBe(true);
    const summary = ledger.listEntries()[2].content;
    expect(summary).toContain('consolidated 1 selected entries');
    expect(summary).not.toContain('earlier');
  });
});
