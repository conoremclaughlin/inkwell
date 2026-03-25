import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { isClientLocalTool, handleClientLocalTool, CLIENT_LOCAL_TOOLS } from './context-tools.js';
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
    ledger.addEntry('system', 'get_inbox result: 3 messages', 'pcp-tool');
    ledger.addEntry('assistant', 'You have 3 inbox messages.');

    const result = handleClientLocalTool('list_context', {}, ledger);
    expect(result).not.toBeNull();

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.totalEntries).toBe(4);
    expect(parsed.totalTokens).toBeGreaterThan(0);

    // Per-source breakdown
    expect(parsed.bySource.bootstrap.count).toBe(1);
    expect(parsed.bySource['pcp-tool'].count).toBe(1);
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
      ledger.addEntry('inbox', `message ${i}`, 'pcp-inbox');
    }

    const result = handleClientLocalTool('evict_context', { role: 'inbox' }, ledger);
    const parsed = parseResult(result);

    expect(parsed.evicted).toBe(15);
    expect(parsed.removedPreviews).toHaveLength(10); // capped
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
    ledger.addEntry('inbox', 'stale message', 'pcp-inbox');
    ledger.addEntry('assistant', 'answer');

    // Evict inbox
    handleClientLocalTool('evict_context', { source: 'pcp-inbox' }, ledger);

    // List should show 3 entries, no pcp-inbox source
    const listResult = handleClientLocalTool('list_context', {}, ledger);
    const parsed = parseResult(listResult);

    expect(parsed.totalEntries).toBe(3);
    expect(parsed.bySource['pcp-inbox']).toBeUndefined();
    expect(parsed.entries.every((e: { source?: string }) => e.source !== 'pcp-inbox')).toBe(true);
  });

  it('multiple sequential evictions accumulate correctly', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'bootstrap', 'bootstrap');
    ledger.addEntry('inbox', 'inbox 1', 'pcp-inbox');
    ledger.addEntry('system', 'tool result', 'local-tool');
    ledger.addEntry('user', 'question');
    ledger.addEntry('assistant', 'answer');

    // Evict inbox
    handleClientLocalTool('evict_context', { source: 'pcp-inbox' }, ledger);
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
    ledger.addEntry('inbox', 'INBOX_MARKER', 'pcp-inbox');
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
