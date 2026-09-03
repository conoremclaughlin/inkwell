import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  isClientLocalTool,
  handleClientLocalTool,
  parseCompactContextArgs,
  CLIENT_LOCAL_TOOLS,
  COMPACT_CONTEXT_MAX_KEEP_RECENT,
  COMPACT_CONTEXT_SUMMARY_MAX_CHARS,
  EVICT_CONTEXT_PREVIEW_LIMIT,
  LIST_CONTEXT_BOOKMARK_LIMIT,
  LIST_CONTEXT_DEFAULT_LIMIT,
  LIST_CONTEXT_MAX_LIMIT,
} from './context-tools.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

/** Extract parsed JSON from a tool call result */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResult(result: PcpToolCallResult | null): any {
  const content = result?.content as Array<{ type: string; text: string }> | undefined;
  return JSON.parse(content?.[0]?.text || '{}');
}

// ─── isClientLocalTool ──────────────────────────────────────────

describe('isClientLocalTool', () => {
  it('recognizes list_context and evict_context', () => {
    expect(isClientLocalTool('list_context')).toBe(true);
    expect(isClientLocalTool('evict_context')).toBe(true);
  });

  it('rejects PCP server tools', () => {
    expect(isClientLocalTool('remember')).toBe(false);
    expect(isClientLocalTool('recall')).toBe(false);
    expect(isClientLocalTool('send_to_inbox')).toBe(false);
    expect(isClientLocalTool('bootstrap')).toBe(false);
  });

  it('CLIENT_LOCAL_TOOLS set matches function', () => {
    for (const tool of CLIENT_LOCAL_TOOLS) {
      expect(isClientLocalTool(tool)).toBe(true);
    }
  });
});

// ─── handleClientLocalTool: list_context ────────────────────────

describe('handleClientLocalTool: list_context', () => {
  it('returns entry summary with metadata', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'Bootstrap identity context...', 'bootstrap');
    ledger.addEntry('user', 'What tasks do I have?');
    ledger.addEntry('system', 'get_inbox result: 3 messages', 'ink-tool');
    ledger.addEntry('assistant', 'You have 3 inbox messages.');

    const result = handleClientLocalTool('list_context', {}, ledger);
    expect(result).not.toBeNull();

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.totalEntries).toBe(4);
    expect(parsed.totalTokens).toBeGreaterThan(0);

    // Per-source breakdown
    expect(parsed.bySource.bootstrap.count).toBe(1);
    expect(parsed.bySource['ink-tool'].count).toBe(1);
    expect(parsed.bySource['(none)'].count).toBe(2); // user + assistant have no source

    // Entries have previews
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[0].role).toBe('system');
    expect(parsed.entries[0].source).toBe('bootstrap');
    expect(parsed.entries[0].preview).toContain('Bootstrap');
  });

  it('returns empty state for fresh ledger', () => {
    const ledger = new ContextLedger();
    const result = handleClientLocalTool('list_context', {}, ledger);
    const parsed = parseResult(result);

    expect(parsed.totalEntries).toBe(0);
    expect(parsed.totalTokens).toBe(0);
    expect(parsed.entries).toEqual([]);
  });

  it('includes bookmark info', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello');
    ledger.createBookmark('checkpoint-1');
    ledger.addEntry('assistant', 'world');

    const result = handleClientLocalTool('list_context', {}, ledger);
    const parsed = parseResult(result);

    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.bookmarks[0].label).toBe('checkpoint-1');
  });

  it('truncates long content to 120-char preview', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'x'.repeat(300), 'bootstrap');

    const result = handleClientLocalTool('list_context', {}, ledger);
    const parsed = parseResult(result);

    expect(parsed.entries[0].preview.length).toBeLessThanOrEqual(123); // 120 + "..."
    expect(parsed.entries[0].preview).toContain('...');
  });
});

// ─── handleClientLocalTool: evict_context ───────────────────────

