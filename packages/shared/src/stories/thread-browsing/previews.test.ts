import { describe, expect, it } from 'vitest';
import { plainPreview } from './previews.js';

describe('plainPreview', () => {
  it('keeps the words and drops the markdown around them', () => {
    expect(plainPreview('## Round 2\n\n**approve** — see [the diff](https://example.com/d)')).toBe(
      'Round 2 approve — see the diff'
    );
    expect(plainPreview('> quoted `code` and _emphasis_.')).toBe('quoted code and emphasis.');
  });

  it('leaves snake_case and paths alone', () => {
    expect(plainPreview('set thread_key on inbox_thread_messages')).toBe(
      'set thread_key on inbox_thread_messages'
    );
    expect(plainPreview('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});
