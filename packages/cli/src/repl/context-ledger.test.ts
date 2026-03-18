import { describe, expect, it } from 'vitest';
import { ContextLedger, estimateTokens } from './context-ledger.js';

describe('ContextLedger', () => {
  it('estimates tokens from content length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('tracks entries and total tokens', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'hello world');
    ledger.addEntry('assistant', 'hey there');

    const entries = ledger.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
    expect(ledger.totalTokens()).toBeGreaterThan(0);
  });

  it('creates bookmarks and ejects context up to bookmark', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'one');
    const bookmark = ledger.createBookmark('first');
    ledger.addEntry('assistant', 'two');
    ledger.addEntry('user', 'three');

    const result = ledger.ejectToBookmark(bookmark.id);
    expect(result).not.toBeNull();
    expect(result?.removedEntries).toHaveLength(1);
    expect(ledger.listEntries().map((entry) => entry.content)).toEqual(['two', 'three']);
  });

  it('previews ejection without mutating entries', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'a');
    const bookmark = ledger.createBookmark('first');
    ledger.addEntry('assistant', 'b');

    const preview = ledger.previewEjectToBookmark(bookmark.id);
    expect(preview?.removedEntries.map((entry) => entry.content)).toEqual(['a']);
    expect(ledger.listEntries().map((entry) => entry.content)).toEqual(['a', 'b']);
  });

  it('builds transcript respecting maxTokens', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', '1111111111'); // ~3 tokens
    ledger.addEntry('assistant', '2222222222'); // ~3 tokens
    ledger.addEntry('user', '3333333333'); // ~3 tokens

    const transcript = ledger.buildPromptTranscript({ maxTokens: 6 });
    expect(transcript).toContain('ASSISTANT');
    expect(transcript).toContain('3333333333');
    expect(transcript).not.toContain('1111111111');
  });

  it('trims oldest entries to budget while preserving recent entries', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'one'.repeat(20));
    ledger.addEntry('assistant', 'two'.repeat(20));
    ledger.addEntry('user', 'three'.repeat(20));
    ledger.addEntry('assistant', 'four'.repeat(20));

    const before = ledger.totalTokens();
    const result = ledger.trimOldestToTokenBudget(Math.floor(before * 0.55), 2);

    expect(result.removedEntries.length).toBeGreaterThan(0);
    expect(result.removedTokens).toBeGreaterThan(0);
    expect(result.totalAfter).toBeLessThan(before);
    const remaining = ledger.listEntries().map((entry) => entry.content);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toContain('three');
    expect(remaining[1]).toContain('four');
  });

  it('updates bookmarks when trimming old entries', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'a'.repeat(40));
    ledger.addEntry('assistant', 'b'.repeat(40));
    ledger.addEntry('user', 'c'.repeat(40));
    const bookmark = ledger.createBookmark('tail');
    ledger.addEntry('assistant', 'd'.repeat(40));

    const before = ledger.totalTokens();
    const trim = ledger.trimOldestToTokenBudget(Math.floor(before * 0.5), 1);
    expect(trim.removedEntries.length).toBeGreaterThan(0);

    const bookmarks = ledger.listBookmarks();
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]?.id).toBe(bookmark.id);
    expect(bookmarks[0]?.entryIndex).toBeGreaterThanOrEqual(0);
  });

  describe('evictEntries', () => {
    it('removes specific entries by ID', () => {
      const ledger = new ContextLedger();
      const e1 = ledger.addEntry('user', 'keep this');
      const e2 = ledger.addEntry('inbox', 'irrelevant inbox message');
      const e3 = ledger.addEntry('assistant', 'keep this too');
      const e4 = ledger.addEntry('inbox', 'another irrelevant message');

      const result = ledger.evictEntries([e2.id, e4.id]);
      expect(result.removedEntries).toHaveLength(2);
      expect(result.removedTokens).toBeGreaterThan(0);
      expect(ledger.listEntries().map((e) => e.id)).toEqual([e1.id, e3.id]);
    });

    it('returns empty result for non-existent IDs', () => {
      const ledger = new ContextLedger();
      ledger.addEntry('user', 'hello');
      const result = ledger.evictEntries([999]);
      expect(result.removedEntries).toHaveLength(0);
      expect(ledger.listEntries()).toHaveLength(1);
    });

    it('adjusts bookmarks after eviction', () => {
      const ledger = new ContextLedger();
      ledger.addEntry('user', 'a');
      const e2 = ledger.addEntry('inbox', 'remove me');
      ledger.addEntry('assistant', 'b');
      const bm = ledger.createBookmark('after-b');
      ledger.addEntry('user', 'c');

      ledger.evictEntries([e2.id]);
      const bookmarks = ledger.listBookmarks();
      expect(bookmarks).toHaveLength(1);
      expect(bookmarks[0].entryIndex).toBe(1); // was 2, shifted down by 1
    });
  });

  describe('evictBySource', () => {
    it('removes all entries from a source', () => {
      const ledger = new ContextLedger();
      ledger.addEntry('system', 'bootstrap data', 'bootstrap');
      ledger.addEntry('user', 'hello');
      ledger.addEntry('system', 'more bootstrap', 'bootstrap');
      ledger.addEntry('assistant', 'response');

      const result = ledger.evictBySource('bootstrap');
      expect(result.removedEntries).toHaveLength(2);
      expect(ledger.listEntries()).toHaveLength(2);
      expect(ledger.listEntries().map((e) => e.role)).toEqual(['user', 'assistant']);
    });
  });

  describe('evictByRole', () => {
    it('removes all entries of a role', () => {
      const ledger = new ContextLedger();
      ledger.addEntry('inbox', 'inbox 1');
      ledger.addEntry('user', 'user msg');
      ledger.addEntry('inbox', 'inbox 2');
      ledger.addEntry('assistant', 'reply');

      const result = ledger.evictByRole('inbox');
      expect(result.removedEntries).toHaveLength(2);
      expect(ledger.listEntries()).toHaveLength(2);
    });
  });

  describe('summarizeEntries', () => {
    it('returns entry metadata with previews', () => {
      const ledger = new ContextLedger();
      ledger.addEntry('user', 'a short message');
      ledger.addEntry('assistant', 'x'.repeat(200), 'pcp-tool');

      const summary = ledger.summarizeEntries();
      expect(summary).toHaveLength(2);
      expect(summary[0].preview).toBe('a short message');
      expect(summary[1].preview.length).toBeLessThanOrEqual(123); // 120 + "..."
      expect(summary[1].source).toBe('pcp-tool');
    });
  });
});