describe('handleClientLocalTool: evict_context', () => {
  it('evicts by entryIds', () => {
    const ledger = new ContextLedger();
    const e1 = ledger.addEntry('user', 'keep');
    const e2 = ledger.addEntry('inbox', 'evict this');
    const e3 = ledger.addEntry('assistant', 'keep too');

    const result = handleClientLocalTool('evict_context', { entryIds: [e2.id] }, ledger);
    const parsed = parseResult(result);

    expect(parsed.success).toBe(true);
    expect(parsed.evicted).toBe(1);
    expect(parsed.tokensFreed).toBeGreaterThan(0);
    expect(ledger.listEntries().map((e) => e.id)).toEqual([e1.id, e3.id]);
  });

  it('evicts by source', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap 1', 'bootstrap');
    ledger.addEntry('user', 'user msg');
    ledger.addEntry('system', 'bootstrap 2', 'bootstrap');
    ledger.addEntry('assistant', 'reply');

    const result = handleClientLocalTool('evict_context', { source: 'bootstrap' }, ledger);
    const parsed = parseResult(result);

    expect(parsed.evicted).toBe(2);
    expect(ledger.listEntries()).toHaveLength(2);
    expect(ledger.listEntries().every((e) => e.source !== 'bootstrap')).toBe(true);
  });

  it('evicts by role', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('inbox', 'msg 1');
    ledger.addEntry('user', 'prompt');
    ledger.addEntry('inbox', 'msg 2');
    ledger.addEntry('assistant', 'response');

    const result = handleClientLocalTool('evict_context', { role: 'inbox' }, ledger);
    const parsed = parseResult(result);

    expect(parsed.evicted).toBe(2);
    expect(ledger.listEntries()).toHaveLength(2);
  });

  it('returns error when no filter provided', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello');

    const result = handleClientLocalTool('evict_context', {}, ledger);
    const parsed = parseResult(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Provide at least one filter');
    expect(ledger.listEntries()).toHaveLength(1); // unchanged
  });

  it('handles evicting non-existent IDs gracefully', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello');

    const result = handleClientLocalTool('evict_context', { entryIds: [999, 888] }, ledger);
    const parsed = parseResult(result);

    expect(parsed.success).toBe(true);
    expect(parsed.evicted).toBe(0);
    expect(parsed.tokensFreed).toBe(0);
    expect(ledger.listEntries()).toHaveLength(1);
  });

  it('reports totalAfter accurately', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'a'.repeat(100)); // ~25 tokens
    const e2 = ledger.addEntry('inbox', 'b'.repeat(200)); // ~50 tokens
    ledger.addEntry('assistant', 'c'.repeat(100)); // ~25 tokens

    const before = ledger.totalTokens();
    const result = handleClientLocalTool('evict_context', { entryIds: [e2.id] }, ledger);
    const parsed = parseResult(result);

    expect(parsed.totalAfter).toBe(before - parsed.tokensFreed);
    expect(parsed.totalAfter).toBe(ledger.totalTokens());
  });

  it('limits removedPreviews to 10 entries', () => {
    const ledger = new ContextLedger();
    for (let i = 0; i < 15; i++) {
      ledger.addEntry('inbox', `message ${i}`, 'inkmail');
    }

    const result = handleClientLocalTool('evict_context', { role: 'inbox' }, ledger);
    const parsed = parseResult(result);

    expect(parsed.evicted).toBe(15);
    expect(parsed.removedPreviews).toHaveLength(10); // capped
  });
});

// ─── list_context is a page, not the window (#571) ──────────────

