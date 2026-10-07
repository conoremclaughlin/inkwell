import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { autoEvictTombstone, isWriteSideTool, selectConsumedToolResults } from './auto-evict.js';

describe('tool-image auto eviction', () => {
  it.each(['view_image', 'mcp__inkwell__view_image'])('%s is a repeatable read', (name) => {
    expect(isWriteSideTool(name)).toBe(false);
    expect(isWriteSideTool('download_image')).toBe(true);
  });

  it('counts image tokens toward a sweep and protects images in recent turns', () => {
    const ledger = new ContextLedger();
    const image = {
      ref: 'img:0123456789abcdef',
      path: '/synthetic/cache/image.png',
      mimeType: 'image/png',
      width: 1536,
      height: 1024,
      approxTokens: 2098,
    };
    const old = ledger.addEntry(
      'system',
      `local tool view_image -> ${image.ref}`,
      'local-tool',
      undefined,
      undefined,
      [image]
    );
    ledger.addEntry('assistant', 'saw the first image');
    const recent = { ...image, ref: 'img:fedcba9876543210' };
    ledger.addEntry(
      'system',
      `local tool read -> ${recent.ref}`,
      'local-tool',
      undefined,
      undefined,
      [recent]
    );
    ledger.addEntry('assistant', 'saw the second image');

    const selected = selectConsumedToolResults(ledger.listEntries(), {
      keepRecentTurns: 1,
      minTokens: 2000,
    });
    expect(selected).toMatchObject({
      ids: [old.id],
      tokens: old.approxTokens,
      reads: ['view_image'],
      receipts: [],
      failed: [],
      refused: [],
    });
    expect(autoEvictTombstone(selected!, 1)).toContain('read calls (view_image)');
    const evicted = ledger.evictEntries(selected!.ids);
    expect(evicted.removedTokens).toBe(old.approxTokens);
    expect(ledger.listImages()).toEqual([recent]);
  });
});
