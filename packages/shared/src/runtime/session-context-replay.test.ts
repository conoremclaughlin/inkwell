import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  recoverSessionContext,
  sessionContextNote,
  SESSION_CONTEXT_SOURCE,
} from './session-context-recovery.js';
import {
  hydrateLedgerFromEvents,
  hydrateLedgerFromEventStream,
  keptEntriesForCompaction,
} from './session-history.js';

describe.each(['sync', 'async'] as const)('%s recovery replay', (mode) => {
  const restore = (ledger: ContextLedger, events: Record<string, unknown>[]) =>
    mode === 'sync'
      ? hydrateLedgerFromEvents(ledger, events)
      : hydrateLedgerFromEventStream(
          ledger,
          (async function* () {
            for (const event of events) {
              await Promise.resolve();
              yield event;
            }
          })()
        );

  it.each([
    {
      response: { success: true, context: [{ type: 'message_in', content: 'quoted fixture' }] },
      status: 'loaded',
      count: 1,
    },
    { response: { success: true, context: [] }, status: 'empty', count: 0 },
    { response: null, status: 'unavailable', count: 0 },
  ])(
    'restores $status provenance without invented messages',
    async ({ response, status, count }) => {
      const note = sessionContextNote(recoverSessionContext(response));
      const ledger = new ContextLedger();
      const result = await restore(ledger, [{ ...note, eid: 4 }]);
      expect(result.activityContext).toEqual({ status, count });
      expect(result.loaded).toBe(1);
      expect(result.messageCount).toBe(0);
      expect(result.tailPreview).toEqual([]);
      expect(result.maxEid).toBe(4);
      expect(ledger.listEntries()).toEqual([
        expect.objectContaining({
          role: 'system',
          source: SESSION_CONTEXT_SOURCE,
          content: note.content,
          eid: 4,
        }),
      ]);
    }
  );

  it('preserves size refusal through compaction and eviction, without resurrecting its note', async () => {
    const note = sessionContextNote(
      recoverSessionContext({
        success: true,
        context: [{ type: 'message_out', content: 'discard-this-tail'.repeat(30_000) }],
      })
    );
    expect(note.activityContext).toEqual({ status: 'unavailable', count: 0, reason: 'size_limit' });
    expect(note.content).not.toContain('discard-this-tail');
    const tail = new ContextLedger();
    tail.addEntry('system', 'summary', 'compaction');
    tail.addEntry('system', note.content, SESSION_CONTEXT_SOURCE, 4);
    const events = [
      { ...note, eid: 4 },
      {
        type: 'compaction',
        summary: 'summary',
        keptEntries: keptEntriesForCompaction(tail),
        eid: 5,
      },
    ];
    const compacted = new ContextLedger();
    const result = await restore(compacted, events);
    expect(result.activityContext).toEqual(note.activityContext);
    expect(result.messageCount).toBe(0);
    expect(result.tailPreview.some((row) => row.eid === 4)).toBe(false);
    expect(
      compacted.listEntries().filter((entry) => entry.source === SESSION_CONTEXT_SOURCE)
    ).toEqual([expect.objectContaining({ content: note.content, eid: 4 })]);
    const evicted = new ContextLedger();
    const after = await restore(evicted, [
      ...events,
      { type: 'context_evict', refs: [{ eid: 4 }], eid: 6 },
    ]);
    // Original recovery provenance remains truthful even after the note leaves the window.
    expect(after.activityContext).toEqual(note.activityContext);
    expect(evicted.listEntries().some((entry) => entry.source === SESSION_CONTEXT_SOURCE)).toBe(
      false
    );
    expect(after.messageCount).toBe(0);
    expect(after.tailPreview.some((row) => row.eid === 4)).toBe(false);
  });

  it('does not invent provenance for legacy notes or leak it into another session', async () => {
    const loaded = sessionContextNote(recoverSessionContext({ success: true, context: [] }));
    const one = await restore(new ContextLedger(), [{ ...loaded, eid: 1 }]);
    expect(one.activityContext?.status).toBe('empty');
    for (const activityContext of [
      undefined,
      { status: 'loaded', count: -1 },
      { status: 'other', count: 0 },
    ]) {
      const next = await restore(new ContextLedger(), [{ ...loaded, activityContext, eid: 1 }]);
      expect(next.activityContext).toBeUndefined();
      expect(next.messageCount).toBe(0);
    }
  });
});