describe('handleClientLocalTool: list_context paging', () => {
  function bigLedger(n: number): ContextLedger {
    const ledger = new ContextLedger();
    for (let i = 0; i < n; i++) {
      const source = i % 3 === 0 ? 'heartbeat' : i % 3 === 1 ? 'local-tool' : 'inkmail';
      ledger.addEntry(
        i % 4 === 0 ? 'inbox' : 'system',
        `entry ${i} ${'x'.repeat((i % 7) * 40)}`,
        source
      );
    }
    return ledger;
  }

  it('REGRESSION: never returns the whole window — one page, totals still complete', () => {
    const ledger = bigLedger(3500);
    const parsed = parseResult(handleClientLocalTool('list_context', {}, ledger));
    expect(parsed.totalEntries).toBe(3500);
    expect(parsed.entries).toHaveLength(LIST_CONTEXT_DEFAULT_LIMIT);
    expect(parsed.page).toMatchObject({ matched: 3500, offset: 0, returned: 50, remaining: 3450 });
    expect(parsed.note).toContain('3450 more');
    expect(parsed.bySource.heartbeat.count).toBe(1167);
    // The result the model reads stays small however large the window is.
    const text = (
      handleClientLocalTool('list_context', {}, ledger)!.content as Array<{ text: string }>
    )[0].text;
    expect(text.length).toBeLessThan(20_000);
  });

  it('pages with offset and caps limit', () => {
    const ledger = bigLedger(500);
    const p2 = parseResult(
      handleClientLocalTool('list_context', { offset: 50, limit: 25 }, ledger)
    );
    expect(p2.entries[0].preview).toContain('entry 50 ');
    expect(p2.entries).toHaveLength(25);
    const capped = parseResult(handleClientLocalTool('list_context', { limit: 10_000 }, ledger));
    expect(capped.entries).toHaveLength(LIST_CONTEXT_MAX_LIMIT);
    expect(capped.page.limit).toBe(LIST_CONTEXT_MAX_LIMIT);
  });

  it('filters by source, role and minimum size', () => {
    const ledger = bigLedger(300);
    const bySource = parseResult(
      handleClientLocalTool('list_context', { source: 'inkmail' }, ledger)
    );
    expect(bySource.page.matched).toBe(100);
    expect(bySource.entries.every((e: { source: string }) => e.source === 'inkmail')).toBe(true);
    const byRole = parseResult(handleClientLocalTool('list_context', { role: 'inbox' }, ledger));
    expect(byRole.page.matched).toBe(75);
    const big = parseResult(handleClientLocalTool('list_context', { minTokens: 50 }, ledger));
    expect(big.entries.every((e: { tokens: number }) => e.tokens >= 50)).toBe(true);
    expect(big.page.matched).toBeLessThan(300);
    expect(big.page.matched).toBeGreaterThan(0);
  });

  it('sorts largest-first so the model can find what is worth evicting', () => {
    const ledger = bigLedger(200);
    const parsed = parseResult(
      handleClientLocalTool('list_context', { sort: 'largest', limit: 5 }, ledger)
    );
    const tokens = parsed.entries.map((e: { tokens: number }) => e.tokens);
    expect([...tokens].sort((a, b) => b - a)).toEqual(tokens);
    const newest = parseResult(
      handleClientLocalTool('list_context', { sort: 'newest', limit: 1 }, ledger)
    );
    expect(newest.entries[0].preview).toContain('entry 199 ');
  });

  it('REGRESSION (Lumen, PR #576): many bookmarks cannot re-explode the payload', () => {
    const ledger = new ContextLedger();
    for (let i = 0; i < 3500; i++) {
      ledger.addEntry('inbox', `message ${i}`, 'inkmail');
      ledger.createBookmark(`bookmark ${i} ${'y'.repeat(84)}`);
    }
    const result = handleClientLocalTool('list_context', {}, ledger)!;
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.bookmarkCount).toBe(3500);
    expect(parsed.bookmarks).toHaveLength(LIST_CONTEXT_BOOKMARK_LIMIT);
    expect(parsed.bookmarksNotShown).toBe(3500 - LIST_CONTEXT_BOOKMARK_LIMIT);
    // The whole result still parses as one document — the relay cap must
    // never have to cut it mid-JSON.
    expect(text.length).toBeLessThan(20_000);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('truncates a long bookmark label and keeps the most recent bookmarks', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hi');
    for (let i = 0; i < 25; i++) ledger.createBookmark(`b${i} ${'z'.repeat(500)}`);
    const parsed = parseResult(handleClientLocalTool('list_context', {}, ledger));
    expect(parsed.bookmarks[parsed.bookmarks.length - 1].label.startsWith('b24 ')).toBe(true);
    for (const b of parsed.bookmarks) expect(b.label.length).toBeLessThanOrEqual(121);
  });

  it('no note when everything fits', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hi');
    const parsed = parseResult(handleClientLocalTool('list_context', {}, ledger));
    expect(parsed.note).toBeUndefined();
    expect(parsed.page.remaining).toBe(0);
  });
});

