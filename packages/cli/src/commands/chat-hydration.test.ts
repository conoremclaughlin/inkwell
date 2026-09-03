import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextLedger, entryRefHash } from '../repl/context-ledger.js';
import {
  BOOTSTRAP_REQUIRED_EXIT_MARKER,
  failIfBootstrapRequired,
  findLastDetectedModel,
  formatTranscriptSize,
  hydrateLedgerFromTranscript,
  keptEntriesForCompaction,
} from './chat.js';

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

describe('hydrateLedgerFromTranscript — a hash-selected eviction replays as itself (Lumen, PR #582)', () => {
  let dir: string;
  let transcriptPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-evict-ref-test-'));
    transcriptPath = join(dir, 'session-test.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('REGRESSION: two hydrated entries share an eid; the persisted eid+hash ref evicts only the hashed one', () => {
    // A compaction's kept tail and a later event can both hydrate with the
    // same eid. The SB evicted `target` by ref; the hook persisted
    // { eid, hash }. Replay must not take `neighbour` with it.
    writeFileSync(
      transcriptPath,
      [
        { eid: 7, type: 'user', content: 'target' },
        { eid: 7, type: 'user', content: 'neighbour' },
        {
          eid: 8,
          type: 'context_evict',
          actor: 'sb',
          reason: 'by ref',
          refs: [{ eid: 7, hash: entryRefHash('user', 'target') }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );
    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath);
    expect(ledger.listEntries().map((e) => e.content)).toEqual(['neighbour']);
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

describe('hydrateLedgerFromTranscript — platform message replay (activity entries)', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-activity-replay-test-'));
    transcriptPath = join(dir, 'session-activity.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (events: unknown[]) =>
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  it('replays outbound platform messages as directional message blocks, not just tool receipts', () => {
    // Conor's reattach report (2026-08-12): Myra's Telegram sends showed only
    // as collapsed send_response events after detach/reattach. The activity
    // entry holds the FULL sent content — replay it as the same 📤 block the
    // live activity poll renders.
    write([
      {
        eid: 1,
        type: 'local_tool_call',
        tool: 'send_response',
        args: {
          channel: 'telegram',
          conversationId: '726555973',
          content: 'Post-session catch-up',
        },
        status: 'executed',
        result: { success: true },
      },
      {
        eid: 2,
        type: 'activity',
        activityId: 'act-1',
        activityType: 'message_out',
        agentId: 'myra',
        platform: 'telegram',
        createdAt: '2026-08-12T22:03:00Z',
        content: 'Post-session catch-up: Ruoshan emailed about the picnic.',
      },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');

    // The tool receipt stays a dim event row...
    const eventRows = result.tailPreview.filter((p) => p.role === 'event');
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].content).toContain('send_response');

    // ...and the SENT MESSAGE is a labeled assistant block with full content.
    const sent = result.tailPreview.find((p) => p.role === 'assistant');
    expect(sent).toBeDefined();
    expect(sent!.label).toBe('📤 myra → telegram');
    expect(sent!.content).toContain('Ruoshan emailed about the picnic');
    expect(sent!.ts).toBe('2026-08-12T22:03:00Z');

    // The activity id is marked seen so the live poll cannot double-render it.
    expect(result.seenActivityIds).toContain('act-1');
  });

  it('replays inbound platform messages as user blocks', () => {
    write([
      {
        eid: 1,
        type: 'activity',
        activityId: 'act-2',
        activityType: 'message_in',
        agentId: 'myra',
        platform: 'telegram',
        content: 'Therapy finished 45 minutes ago!',
      },
    ]);
    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');
    const received = result.tailPreview.find((p) => p.role === 'user');
    expect(received).toBeDefined();
    expect(received!.label).toBe('📨 telegram → myra');
  });

  it('legacy activity entries without platform still replay with the generic channel label', () => {
    write([
      {
        eid: 1,
        type: 'activity',
        activityId: 'act-3',
        activityType: 'message_out',
        agentId: 'myra',
        content: 'sent before platform was persisted',
      },
    ]);
    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');
    expect(result.tailPreview.find((p) => p.role === 'assistant')?.label).toBe('📤 myra → channel');
  });

  it('bookkeeping and other-agent activity stays out of the message replay', () => {
    write([
      {
        eid: 1,
        type: 'activity',
        activityId: 'act-4',
        activityType: 'tool_call',
        agentId: 'myra',
        content: 'list_emails',
      },
      {
        eid: 2,
        type: 'activity',
        activityId: 'act-5',
        activityType: 'state_change',
        agentId: 'lumen',
        content: 'phase: reviewing',
      },
    ]);
    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');
    expect(result.tailPreview).toHaveLength(0);
    // Still in the ledger (context) and marked seen, as before.
    expect(result.seenActivityIds).toEqual(expect.arrayContaining(['act-4', 'act-5']));
  });
});

describe('platform message replay survives compaction (PR #478 round 2)', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-compact-replay-test-'));
    transcriptPath = join(dir, 'session-compact.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (events: unknown[]) =>
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const sendActivity = {
    eid: 3,
    type: 'activity',
    activityId: 'act-send',
    activityType: 'message_out',
    agentId: 'myra',
    platform: 'telegram',
    createdAt: '2026-08-12T22:03:00Z',
    content: 'Post-session catch-up: Ruoshan emailed about the picnic.',
  };

  it('a platform send in the compaction kept tail replays as a message block, not the ⚡ line', () => {
    // Compact → detach → reattach: the kept tail serializes ledger entries;
    // the replay metadata rides along so the send stays a visible message.
    write([
      { eid: 1, type: 'user', content: 'old question' },
      { eid: 2, type: 'assistant', content: 'old answer', backend: 'claude' },
      {
        eid: 4,
        type: 'compaction',
        summary: '[Conversation summary — compacted 2 earlier entries]\nOld stuff.',
        keptEntries: [
          { role: 'assistant', content: 'recent answer', source: 'claude' },
          {
            role: 'system',
            content: '⚡ myra sent — Post-session catch-up…',
            source: 'pcp-activity',
            eid: 3,
            replay: {
              role: 'assistant',
              label: '📤 myra → telegram',
              body: 'Post-session catch-up: Ruoshan emailed about the picnic.',
              at: '2026-08-12T22:03:00Z',
            },
          },
        ],
        removedCount: 2,
      },
    ]);

    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');

    // The send replays as the directional block with FULL content…
    const sent = result.tailPreview.find((p) => p.label === '📤 myra → telegram');
    expect(sent).toBeDefined();
    expect(sent!.role).toBe('assistant');
    expect(sent!.content).toContain('Ruoshan emailed about the picnic');
    expect(sent!.ts).toBe('2026-08-12T22:03:00Z');

    // …while the LEDGER keeps the compact ⚡ line (context unchanged) with
    // the replay metadata restored for the NEXT compaction cycle.
    const ledgerEntry = ledger.listEntries().find((e) => e.source === 'pcp-activity');
    expect(ledgerEntry).toBeDefined();
    expect(ledgerEntry!.content).toContain('⚡ myra sent');
    expect(ledgerEntry!.replay?.label).toBe('📤 myra → telegram');
  });

  it('kept internal-source entries WITHOUT replay metadata stay suppressed (legacy behavior)', () => {
    write([
      {
        eid: 2,
        type: 'compaction',
        summary: 'summary',
        keptEntries: [
          { role: 'system', content: '⚡ myra tool call — list_emails', source: 'pcp-activity' },
        ],
        removedCount: 1,
      },
    ]);
    const ledger = new ContextLedger();
    const result = hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');
    expect(result.tailPreview).toHaveLength(0);
  });

  it('FULL CYCLE: hydrate activity → live compaction serializes replay → next reattach still shows the block', () => {
    // Cycle 1: reattach hydrates the raw activity event.
    write([sendActivity]);
    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath, 'myra');
    const hydratedEntry = ledger.listEntries().find((e) => e.source === 'pcp-activity-history');
    expect(hydratedEntry?.replay?.label).toBe('📤 myra → telegram');

    // Live compaction in this process: the production keptEntries writer
    // serializes the ledger tail — replay metadata must ride along.
    ledger.compactToSummary('[Conversation summary]', 12);
    const kept = keptEntriesForCompaction(ledger);
    const keptSend = kept.find(
      (k) => (k as { source?: string }).source === 'pcp-activity-history'
    ) as { replay?: { label?: string; body?: string } } | undefined;
    expect(keptSend?.replay?.label).toBe('📤 myra → telegram');
    expect(keptSend?.replay?.body).toContain('Ruoshan emailed');

    // Cycle 2: next process reattaches onto the compaction event.
    write([
      sendActivity,
      { eid: 4, type: 'compaction', summary: '[Conversation summary]', keptEntries: kept },
    ]);
    const ledger2 = new ContextLedger();
    const result2 = hydrateLedgerFromTranscript(ledger2, transcriptPath, 'myra');
    const sent2 = result2.tailPreview.find((p) => p.label === '📤 myra → telegram');
    expect(sent2).toBeDefined();
    expect(sent2!.content).toContain('Ruoshan emailed about the picnic');
  });
});

describe('findLastDetectedModel — persisted provider model recovery', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-model-detect-test-'));
    transcriptPath = join(dir, 'session-model.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (events: unknown[]) =>
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  it('recovers the last model_detected entry for the backend', () => {
    write([
      { eid: 1, type: 'user_turn', content: 'hi' },
      { eid: 2, type: 'model_detected', backend: 'claude', model: 'claude-opus-4-6' },
      { eid: 3, type: 'model_detected', backend: 'claude', model: 'claude-fable-5' },
    ]);
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBe('claude-fable-5');
  });

  it('ignores entries persisted under a DIFFERENT backend', () => {
    // A /backend switch mid-session leaves the old provider's entry behind;
    // it must not drive the new backend's window.
    write([{ eid: 1, type: 'model_detected', backend: 'claude', model: 'claude-fable-5' }]);
    expect(findLastDetectedModel(transcriptPath, 'codex')).toBeUndefined();
  });

  it('returns undefined for legacy transcripts, missing files, and malformed lines', () => {
    write([{ eid: 1, type: 'user_turn', content: 'no model entry here' }]);
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBeUndefined();
    expect(findLastDetectedModel(join(dir, 'nope.jsonl'), 'claude')).toBeUndefined();
    writeFileSync(
      transcriptPath,
      'not json\n{"type":"model_detected","backend":"claude","model":42}\n'
    );
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBeUndefined();
  });
});

describe('hydrateLedgerFromTranscript — shadow clone handoff', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ink-hydration-clones-test-'));
    transcriptPath = join(dir, 'session-clones.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(events: Array<Record<string, unknown>>) {
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('replays a fan-out summary into the reattached ledger', () => {
    // The clones' summaries are the parent's ONLY record of that work — their
    // own transcripts are separate files it never replays. Without this branch
    // a reattached parent silently loses every clone result it paid for.
    write([
      { ts: '2026-08-14T09:00:00Z', eid: 1, type: 'user', content: 'go look at two things' },
      {
        ts: '2026-08-14T09:01:00Z',
        eid: 2,
        type: 'clone_fanout',
        outcomes: [
          {
            id: 'clone-1',
            label: 'audit auth paths',
            status: 'completed',
            summary: 'Three entry points, all in auth.ts.',
          },
          {
            id: 'clone-2',
            label: 'map coverage',
            status: 'failed',
            error: 'backend backend-failure',
          },
        ],
      },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath, 'wren');

    const clone = ledger.listEntries().find((e) => e.source === 'shadow-clone');
    expect(clone).toBeDefined();
    expect(clone?.content).toContain('clone-1 · audit auth paths — completed');
    expect(clone?.content).toContain('Three entry points, all in auth.ts.');
    expect(clone?.content).toContain('backend backend-failure');
  });

  it('keeps the replayed handoff to one entry, whatever the fan-out width', () => {
    write([
      {
        ts: '2026-08-14T09:01:00Z',
        eid: 1,
        type: 'clone_fanout',
        outcomes: [
          { id: 'clone-1', label: 'a', status: 'completed', summary: 'x' },
          { id: 'clone-2', label: 'b', status: 'completed', summary: 'y' },
          { id: 'clone-3', label: 'c', status: 'completed', summary: 'z' },
        ],
      },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath, 'wren');
    expect(ledger.listEntries().filter((e) => e.source === 'shadow-clone')).toHaveLength(1);
  });

  it('survives a malformed fan-out event rather than dropping the transcript', () => {
    write([
      { ts: '2026-08-14T09:01:00Z', eid: 1, type: 'clone_fanout' },
      { ts: '2026-08-14T09:02:00Z', eid: 2, type: 'user', content: 'still here' },
    ]);

    const ledger = new ContextLedger();
    expect(() => hydrateLedgerFromTranscript(ledger, transcriptPath, 'wren')).not.toThrow();
    expect(ledger.listEntries().some((e) => e.content === 'still here')).toBe(true);
  });

  it('lets a later compaction supersede a replayed fan-out', () => {
    // The failure this guards: hydration added the fan-out entry but did not
    // track its id, so the compaction event that replaced it evicted everything
    // EXCEPT it — leaving the superseded clone summary sitting alongside the
    // compacted state that was meant to stand in for it.
    write([
      { ts: '2026-08-14T09:00:00Z', eid: 1, type: 'user', content: 'go look at two things' },
      {
        ts: '2026-08-14T09:01:00Z',
        eid: 2,
        type: 'clone_fanout',
        outcomes: [
          { id: 'clone-1', label: 'audit', status: 'completed', summary: 'Three entry points.' },
        ],
      },
      {
        ts: '2026-08-14T09:02:00Z',
        eid: 3,
        type: 'compaction',
        summary: 'Earlier work compacted: clones audited auth.',
        kept: [],
      },
    ]);

    const ledger = new ContextLedger();
    hydrateLedgerFromTranscript(ledger, transcriptPath, 'wren');

    const entries = ledger.listEntries();
    expect(entries.some((e) => e.content.includes('Three entry points.'))).toBe(false);
    expect(entries.some((e) => e.source === 'compaction-history')).toBe(true);
  });
});

describe('BOOTSTRAP_REQUIRED_EXIT_MARKER', () => {
  it('matches the literal the server-side InkRunner greps stderr for', () => {
    // packages/api InkRunner carries its own copy of this string; the two
    // processes share no module, so the literal is the whole contract. If this
    // side is renamed alone, the runner stops recognising the refusal and a
    // failed turn looks like a crash instead of something recoverable.
    expect(BOOTSTRAP_REQUIRED_EXIT_MARKER).toBe('INK_BOOTSTRAP_REQUIRED_FAILURE');
  });
});

describe('failIfBootstrapRequired', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the run and names itself on stderr when identity context is required', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      failIfBootstrapRequired({ requireBootstrap: true }, 'bootstrap unavailable')
    ).toThrow('exited');

    expect(exit).toHaveBeenCalledWith(78);
    // The runner greps stderr for this; a bare exit code is not enough to tell
    // a refusal apart from a crash.
    expect(String(err.mock.calls[0][0])).toContain(BOOTSTRAP_REQUIRED_EXIT_MARKER);
  });

  it('leaves an interactive run alone, where a human can read the warning', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    expect(() => failIfBootstrapRequired({}, 'bootstrap unavailable')).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
