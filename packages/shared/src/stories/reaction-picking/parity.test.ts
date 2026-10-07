// What the Inkling app's byte-identical copy is held to (design
// ink://designs/reaction-emoji-catalog §1). The app runs the same checks
// against its copy, with the same manifest and vectors.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeReactionEmoji } from '../reacting/index.js';
import { searchEmoji } from './index.js';
import { EMOJI_PARITY_DIGEST, EMOJI_PARITY_FILES } from './parity-manifest.generated.js';
import { NORMALIZE_VECTORS, SEARCH_VECTORS } from './parity-vectors.js';

const STORIES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const REGENERATE = 'regenerate: node scripts/generate-emoji-catalog.mjs --manifest';

describe('the parity manifest', () => {
  it('lists every module a copy needs from both stories, and nothing else', () => {
    const modules = ['reacting', 'reaction-picking'].flatMap((dir) =>
      readdirSync(path.join(STORIES, dir))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .filter((f) => f !== 'parity-manifest.generated.ts')
        .map((f) => `${dir}/${f}`)
    );
    expect(EMOJI_PARITY_FILES.map(([file]) => file).sort(), REGENERATE).toEqual(modules.sort());
  });

  it('matches every listed file byte for byte', () => {
    const stale = EMOJI_PARITY_FILES.filter(
      ([file, sha]) => sha256(readFileSync(path.join(STORIES, file))) !== sha
    ).map(([file]) => file);
    expect(stale, REGENERATE).toEqual([]);
  });

  it('carries the digest of its own list', () => {
    const lines = [...EMOJI_PARITY_FILES]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, sha]) => `${file}\t${sha}\n`)
      .join('');
    expect(sha256(lines)).toBe(EMOJI_PARITY_DIGEST);
  });
});

describe('the parity vectors', () => {
  it.each(NORMALIZE_VECTORS)('normalizeReactionEmoji(%j) is %j', (input, stored) => {
    expect(normalizeReactionEmoji(input)).toBe(stored);
  });

  it.each(SEARCH_VECTORS)('searching %j finds %j', (query, emoji) => {
    expect(searchEmoji(query).map((e) => e.emoji)).toContain(emoji);
  });
});
