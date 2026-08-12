import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextLedger, entryRefHash } from '../repl/context-ledger.js';
import { hydrateLedgerFromTranscript, formatTranscriptSize } from './chat.js';

describe('hydrateLedgerFromTranscript — tool call replay', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-hydration-tools-test-'));
    transcriptPath = join(dir, 'session-tools.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replays local_tool_call events as dim event rows (regression: send_response receipts vanished)', () => {
    writeFileSync(
      transcriptPath,
      [
        {
          eid: 1,
          type: 'system_turn',
          content: '[HEARTBEAT TRIGGER] check email',
          label: 'heartbeat',
        },
        {
          eid: 2,
          type: 'local_tool_call',
          tool: 'send_response',
          args: { channel: 'telegram', conversationId: '726555973', content: 'heads-up!' },
          status: 'executed',
          result: { success: true, messageId: 'tg-401' },
        },
        {
          eid: 3,
          type: 'assistant',
          content: 'Sent Conor a heads-up via Telegram.',
          backend: 'claude',
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');

    // The tool call shows in the replay as an event row, attributed to the agent...
    const eventRows = result.tailPreview.filter((p) => p.role === 'event');
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].content).toContain('myra · send_response');
    expect(eventRows[0].content).toContain('(executed)');
    expect(eventRows[0].content).toContain('telegram');
    expect(eventRows[0].eid).toBe(2);

    // ...in order, between the trigger and the assistant's claim
    const roles = result.tailPreview.map((p) => p.role);
    expect(roles).toEqual(['system', 'event', 'assistant']);

    // ...but is not counted as a message and not added to the ledger
    expect(result.messageCount).toBe(2);
    expect(ledger.listEntries().some((e) => e.content.includes('send_response'))).toBe(false);

    // ...and is collected for the context inspector's Tool Calls section,
    // result included (Ctrl+T is the drill-down for the scrollback teaser)
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('send_response');
    expect(result.toolCalls[0].args).toContain('726555973');
    expect(result.toolCalls[0].result).toContain('tg-401');
  });

  it('carries denied reasons and thrown errors into the inspector record (reason/error fallback)', () => {
    writeFileSync(
      transcriptPath,
      [
        {
          eid: 1,
          type: 'local_tool_call',
          tool: 'bash',
          args: { command: 'rm -rf /' },
          status: 'denied',
          reason: 'blocked by tool policy',
        },
        {
          eid: 2,
          type: 'local_tool_call',
          tool: 'get_inbox',
          args: { agentId: 'myra' },
          status: 'error',
          error: 'ECONNREFUSED 127.0.0.1:3001',
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].result).toBe('blocked by tool policy');
    expect(result.toolCalls[1].result).toBe('ECONNREFUSED 127.0.0.1:3001');
  });

  it('caps long tool args and results in the replay preview', () => {
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        eid: 1,
        type: 'local_tool_call',
        tool: 'remember',
        args: { content: 'x'.repeat(500) },
        status: 'executed',
        result: { echo: 'y'.repeat(3000) },
      }) + '\n'
    );

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);
    const row = result.tailPreview.find((p) => p.role === 'event');
    expect(row).toBeDefined();
    expect(row!.content.length).toBeLessThan(150);
    // Truncation is explicit, not a mid-word clip
    expect(row!.content.endsWith('…')).toBe(true);
    // The inspector record keeps a longer (but still capped) version
    expect(result.toolCalls[0].args!.length).toBeLessThanOrEqual(401);
    expect(result.toolCalls[0].args!.endsWith('…')).toBe(true);
    expect(result.toolCalls[0].result!.length).toBeLessThanOrEqual(2001);
    expect(result.toolCalls[0].result!.endsWith('…')).toBe(true);
  });
});

