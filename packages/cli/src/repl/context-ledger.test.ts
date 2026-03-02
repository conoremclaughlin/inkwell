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
});
