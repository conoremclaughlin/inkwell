import { describe, it, expect } from 'vitest';
import {
  parseEvictSelection,
  selectEvictionEntries,
  formatEvictCandidate,
} from './evict-selection.js';
import { ContextLedger } from './context-ledger.js';

describe('parseEvictSelection', () => {
  it('returns list mode when no selector given', () => {
    expect(parseEvictSelection([])).toEqual({ list: true, dryRun: false });
  });

  it('list mode with dry-run flag alone', () => {
    const sel = parseEvictSelection(['--dry-run']);
    expect(sel.list).toBe(true);
    expect(sel.dryRun).toBe(true);
  });

  it('parses bare ids', () => {
    const sel = parseEvictSelection(['3', '5']);
    expect(sel.ids).toEqual([3, 5]);
    expect(sel.list).toBe(false);
  });

  it('parses comma-separated ids and dedupes', () => {
    const sel = parseEvictSelection(['3,5', '5', '7']);
    expect(sel.ids).toEqual([3, 5, 7]);
  });

  it('parses source: filter', () => {
    const sel = parseEvictSelection(['source:heartbeat']);
    expect(sel.source).toBe('heartbeat');
    expect(sel.ids).toBeUndefined();
  });

  it('parses role: filter', () => {
    const sel = parseEvictSelection(['role:inbox']);
    expect(sel.role).toBe('inbox');
  });

  it('rejects invalid role', () => {
    const sel = parseEvictSelection(['role:bogus']);
    expect(sel.error).toMatch(/role: must be one of/);
  });

  it('rejects empty source value', () => {
    const sel = parseEvictSelection(['source:']);
    expect(sel.error).toMatch(/source: requires a value/);
  });

  it('rejects mixing ids with filters', () => {
    const sel = parseEvictSelection(['3', 'source:heartbeat']);
    expect(sel.error).toMatch(/not both/);
  });

  it('rejects mixing source and role', () => {
    const sel = parseEvictSelection(['source:heartbeat', 'role:inbox']);
    expect(sel.error).toMatch(/not both/);
  });

  it('rejects garbage selectors', () => {
    const sel = parseEvictSelection(['heartbeat']);
    expect(sel.error).toMatch(/Unrecognized selector/);
  });

  it('rejects zero and negative ids', () => {
    expect(parseEvictSelection(['0']).error).toBeTruthy();
    expect(parseEvictSelection(['-3']).error).toBeTruthy();
  });

  it('rejects malformed numeric tokens that parseInt would truncate', () => {
    // Each of these parses to 1 under Number.parseInt — accepting them
    // would silently evict entry #1 instead of erroring
    expect(parseEvictSelection(['1abc']).error).toMatch(/Unrecognized selector/);
    expect(parseEvictSelection(['1.5']).error).toMatch(/Unrecognized selector/);
    expect(parseEvictSelection(['1e3']).error).toMatch(/Unrecognized selector/);
    expect(parseEvictSelection(['3,abc']).error).toMatch(/Unrecognized selector/);
    expect(parseEvictSelection(['+3']).error).toMatch(/Unrecognized selector/);
    expect(parseEvictSelection(['3 ', '0x2']).error).toBeTruthy();
  });

  it('accepts dry-run alongside a filter', () => {
    const sel = parseEvictSelection(['source:heartbeat', '--dry-run']);
    expect(sel.source).toBe('heartbeat');
    expect(sel.dryRun).toBe(true);
    expect(sel.error).toBeUndefined();
  });
});

describe('selectEvictionEntries', () => {
  const buildLedger = () => {
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'heartbeat reminder one', 'heartbeat');
    ledger.addEntry('user', 'hello there');
    ledger.addEntry('assistant', 'hi! how can I help?');
    ledger.addEntry('system', 'heartbeat reminder two', 'heartbeat');
    ledger.addEntry('inbox', 'message from lumen', 'inbox-poll');
    return ledger;
  };

  it('selects by ids in ledger order', () => {
    const entries = buildLedger().listEntries();
    const sel = parseEvictSelection(['4,1']);
    const matched = selectEvictionEntries(entries, sel);
    expect(matched.map((e) => e.id)).toEqual([1, 4]);
  });

  it('selects by source', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['source:heartbeat']));
    expect(matched).toHaveLength(2);
    expect(matched.every((e) => e.source === 'heartbeat')).toBe(true);
  });

  it('selects by role', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['role:inbox']));
    expect(matched.map((e) => e.role)).toEqual(['inbox']);
  });

  it('returns nothing for list mode and errors', () => {
    const entries = buildLedger().listEntries();
    expect(selectEvictionEntries(entries, parseEvictSelection([]))).toEqual([]);
    expect(selectEvictionEntries(entries, parseEvictSelection(['role:bogus']))).toEqual([]);
  });

  it('ignores unknown ids silently', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['99']));
    expect(matched).toEqual([]);
  });
});

describe('formatEvictCandidate', () => {
  it('renders id, role/source, tokens, preview', () => {
    const ledger = new ContextLedger();
    const entry = ledger.addEntry('system', 'heartbeat reminder with    extra space', 'heartbeat');
    const line = formatEvictCandidate(entry);
    expect(line).toContain(`#${entry.id}`);
    expect(line).toContain('[system/heartbeat]');
    expect(line).toContain('heartbeat reminder with extra space');
  });

  it('truncates long previews', () => {
    const ledger = new ContextLedger();
    const entry = ledger.addEntry('user', 'x'.repeat(500));
    const line = formatEvictCandidate(entry, 40);
    expect(line.length).toBeLessThan(120);
  });
});
