import { describe, it, expect } from 'vitest';
import {
  parseEvictSelection,
  selectEvictionEntries,
  formatEvictCandidate,
} from './evict-selection.js';
import { ContextLedger } from './context-ledger.js';

describe('parseEvictSelection', () => {
  it('returns list mode when no selector given', () => {
    expect(parseEvictSelection([])).toEqual({ list: true, dryRun: false, force: false });
  });

  it('parses bookmark refs, preserving label case', () => {
    expect(parseEvictSelection(['bookmark:heavy']).bookmark).toBe('heavy');
    expect(parseEvictSelection(['bookmark:last']).bookmark).toBe('last');
    // Labels are user-chosen free text, unlike role: whose values are a
    // fixed lowercase set — lowercasing here would fail to match `Big Run`.
    expect(parseEvictSelection(['bookmark:Big Run']).bookmark).toBe('Big Run');
  });

  it('rejects an empty bookmark value', () => {
    expect(parseEvictSelection(['bookmark:']).error).toMatch(/bookmark: requires a value/);
  });

  it('rejects two bookmark filters', () => {
    expect(parseEvictSelection(['bookmark:a', 'bookmark:b']).error).toMatch(/Only one bookmark/);
  });

  it('parses --force', () => {
    const sel = parseEvictSelection(['bookmark:heavy', '--force']);
    expect(sel.force).toBe(true);
    expect(sel.bookmark).toBe('heavy');
    expect(parseEvictSelection(['3']).force).toBe(false);
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
    expect(sel.error).toMatch(/one selector at a time/);
  });

  it('rejects mixing source and role', () => {
    const sel = parseEvictSelection(['source:heartbeat', 'role:inbox']);
    expect(sel.error).toMatch(/one selector at a time/);
  });

  // Every unordered pair of the four selector kinds. The guard is a count,
  // so a pair it misses would be a pair that never reaches the count —
  // enumerated rather than sampled, because "some combinations are rejected"
  // is exactly what the old pairwise chain could claim while leaving holes.
  it('rejects every pair of selector kinds', () => {
    const kinds: Array<[string, string[]]> = [
      ['ids', ['3']],
      ['source', ['source:heartbeat']],
      ['role', ['role:inbox']],
      ['bookmark', ['bookmark:heavy']],
    ];
    const pairs: string[] = [];
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const sel = parseEvictSelection([...kinds[i][1], ...kinds[j][1]]);
        pairs.push(`${kinds[i][0]}+${kinds[j][0]}`);
        expect(sel.error, `${kinds[i][0]} + ${kinds[j][0]} should be rejected`).toMatch(
          /one selector at a time/
        );
      }
    }
    expect(pairs).toHaveLength(6);
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
    const matched = selectEvictionEntries(entries, sel)!;
    expect(matched.map((e) => e.id)).toEqual([1, 4]);
  });

  it('selects by source', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['source:heartbeat']))!;
    expect(matched).toHaveLength(2);
    expect(matched.every((e) => e.source === 'heartbeat')).toBe(true);
  });

  it('selects by role', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['role:inbox']))!;
    expect(matched.map((e) => e.role)).toEqual(['inbox']);
  });

  it('returns nothing for list mode and errors', () => {
    const entries = buildLedger().listEntries();
    expect(selectEvictionEntries(entries, parseEvictSelection([]))).toEqual([]);
    expect(selectEvictionEntries(entries, parseEvictSelection(['role:bogus']))).toEqual([]);
  });

  it('ignores unknown ids silently', () => {
    const entries = buildLedger().listEntries();
    const matched = selectEvictionEntries(entries, parseEvictSelection(['99']))!;
    expect(matched).toEqual([]);
  });

  it('selects to a bookmark through the ledger, not a second cutoff rule', () => {
    const ledger = buildLedger();
    const bookmark = ledger.createBookmark('halfway');
    ledger.addEntry('user', 'after the bookmark');

    const matched = selectEvictionEntries(
      ledger.listEntries(),
      parseEvictSelection([`bookmark:${bookmark.label}`]),
      (ref) => ledger.previewEvictToBookmark(ref)?.removedEntries ?? null
    )!;

    expect(matched.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(matched.map((e) => e.content)).not.toContain('after the bookmark');
  });

  it('distinguishes an unknown bookmark from a selector that matched nothing', () => {
    const ledger = buildLedger();
    const unknown = selectEvictionEntries(
      ledger.listEntries(),
      parseEvictSelection(['bookmark:nope']),
      (ref) => ledger.previewEvictToBookmark(ref)?.removedEntries ?? null
    );
    expect(unknown).toBeNull();

    // Contrast: a real selector with no matches is an empty array, and the
    // caller reports those two cases with different text.
    const empty = selectEvictionEntries(ledger.listEntries(), parseEvictSelection(['99']));
    expect(empty).toEqual([]);
  });

  it('reports an unwired resolver as unresolvable rather than evicting nothing', () => {
    const ledger = buildLedger();
    ledger.createBookmark('halfway');
    expect(
      selectEvictionEntries(ledger.listEntries(), parseEvictSelection(['bookmark:halfway']))
    ).toBeNull();
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
