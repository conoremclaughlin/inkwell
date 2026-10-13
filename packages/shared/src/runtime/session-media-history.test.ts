/** Pure replay never grants a file-read capability or changes eviction identity. */
import { describe, expect, it, vi } from 'vitest';
import { ContextLedger, entryRefHash, estimateTokens } from './context-ledger.js';
import { hydrateLedgerFromEvents, keptEntriesForCompaction } from './session-history.js';
import { runCompaction } from './compaction.js';
import {
  recordContextImages,
  readRecordedContextImages,
  type RetainedImageDescriptor,
} from './context-media.js';
import type { ContextImage } from './context-image.js';

const descriptor: RetainedImageDescriptor = {
  version: 1,
  sha256: 'a'.repeat(64),
  byteLength: 32,
  mimeType: 'image/png',
  width: 2,
  height: 1,
};
const ref = `img:${descriptor.sha256}`;
const image: ContextImage = {
  ref,
  retained: descriptor,
  path: '/host-private/file',
  mimeType: 'image/png',
  width: 2,
  height: 1,
  approxTokens: 85,
};
const content = `Local tool (read): fixture [${ref} 2x1 attached]`;
const event = (eid = 1) => ({
  eid,
  type: 'local_tool_call',
  tool: 'read',
  status: 'executed',
  imageContext: { version: 1, content, images: recordContextImages([image]) },
});
const restore = (events: Record<string, unknown>[]) => {
  const ledger = new ContextLedger();
  hydrateLedgerFromEvents(ledger, events);
  return ledger;
};

describe('media metadata through log replay and compaction', () => {
  it('persists only path-free metadata, preserving exact content/eid and deferring I/O to the host', () => {
    const ledger = restore([event()]);
    expect(ledger.listImages()).toEqual([]);
    expect(ledger.listEntries()[0]).toMatchObject({
      content,
      eid: 1,
      media: [{ ref, retained: descriptor }],
    });
    expect(JSON.stringify(event())).not.toContain(image.path);
  });

  it('notes cannot break hash/eid eviction or evict another surviving reference', () => {
    const ledger = restore([event(), event(2)]);
    const [first, second] = ledger.listEntries();
    ledger.restoreEntryImages(first.id, [], ['image unavailable']);
    expect(first.content).toBe(content);
    expect(first.approxTokens).toBe(estimateTokens(`${content}\nimage unavailable`));
    expect(ledger.buildPromptTranscript()).toContain('image unavailable');
    const refs = [{ eid: 1, hash: entryRefHash('system', content) }];
    expect(ledger.findEntriesByRefs(refs)).toEqual([first.id]);
    ledger.evictEntries([first.id]);
    expect(ledger.listEntries()).toEqual([second]);
    const replay = restore([event(), event(2), { type: 'context_evict', refs, eid: 3 }]);
    expect(replay.listEntries().map((e) => e.eid)).toEqual([2]);
    expect(replay.listEntries()[0].media).toEqual(second.media);
  });

  it.each(['helper', 'runtime'] as const)(
    '%s compaction marker preserves surviving descriptors, but never paths',
    async (via) => {
      const ledger = restore([
        ...(via === 'helper' ? [{ type: 'user', content: 'brief', eid: 0 }] : []),
        event(),
        event(2),
      ]);
      const old = ledger.addEntry('user', 'long detail '.repeat(300), 'repl', 3);
      let events: Record<string, unknown>[] = [];
      if (via === 'helper')
        events = [
          { type: 'compaction', summary: 'brief', keptEntries: keptEntriesForCompaction(ledger) },
        ];
      else {
        expect(
          await runCompaction(
            { actor: 'sb', reason: 'test', entryIds: [old.id], summaryText: 'brief' },
            {
              ledger,
              keepRecentDefault: 2,
              summarize: vi.fn(),
              persist: (e) => {
                events.push(e);
              },
              recordUsage: vi.fn(),
              log: vi.fn(),
            }
          )
        ).toMatchObject({ ok: true });
      }
      const replay = restore(events);
      expect(
        replay
          .listEntries()
          .filter((e) => e.media)
          .map((e) => e.media)
      ).toEqual([[{ ref, retained: descriptor }], [{ ref, retained: descriptor }]]);
      expect(JSON.stringify(events)).not.toContain(image.path);
    }
  );

  it('summarization sees unavailable notes, and removed image entries cannot return', async () => {
    const ledger = restore([event()]);
    const entry = ledger.listEntries()[0];
    ledger.restoreEntryImages(entry.id, [], ['image unavailable']);
    const events: Record<string, unknown>[] = [];
    const summarize = vi.fn(async (_chunk: string) => ({ text: 'brief' }));
    expect(
      await runCompaction(
        { actor: 'sb', reason: 'test', entryIds: [entry.id] },
        {
          ledger,
          keepRecentDefault: 0,
          summarize,
          persist: (e) => {
            events.push(e);
          },
          recordUsage: vi.fn(),
          log: vi.fn(),
        }
      )
    ).toMatchObject({ ok: true });
    expect(summarize.mock.calls[0][0]).toContain('image unavailable');
    expect(
      restore([event(), ...events])
        .listEntries()
        .some((e) => e.media)
    ).toBe(false);
  });

  it.each(['evict_context', 'list_context', 'spawn_agent', 'collect_agents'])(
    '%s never reinserts media',
    (tool) => {
      expect(restore([{ ...event(), tool }]).listEntries()).toEqual([]);
    }
  );
  it.each(['blocked', 'error', 'denied'])('a %s result cannot hydrate media', (status) => {
    expect(restore([{ ...event(), status }]).listEntries()).toEqual([]);
  });
  it('legacy results remain display-only', () => {
    expect(
      restore([
        { type: 'local_tool_call', tool: 'read', status: 'executed', result: { image: ref } },
      ]).listEntries()
    ).toEqual([]);
  });
  it('malformed or mismatched metadata stays visible without granting file access', () => {
    const values = [
      [{ ref, retained: { ...descriptor, path: '/outside/secret' } }],
      [{ ref: 'img:' + 'b'.repeat(64), retained: descriptor }],
      [{ ref: '../../secret', retained: descriptor }],
      [{ ref, retained: { ...descriptor, width: Infinity } }],
      [{ ref, retained: null }],
      { path: '/outside/secret' },
    ];
    for (const value of values) {
      const parsed = readRecordedContextImages(value);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].retained).toBeNull();
      expect(JSON.stringify(parsed)).not.toContain('/outside');
    }
  });
  it('bounds recorded metadata without changing live delivery, and round-trips overflow as unavailable', () => {
    const recorded = recordContextImages(Array.from({ length: 100 }, () => image));
    expect(recorded).toHaveLength(64);
    expect(recorded[63]).toEqual({ ref: 'img:unavailable', retained: null });
    expect(readRecordedContextImages(recorded)).toEqual(recorded);
    expect(readRecordedContextImages(Array.from({ length: 65 }, () => recorded[0]))).toEqual([
      { ref: 'img:unavailable', retained: null },
    ]);
  });
});
