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
});

