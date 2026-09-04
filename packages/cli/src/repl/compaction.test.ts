import { describe, it, expect, vi } from 'vitest';
import { ContextLedger, estimateTokens } from './context-ledger.js';
import { runCompaction, type CompactionDeps } from './compaction.js';

/**
 * The host boundaries Lumen asked to see executed rather than inspected
 * (PR #578 rounds 2–3): a cancelled summarizer, its usage, and a marker that
 * cannot be persisted.
 */
function ledgerOf(n: number, content = (i: number) => `entry ${i} ${'x'.repeat(200)}`) {
  const ledger = new ContextLedger();
  for (let i = 0; i < n; i++) ledger.addEntry(i % 2 ? 'assistant' : 'user', content(i), 'repl');
  return ledger;
}

function deps(
  ledger: ContextLedger,
  over: Partial<CompactionDeps> = {}
): CompactionDeps & {
  persisted: Record<string, unknown>[];
  usage: unknown[];
  logs: string[];
} {
  const persisted: Record<string, unknown>[] = [];
  const usage: unknown[] = [];
  const logs: string[] = [];
  return {
    ledger,
    keepRecentDefault: 12,
    summarize: async () => ({ text: 'dense brief', usage: { backend: 'claude', source: 'json' } }),
    persist: (e) => {
      persisted.push(e);
    },
    recordUsage: (u) => {
      usage.push(u);
    },
    log: (l) => {
      logs.push(l);
    },
    ...over,
    persisted,
    usage,
    logs,
  };
}