// ─── evict_context: refs go to the runtime, not the model (#571) ──

describe('handleClientLocalTool: evict_context refs', () => {
  it('REGRESSION: the model-facing result carries no evictRefs; the hook carries every one', () => {
    const ledger = new ContextLedger();
    for (let i = 0; i < 3000; i++) ledger.addEntry('inbox', `message ${i}`, 'inkmail');
    const hook = vi.fn();
    const result = handleClientLocalTool('evict_context', { role: 'inbox' }, ledger, undefined, {
      onEvict: hook,
    });
    const text = (result!.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.evicted).toBe(3000);
    expect(parsed.removedPreviews).toHaveLength(EVICT_CONTEXT_PREVIEW_LIMIT);
    expect(parsed.removedNotShown).toBe(2990);
    expect(parsed.evictRefs).toBeUndefined();
    expect(text.length).toBeLessThan(3_000);

    expect(hook).toHaveBeenCalledTimes(1);
    const eviction = hook.mock.calls[0][0];
    expect(eviction.args).toEqual({ role: 'inbox' });
    expect(eviction.refs).toHaveLength(3000);
    expect(eviction.refs[0]).toMatchObject({
      role: 'inbox',
      source: 'inkmail',
      hash: expect.any(String),
    });
    expect(eviction.tokensFreed).toBe(parsed.tokensFreed);
  });

  it('no hook call when nothing was evicted', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello');
    const hook = vi.fn();
    handleClientLocalTool('evict_context', { entryIds: [999] }, ledger, undefined, {
      onEvict: hook,
    });
    expect(hook).not.toHaveBeenCalled();
  });
});

// ─── handleClientLocalTool: unknown tool ────────────────────────

describe('handleClientLocalTool: unknown', () => {
  it('returns null for unrecognized tools', () => {
    const ledger = new ContextLedger();
    const result = handleClientLocalTool('remember', {}, ledger);
    expect(result).toBeNull();
  });
});

// ─── Integration: evict then list shows consistent state ────────

describe('evict → list consistency', () => {
  it('list_context reflects state after eviction', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap', 'bootstrap');
    ledger.addEntry('user', 'question');
    ledger.addEntry('inbox', 'stale message', 'inkmail');
    ledger.addEntry('assistant', 'answer');

    // Evict inbox
    handleClientLocalTool('evict_context', { source: 'inkmail' }, ledger);

    // List should show 3 entries, no inkmail source
    const listResult = handleClientLocalTool('list_context', {}, ledger);
    const parsed = parseResult(listResult);

    expect(parsed.totalEntries).toBe(3);
    expect(parsed.bySource['inkmail']).toBeUndefined();
    expect(parsed.entries.every((e: { source?: string }) => e.source !== 'inkmail')).toBe(true);
  });

  it('multiple sequential evictions accumulate correctly', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap', 'bootstrap');
    ledger.addEntry('inbox', 'inbox 1', 'inkmail');
    ledger.addEntry('system', 'tool result', 'local-tool');
    ledger.addEntry('user', 'question');
    ledger.addEntry('assistant', 'answer');

    // Evict inbox
    handleClientLocalTool('evict_context', { source: 'inkmail' }, ledger);
    expect(ledger.listEntries()).toHaveLength(4);

    // Evict tool results
    handleClientLocalTool('evict_context', { source: 'local-tool' }, ledger);
    expect(ledger.listEntries()).toHaveLength(3);

    // Evict bootstrap
    handleClientLocalTool('evict_context', { source: 'bootstrap' }, ledger);
    expect(ledger.listEntries()).toHaveLength(2);

    // Only user + assistant remain
    const roles = ledger.listEntries().map((e) => e.role);
    expect(roles).toEqual(['user', 'assistant']);
  });
});