describe('formatTranscriptSize', () => {
  it('formats KB below 1MB, one decimal below 10MB, whole MB above', () => {
    expect(formatTranscriptSize(0)).toBe('');
    expect(formatTranscriptSize(512)).toBe('1KB');
    expect(formatTranscriptSize(420 * 1024)).toBe('420KB');
    expect(formatTranscriptSize(1.2 * 1024 * 1024)).toBe('1.2MB');
    expect(formatTranscriptSize(9.44 * 1024 * 1024)).toBe('9.4MB');
    expect(formatTranscriptSize(24.6 * 1024 * 1024)).toBe('25MB');
  });
});

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

  it('resets tailPreview at the compaction marker (regression: stale pre-compaction preview)', () => {
    // Pre-compaction turns must NOT appear in the visible replay below the
    // cutoff divider, and kept tail entries must not duplicate.
    writeTranscript([
      { type: 'user', content: 'ancient question' },
      { type: 'assistant', content: 'ancient answer', backend: 'claude' },
      { type: 'user', content: 'kept question' },
      { type: 'assistant', content: 'kept answer', backend: 'claude' },
      {
        type: 'compaction',
        summary: 'the summary',
        keptEntries: [
          { role: 'user', content: 'kept question', source: 'repl-history' },
          { role: 'assistant', content: 'kept answer', source: 'claude' },
        ],
      },
      { type: 'user', content: 'post-marker question' },
      { type: 'assistant', content: 'post-marker answer', backend: 'claude' },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    const previewContents = result.tailPreview.map((p) => p.content);
    // Exactly: kept tail + post-marker — no pre-compaction turns, no duplicates
    expect(previewContents).toEqual([
      'kept question',
      'kept answer',
      'post-marker question',
      'post-marker answer',
    ]);
    expect(previewContents).not.toContain('ancient question');
    expect(previewContents).not.toContain('ancient answer');
    expect(previewContents.filter((c) => c === 'kept question')).toHaveLength(1);
  });

  it('includes labeled system turns in tailPreview, excluding continuation noise', () => {
    // Heartbeat triggers / channel-delivered messages must stay visible in
    // the replay (regression: moving them from type:user to type:system_turn
    // dropped them from the preview — answers appeared without questions).
    writeTranscript([
      { type: 'system_turn', content: '[HEARTBEAT TRIGGER] check email', label: 'heartbeat' },
      { type: 'assistant', content: 'heartbeat cycle complete', backend: 'claude' },
      {
        type: 'system_turn',
        content: 'Continue working. Use signal_status…',
        label: 'continuation',
      },
      { type: 'assistant', content: 'still done', backend: 'claude' },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    const previews = result.tailPreview.map((p) => ({ role: p.role, label: p.label }));
    expect(result.tailPreview[0].content).toContain('[HEARTBEAT TRIGGER]');
    expect(previews[0]).toEqual({ role: 'system', label: 'heartbeat' });
    // Continuation prompts excluded from replay; both assistant replies kept
    expect(result.tailPreview.filter((p) => p.label === 'continuation')).toHaveLength(0);
    expect(result.tailPreview.filter((p) => p.role === 'assistant')).toHaveLength(2);
  });

  it('keeps labeled system turns visible through compaction keptEntries', () => {
    writeTranscript([
      { type: 'user', content: 'old' },
      {
        type: 'compaction',
        summary: 'the summary',
        keptEntries: [
          { role: 'system', content: '[HEARTBEAT TRIGGER] hourly check', source: 'heartbeat' },
          { role: 'assistant', content: 'cycle complete', source: 'claude' },
          { role: 'system', content: 'internal echo', source: 'pcp-activity' },
        ],
      },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    const labels = result.tailPreview.map((p) => p.label || p.role);
    expect(labels).toContain('heartbeat');
    expect(labels).not.toContain('pcp-activity'); // internal sources stay out of replay
    expect(result.tailPreview.map((p) => p.content)).not.toContain('old');
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

describe('hydrateLedgerFromTranscript — context_evict events', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-evict-test-'));
    transcriptPath = join(dir, 'session-test.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeTranscript = (events: Array<Record<string, unknown>>) => {
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('evicted entries stay gone on reattach (eid refs)', () => {
    writeTranscript([
      { eid: 1, type: 'user', content: 'keep me' },
      { eid: 2, type: 'assistant', content: 'stale heartbeat result', backend: 'claude' },
      { eid: 3, type: 'assistant', content: 'keep me too', backend: 'claude' },
      { eid: 4, type: 'context_evict', actor: 'sb', reason: 'stale', refs: [{ eid: 2 }] },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual(['keep me', 'keep me too']);
    expect(result.tailPreview.map((p) => p.content)).not.toContain('stale heartbeat result');
    expect(result.messageCount).toBe(2);
    expect(result.evictedEntries).toHaveLength(1);
    expect(result.evictedEntries[0].content).toBe('stale heartbeat result');
    expect(result.evictedEntries[0].actor).toBe('sb');
    expect(result.maxEid).toBe(4);
  });

  it('evicts by content hash when events lack eids (legacy transcripts)', () => {
    const hash = entryRefHash('user', 'old noise');
    writeTranscript([
      { type: 'user', content: 'old noise' },
      { type: 'user', content: 'signal' },
      { type: 'context_evict', actor: 'sb', refs: [{ hash }] },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    expect(ledger.listEntries().map((e) => e.content)).toEqual(['signal']);
  });

  it('does not retro-evict identical content appended AFTER the evict event', () => {
    const hash = entryRefHash('user', 'repeated message');
    writeTranscript([
      { type: 'user', content: 'repeated message' },
      { type: 'context_evict', actor: 'sb', refs: [{ hash }] },
      { type: 'user', content: 'repeated message' }, // written after — must survive
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    expect(ledger.listEntries().map((e) => e.content)).toEqual(['repeated message']);
    expect(result.messageCount).toBe(1);
  });

  it('evicts kept-tail entries re-seeded by a compaction event', () => {
    writeTranscript([
      { eid: 1, type: 'user', content: 'old' },
      {
        eid: 2,
        type: 'compaction',
        summary: 'the summary',
        keptEntries: [
          { role: 'user', content: 'kept but stale', source: 'repl-history', eid: 1 },
          { role: 'assistant', content: 'kept and useful', source: 'claude' },
        ],
      },
      { eid: 3, type: 'context_evict', actor: 'sb', refs: [{ eid: 1 }] },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);

    const contents = ledger.listEntries().map((e) => e.content);
    expect(contents).toEqual(['the summary', 'kept and useful']);
  });

  it('never evicts entries that predate hydration (bootstrap safety)', () => {
    const hash = entryRefHash('system', 'bootstrap identity block');
    writeTranscript([
      { type: 'user', content: 'hello' },
      { type: 'context_evict', actor: 'sb', refs: [{ hash }] },
    ]);

    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap identity block', 'bootstrap');

    hydrateLedgerFromTranscript(ledger, transcriptPath);

    expect(ledger.listEntries().map((e) => e.content)).toContain('bootstrap identity block');
  });

  it('keeps the surviving duplicate preview row on eid-specific eviction (regression)', () => {
    // Lumen's repro: two identical-content entries; evicting ONE by eid must
    // leave the other's preview row intact (content-key fallback must not
    // collateral-evict survivors).
    writeTranscript([
      { eid: 1, type: 'user', content: 'duplicate' },
      { eid: 2, type: 'user', content: 'duplicate' },
      { eid: 3, type: 'context_evict', actor: 'sb', refs: [{ eid: 1 }] },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);

    expect(ledger.listEntries()).toHaveLength(1);
    expect(ledger.listEntries()[0].eid).toBe(2);
    expect(result.messageCount).toBe(1);
    expect(result.tailPreview).toHaveLength(1);
    expect(result.tailPreview[0].eid).toBe(2);
    expect(result.tailPreview[0].content).toBe('duplicate');
  });

  it('reports maxEid so the append counter continues the sequence', () => {
    writeTranscript([
      { eid: 7, type: 'user', content: 'a' },
      { eid: 12, type: 'assistant', content: 'b', backend: 'claude' },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath);
    expect(result.maxEid).toBe(12);
  });
});
