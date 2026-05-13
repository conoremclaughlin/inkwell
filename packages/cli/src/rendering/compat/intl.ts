/**
 * Shim for Claude Code's src/utils/intl.ts
 *
 * The rendering engine's termio/parser.ts uses getGraphemeSegmenter()
 * for Unicode text processing. Copied from Claude Code with only the
 * functions the rendering engine actually imports.
 */

let graphemeSegmenter: Intl.Segmenter | null = null;

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
  }
  return graphemeSegmenter;
}

export function firstGrapheme(text: string): string {
  if (!text) return '';
  const segments = getGraphemeSegmenter().segment(text);
  const first = segments[Symbol.iterator]().next().value;
  return first?.segment ?? '';
}

export function lastGrapheme(text: string): string {
  if (!text) return '';
  let last = '';
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    last = segment;
  }
  return last;
}
