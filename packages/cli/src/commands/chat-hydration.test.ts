import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextLedger } from '../repl/context-ledger.js';
import { hydrateLedgerFromTranscript } from './chat.js';

describe('hydrateLedgerFromTranscript — compaction events', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-hydration-test-'));
    transcriptPath = join(dir, 'session-test.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeTranscript = (events: Array<Record<string, unknown>>) => {
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('rehydrates summary + kept tail from a compaction event (regression: tail was dropped)', () => {
    // Simulates the live flow: 6 messages written, then compaction kept the
    // last 2 verbatim. The tail's original events PRECEDE the marker in the
    // file — hydration must restore the tail from the event's keptEntries.
    writeTranscript([
      { type: 'user', content: 'old question 1' },
      { type: 'assistant', content: 'old answer 1', backend: 'claude' },
      { type: 'user', content: 'old question 2' },
      { type: 'assistant', content: 'old answer 2', backend: 'claude' },
      { type: 'user', content: 'recent question' },
      { type: 'assistant', content: 'recent answer', backend: 'claude' },
      {
        type: 'compaction',
        summary: '[Conversation summary — compacted 4 earlier entries]\nKey facts here.',
        keptEntries: [
          { role: 'user', content: 'recent question', source: 'repl-history' },
          { role: 'assistant', content: 'recent answer', source: 'claude' },
        ],
        removedCount: 4,
      },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    const entries = ledger.listEntries();
    expect(entries).toHaveLength(3); // summary + 2-entry tail
    expect(entries[0].role).toBe('system');
    expect(entries[0].content).toContain('Key facts here');
    expect(entries[0].source).toBe('compaction-history');
    expect(entries[1].content).toBe('recent question');
    expect(entries[1].role).toBe('user');
    expect(entries[2].content).toBe('recent answer');
    expect(entries[2].role).toBe('assistant');
    expect(result.messageCount).toBe(2); // tail messages count; summary doesn't
  });

  it('replays events after the compaction marker on top of summary + tail', () => {
    writeTranscript([
      { type: 'user', content: 'pre-compaction' },
      {
        type: 'compaction',
        summary: 'the summary',
        keptEntries: [{ role: 'assistant', content: 'kept tail entry', source: 'claude' }],
      },
      { type: 'user', content: 'post-compaction question' },
      { type: 'assistant', content: 'post-compaction answer', backend: 'claude' },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual([
      'the summary',
      'kept tail entry',
      'post-compaction question',
      'post-compaction answer',
    ]);
    expect(contents).not.toContain('pre-compaction');
  });

  it('collapses repeatedly at the LAST compaction event', () => {
    writeTranscript([
      { type: 'user', content: 'era 1' },
      { type: 'compaction', summary: 'summary 1', keptEntries: [] },
      { type: 'user', content: 'era 2' },
      {
        type: 'compaction',
        summary: 'summary 2',
        keptEntries: [{ role: 'user', content: 'era 2', source: 'repl-history' }],
      },
      { type: 'user', content: 'era 3' },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual(['summary 2', 'era 2', 'era 3']);
  });

  it('handles legacy compaction events without keptEntries', () => {
    writeTranscript([
      { type: 'user', content: 'old' },
      { type: 'compaction', summary: 'summary only' },
      { type: 'assistant', content: 'after', backend: 'claude' },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual(['summary only', 'after']);
  });

  it('does not evict entries that predate hydration (e.g., bootstrap)', () => {
    writeTranscript([
      { type: 'user', content: 'old' },
      { type: 'compaction', summary: 'the summary', keptEntries: [] },
    ]);

    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap identity block', 'bootstrap');

    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual(['bootstrap identity block', 'the summary']);
  });

  it('skips malformed keptEntries without crashing', () => {
    writeTranscript([
      {
        type: 'compaction',
        summary: 'summary',
        keptEntries: [
          null,
          'not-an-object',
          { role: 'user' }, // missing content
          { role: 'weird-role', content: 'falls back to system role', source: 'x' },
          { role: 'user', content: 'valid entry' },
        ],
      },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const entries = ledger.listEntries();
    expect(entries).toHaveLength(3); // summary + fallback-role entry + valid entry
    expect(entries[1].role).toBe('system'); // unknown role falls back
    expect(entries[1].content).toBe('falls back to system role');
    expect(entries[2].role).toBe('user');
    expect(entries[2].content).toBe('valid entry');
  });
});