describe('runCompaction', () => {
  it("REGRESSION (Lumen, round 2): an append during summarization survives and the accounting is the operation's own", async () => {
    const ledger = ledgerOf(13);
    const removedTokens = ledger.listEntries()[0]!.approxTokens;
    let late: number | undefined;
    const d = deps(ledger, {
      summarize: async () => {
        late = ledger.addEntry(
          'inbox',
          'arrived during summarization ' + 'y'.repeat(2_000),
          'inkmail'
        ).id;
        return { text: 'brief' };
      },
    });
    const out = await runCompaction({ reason: 'test', actor: 'system' }, d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const summaryTokens = estimateTokens(
      '[Conversation summary — compacted 1 earlier entries]\nbrief'
    );
    expect(out.freedTokens).toBe(removedTokens - summaryTokens);
    expect(out.freedTokens).toBeGreaterThan(0);
    // `before` is the live pre-mutation total — the late entry is in it, as it
    // is in totalAfter — so before − totalAfter equals what was actually freed.
    expect(out.before - out.totalAfter).toBe(out.freedTokens);
    expect(ledger.listEntries().map((e) => e.id)).toContain(late);
    expect(ledger.listEntries()).toHaveLength(14);
  });

  it('cancellation aborts the summarizer, records its usage, and leaves the ledger and marker untouched', async () => {
    const ledger = ledgerOf(13);
    const snapshot = ledger.listEntries().map((e) => e.id);
    const controller = new AbortController();
    const seen: { aborted?: boolean } = {};
    const d = deps(ledger, {
      summarize: (_chunk, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            seen.aborted = true;
            resolve({
              text: '',
              usage: { backend: 'claude', source: 'json', inputTokens: 42 },
              error: 'aborted',
            });
          });
          controller.abort();
        }),
    });
    const out = await runCompaction({ reason: 'test', actor: 'sb', signal: controller.signal }, d);
    expect(seen.aborted).toBe(true);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('cancelled');
    expect(d.usage).toEqual([{ backend: 'claude', source: 'json', inputTokens: 42 }]);
    expect(d.persisted).toHaveLength(0);
    expect(ledger.listEntries().map((e) => e.id)).toEqual(snapshot);
  });

  it('a summarizer that fails still has its usage recorded; an agent is told, the system hard-trims', async () => {
    const failing = async () => ({
      text: '',
      usage: { backend: 'claude', source: 'json', outputTokens: 7 },
      error: 'boom',
    });
    const agent = deps(ledgerOf(13), { summarize: failing });
    const a = await runCompaction({ reason: 'test', actor: 'sb' }, agent);
    expect(a.ok).toBe(false);
    expect(agent.usage[0]).toMatchObject({ outputTokens: 7 });
    if (!a.ok) expect(a.error).toContain('pass your own summary');

    const hardTrim = vi.fn(async () => ({ removed: 3 }));
    const system = deps(ledgerOf(13), { summarize: failing, hardTrim });
    const s = await runCompaction({ reason: 'auto', actor: 'system' }, system);
    expect(s.ok).toBe(false);
    expect(hardTrim).toHaveBeenCalledTimes(1);
    if (!s.ok) expect(s.hardTrimmed).toBe(3);
  });

  it('REGRESSION (Lumen, round 4): a summarizer that REJECTS is a failure on the same actor split', async () => {
    const rejecting = async () => {
      throw new Error('spawn exploded');
    };
    const agent = deps(ledgerOf(13), { summarize: rejecting });
    const a = await runCompaction({ reason: 'test', actor: 'sb' }, agent);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.error).toContain('spawn exploded');
      expect(a.error).toContain('pass your own summary');
    }
    expect(agent.persisted).toHaveLength(0);
    expect(agent.ledger.listEntries()).toHaveLength(13);

    const hardTrim = vi.fn(async () => ({ removed: 2 }));
    const system = deps(ledgerOf(13), { summarize: rejecting, hardTrim });
    const s = await runCompaction({ reason: 'auto', actor: 'system' }, system);
    expect(s.ok).toBe(false);
    expect(hardTrim).toHaveBeenCalledTimes(1);
    if (!s.ok) expect(s.hardTrimmed).toBe(2);
  });

  it('a marker that cannot be persisted leaves the ledger unchanged and says so', async () => {
    const ledger = ledgerOf(13);
    const snapshot = ledger.listEntries().map((e) => e.content);
    const d = deps(ledger, {
      persist: () => {
        throw new Error('disk full');
      },
    });
    const out = await runCompaction({ reason: 'test', actor: 'sb', summaryText: 'brief' }, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('could not persist the compaction marker');
    expect(out.error).toContain('disk full');
    expect(ledger.listEntries().map((e) => e.content)).toEqual(snapshot);
  });

  it('persists the complete new start state BEFORE mutating the ledger', async () => {
    const ledger = ledgerOf(13);
    let firstAtPersist = '';
    const events: Record<string, unknown>[] = [];
    const d = deps(ledger, {
      persist: (e) => {
        // The ledger is still the OLD state while the marker is written.
        firstAtPersist = ledger.listEntries()[0]!.content;
        events.push(e);
      },
    });
    const out = await runCompaction({ reason: 'test', actor: 'sb', summaryText: 'brief' }, d);
    expect(out.ok).toBe(true);
    expect(firstAtPersist).toContain('entry 0');
    expect(ledger.listEntries()).toHaveLength(13); // 13 − 1 + summary
    expect(ledger.listEntries()[0]!.content).toContain('written by the agent');
    expect(events[0]).toMatchObject({ type: 'compaction', actor: 'sb', removedCount: 1 });
    expect((events[0]!.keptEntries as unknown[]).length).toBe(12);
  });

  it('refuses a summary that does not shrink the window, with the numbers', async () => {
    const ledger = ledgerOf(13, (i) => `e${i}`); // one-token entries
    const d = deps(ledger);
    const out = await runCompaction(
      { reason: 'test', actor: 'sb', summaryText: 'z'.repeat(5_000) },
      d
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('refused');
    expect(d.persisted).toHaveLength(0);
    expect(ledger.listEntries()).toHaveLength(13);
  });

  it('nothing to compact when only the protected tail remains', async () => {
    const out = await runCompaction({ reason: 'test', actor: 'sb' }, deps(ledgerOf(5)));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('nothing to compact');
  });
});