// ─── Integration: evicted entries excluded from transcript ──────

describe('eviction affects prompt transcript', () => {
  it('evicted entries are excluded from buildPromptTranscript', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'BOOTSTRAP_MARKER', 'bootstrap');
    ledger.addEntry('user', 'USER_MARKER');
    ledger.addEntry('inbox', 'INBOX_MARKER', 'inkmail');
    ledger.addEntry('assistant', 'ASSISTANT_MARKER');

    // Before eviction: all present
    const before = ledger.buildPromptTranscript();
    expect(before).toContain('INBOX_MARKER');
    expect(before).toContain('BOOTSTRAP_MARKER');

    // Evict inbox
    handleClientLocalTool('evict_context', { role: 'inbox' }, ledger);

    // After eviction: inbox gone
    const after = ledger.buildPromptTranscript();
    expect(after).not.toContain('INBOX_MARKER');
    expect(after).toContain('BOOTSTRAP_MARKER');
    expect(after).toContain('USER_MARKER');
    expect(after).toContain('ASSISTANT_MARKER');
  });

  it('evicting all entries produces empty transcript', () => {
    const ledger = new ContextLedger();
    const e1 = ledger.addEntry('user', 'hello');
    const e2 = ledger.addEntry('assistant', 'world');

    handleClientLocalTool('evict_context', { entryIds: [e1.id, e2.id] }, ledger);

    const transcript = ledger.buildPromptTranscript();
    expect(transcript).toBe('');
  });
});

// ─── compact_context (task 609b1833) ────────────────────────────

describe('compact_context', () => {
  it('is client-local: policy bypass, never forwarded to the server, never persisted into the ledger', () => {
    expect(isClientLocalTool('compact_context')).toBe(true);
  });

  it('is refused by the generic handler — only the REPL host can compact', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello');
    const result = handleClientLocalTool('compact_context', { summary: 'x' }, ledger);
    expect(result?.isError).toBe(true);
    expect(parseResult(result).error).toContain('not available');
    expect(ledger.listEntries()).toHaveLength(1);
  });

  describe('parseCompactContextArgs', () => {
    it('accepts an agent-written summary and a keepRecent', () => {
      expect(parseCompactContextArgs({ summary: '  the brief  ', keepRecent: 4.7 })).toEqual({
        summary: 'the brief',
        keepRecent: 4,
      });
    });

    it('accepts nothing — the runtime summarizes with its default tail', () => {
      expect(parseCompactContextArgs({})).toEqual({});
    });

    it('rejects an empty or oversized summary and a bad keepRecent', () => {
      expect(parseCompactContextArgs({ summary: '   ' })).toMatchObject({
        error: expect.stringContaining('empty'),
      });
      expect(parseCompactContextArgs({ summary: 42 })).toMatchObject({
        error: expect.stringContaining('string'),
      });
      expect(
        parseCompactContextArgs({ summary: 'x'.repeat(COMPACT_CONTEXT_SUMMARY_MAX_CHARS + 1) })
      ).toMatchObject({ error: expect.stringContaining('ceiling') });
      expect(parseCompactContextArgs({ keepRecent: -1 })).toMatchObject({
        error: expect.stringContaining('non-negative'),
      });
      expect(parseCompactContextArgs({ keepRecent: 'many' })).toMatchObject({
        error: expect.stringContaining('non-negative'),
      });
      expect(
        parseCompactContextArgs({ keepRecent: COMPACT_CONTEXT_MAX_KEEP_RECENT + 1 })
      ).toMatchObject({
        error: expect.stringContaining('at most'),
      });
    });
  });
});
