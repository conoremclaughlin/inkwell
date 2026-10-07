import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import {
  LEDGER_ENTRY_FRAME_BYTES,
  ledgerEntryPromptBytes,
  relayBudgetBytes,
} from './session-budget.js';

describe('ledgerEntryPromptBytes', () => {
  it('retains exact UTF-8 text and framing accounting without images', () => {
    const entry = { role: 'system', content: '图🌱', source: 'local-tool' };
    const textBytes = new TextEncoder().encode(
      entry.role + entry.content + entry.source
    ).byteLength;
    expect(ledgerEntryPromptBytes(entry)).toBe(textBytes + LEDGER_ENTRY_FRAME_BYTES);
    expect(ledgerEntryPromptBytes({ ...entry, images: [] })).toBe(ledgerEntryPromptBytes(entry));
  });

  it('charges every image separately from the text and reduces stateless relay headroom', () => {
    const ledger = new ContextLedger();
    const image = {
      ref: 'img:0123456789abcdef',
      path: '/synthetic/cache/image.png',
      mimeType: 'image/png',
      width: 1536,
      height: 1024,
      approxTokens: 2098,
    };
    const entry = ledger.addEntry('system', image.ref, 'local-tool', undefined, undefined, [
      image,
      image,
    ]);
    const textOnly = ledgerEntryPromptBytes({ ...entry, images: undefined });
    const withImages = ledgerEntryPromptBytes(entry);
    expect(withImages).toBe(textOnly + 4196);
    const runtime = { maxContextTokens: 40_000 };
    expect(
      relayBudgetBytes(runtime, 10_000 + textOnly) - relayBudgetBytes(runtime, 10_000 + withImages)
    ).toBe(2098);
  });
});
