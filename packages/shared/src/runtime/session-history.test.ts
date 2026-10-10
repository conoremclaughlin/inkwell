import { describe, expect, it } from 'vitest';
import { ContextLedger, entryRefHash } from './context-ledger.js';
import { runCompaction } from './compaction.js';
import { SessionLog } from './session-log.js';
import {
  extractSessionContextMessages,
  hydrateLedgerFromEvents,
  hydrateLedgerFromSessionContext,
} from './session-history.js';

describe('host-independent session restoration', () => {
  it('keeps independently loaded sessions and recall/inbox/activity cursors separate', async () => {
    const restore = async (prefix: string) => {
      // A host may await storage before calling replay; no file or CLI needed.
      const events = await Promise.resolve([
        { type: 'user', content: `${prefix} question`, eid: 1 },
        { type: 'inbox', rendered: `${prefix} mail`, messageId: `${prefix}-mail`, eid: 2 },
        {
          type: 'hook_injection',
          content: `${prefix} recall`,
          memoryId: `${prefix}-memory`,
          eid: 3,
        },
        {
          type: 'activity',
          content: `${prefix} reply`,
          activityId: `${prefix}-activity`,
          activityType: 'message_out',
          platform: 'fixture-channel',
          sbSlug: prefix,
          eid: 4,
        },
      ]);
      const ledger = new ContextLedger();
      const result = hydrateLedgerFromEvents(ledger, events, prefix);
      return { ledger, result };
    };
    const [first, second] = await Promise.all([restore('first'), restore('second')]);
    expect(first.result.seenInboxIds).toEqual(['first-mail']);
    expect(first.result.recoveredMemoryIds).toEqual(['first-memory']);
    expect(first.result.seenActivityIds).toEqual(['first-activity']);
    expect(first.result.tailPreview.at(-1)?.label).toBe('📤 first → fixture-channel');
    first.ledger.evictEntries(first.ledger.listEntries().map((e) => e.id));
    expect(second.ledger.listEntries()).toHaveLength(4);
    expect(second.result.recoveredMemoryIds).toEqual(['second-memory']);
    expect(JSON.stringify(second.result)).not.toContain('first');
  });

  it('round-trips real compaction with selected ordering and platform replay metadata', async () => {
    const ledger = new ContextLedger();
    const events: Record<string, unknown>[] = [];
    const original = ledger.addEntry('user', 'before', 'repl', 1);
    const target = ledger.addEntry('assistant', 'long detail '.repeat(100), 'provider', 2);
    ledger.addEntry('system', 'compact activity', 'ink-activity', 3, {
      role: 'assistant',
      label: '📤 fixture → fixture-channel',
      body: 'full reply',
      at: 'fixture-time',
    });
    const outcome = await runCompaction(
      {
        actor: 'sb',
        reason: 'fixture consolidation',
        summaryText: 'brief',
        entryIds: [target.id],
      },
      {
        ledger,
        keepRecentDefault: 12,
        summarize: async () => {
          throw new Error('not called');
        },
        persist: (event) => {
          events.push(event);
        },
        recordUsage: () => {},
        log: () => {},
      }
    );
    expect(outcome.ok).toBe(true);
    const restored = new ContextLedger();
    const replay = hydrateLedgerFromEvents(restored, events);
    const projection = (l: ContextLedger) =>
      l
        .listEntries()
        .map(({ role, content, source, eid, replay }) => ({ role, content, source, eid, replay }));
    // Replay deliberately labels the summary as historical; keep that legacy
    // attribution while checking every other field and the exact entry order.
    expect(ledger.listEntries()[1].source).toBe('compaction');
    expect(projection(restored)).toEqual(
      projection(ledger).map((entry, index) =>
        index === 1 ? { ...entry, source: 'compaction-history' } : entry
      )
    );
    expect(restored.listEntries()[0].content).toBe(original.content);
    expect(replay.tailPreview.at(-1)).toMatchObject({ content: 'full reply', ts: 'fixture-time' });
  });

  it('preserves bootstrap and late duplicate content when replaying an eviction', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap', 'bootstrap', 1);
    const replay = hydrateLedgerFromEvents(ledger, [
      { type: 'user', content: 'duplicate', eid: 1 },
      {
        type: 'context_evict',
        refs: [{ eid: 1, hash: entryRefHash('user', 'duplicate') }],
        eid: 2,
      },
      { type: 'user', content: 'duplicate', eid: 3 },
    ]);
    expect(ledger.listEntries().map((e) => e.content)).toEqual(['bootstrap', 'duplicate']);
    expect(replay.tailPreview.map((e) => e.eid)).toEqual([3]);
    expect(replay.evictedEntries).toHaveLength(1);
    expect(replay.maxEid).toBe(3);
  });

  it('recovers the append sequence without dispatching historical tools or re-emitting projections', async () => {
    const ledger = new ContextLedger();
    const replay = hydrateLedgerFromEvents(ledger, [
      { type: 'user', content: 'question', eid: 8 },
      {
        type: 'local_tool_call',
        tool: 'fixture_tool',
        status: 'denied',
        reason: 'fixture refusal',
        eid: 9,
      },
    ]);
    expect(replay.toolCalls).toEqual([expect.objectContaining({ result: 'fixture refusal' })]);
    expect(ledger.listEntries().map((e) => e.content)).toEqual(['question']);
    const persisted: string[] = [];
    const projected: Record<string, unknown>[] = [];
    const log = new SessionLog({
      path: 'memory:fixture',
      sink: {
        write: async (line) => {
          persisted.push(line);
        },
      },
      onProjection: (event) => {
        projected.push(event);
      },
    });
    log.seed(replay.maxEid);
    expect(projected).toEqual([]);
    expect(log.append({ type: 'user', content: 'next question' })).toBe(10);
    await log.flush();
    expect(projected.map((e) => e.eid)).toEqual([10]);
    expect(persisted).toHaveLength(1);
  });

  it('keeps clone summaries once, then supersedes them at a compaction boundary', () => {
    const fanout = {
      type: 'clone_fanout',
      outcomes: [
        { id: 'clone-a', label: 'fixture audit', status: 'completed', summary: 'fixture result' },
        { id: 'clone-b', label: 'fixture review', status: 'failed', error: 'fixture failure' },
      ],
    };
    const ledger = new ContextLedger();
    hydrateLedgerFromEvents(ledger, [fanout]);
    expect(ledger.listEntries()).toHaveLength(1);
    expect(ledger.listEntries()[0].content).toContain('fixture failure');
    const restored = new ContextLedger();
    hydrateLedgerFromEvents(restored, [
      fanout,
      { type: 'compaction', summary: 'combined brief', keptEntries: [] },
    ]);
    expect(restored.listEntries().map((e) => e.content)).toEqual(['combined brief']);
  });

  it('keeps the session-context fallback roles, source attribution and bounded inbox preview', () => {
    const messages = extractSessionContextMessages({
      context: [
        { type: 'message_in', content: ' question ', createdAt: 'fixture-time' },
        { activityType: 'message_out', content: 'answer', created_at: 'fixture-time' },
        { type: 'task_request', subtype: 'fixture', content: 'x'.repeat(500) },
        { type: 'state_change', content: 'bookkeeping' },
        { type: 'user', content: '  ' },
      ],
    });
    const ledger = new ContextLedger();
    const restored = hydrateLedgerFromSessionContext(ledger, messages);
    expect(restored.source).toBe('ink-session-context');
    expect(restored.loaded).toBe(4);
    expect(restored.messageCount).toBe(3);
    expect(ledger.listEntries().map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'inbox',
      'system',
    ]);
    expect(ledger.listEntries()[2].source).toBe('ink-history:task_request:fixture');
    expect(ledger.listEntries()[2].content).toHaveLength(420);
    expect(restored.tailPreview[2].content).toHaveLength(180);
  });
});
