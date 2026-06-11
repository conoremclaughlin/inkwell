import { describe, it, expect } from 'vitest';
import { collapseImagePaths, normalizeEventContent } from './MessageLine.js';

describe('collapseImagePaths', () => {
  it('collapses absolute PNG path', () => {
    expect(collapseImagePaths('/Users/conor/Desktop/screenshot.png')).toBe('[Image #1]');
  });

  it('collapses absolute JPG path', () => {
    expect(collapseImagePaths('/tmp/photo.jpg')).toBe('[Image #1]');
  });

  it('collapses file:// URI', () => {
    expect(collapseImagePaths('file:///Users/conor/image.webp')).toBe('[Image #1]');
  });

  it('numbers multiple images sequentially', () => {
    const input = 'Here is /tmp/a.png and also /tmp/b.jpg end';
    expect(collapseImagePaths(input)).toBe('Here is [Image #1] and also [Image #2] end');
  });

  it('handles various extensions', () => {
    expect(collapseImagePaths('/a/b.gif')).toBe('[Image #1]');
    expect(collapseImagePaths('/a/b.svg')).toBe('[Image #1]');
    expect(collapseImagePaths('/a/b.webp')).toBe('[Image #1]');
    expect(collapseImagePaths('/a/b.heic')).toBe('[Image #1]');
    expect(collapseImagePaths('/a/b.bmp')).toBe('[Image #1]');
    expect(collapseImagePaths('/a/b.tiff')).toBe('[Image #1]');
  });

  it('is case-insensitive for extensions', () => {
    expect(collapseImagePaths('/tmp/photo.PNG')).toBe('[Image #1]');
    expect(collapseImagePaths('/tmp/photo.Jpeg')).toBe('[Image #1]');
  });

  it('leaves non-image paths alone', () => {
    expect(collapseImagePaths('/tmp/file.txt')).toBe('/tmp/file.txt');
    expect(collapseImagePaths('/tmp/data.json')).toBe('/tmp/data.json');
  });

  it('leaves plain text alone', () => {
    expect(collapseImagePaths('Hello world')).toBe('Hello world');
  });

  it('handles paths with dots in directory names', () => {
    expect(collapseImagePaths('/Users/my.name/Desktop/screenshot.png')).toBe('[Image #1]');
  });

  it('handles mixed content with images and text', () => {
    const input = 'Check this /Users/me/Downloads/chart.png — it shows the data';
    expect(collapseImagePaths(input)).toBe('Check this [Image #1] — it shows the data');
  });
});

describe('normalizeEventContent', () => {
  it('strips plain leading indentation', () => {
    expect(normalizeEventContent('  🛠 send_response (executed)')).toBe(
      '🛠 send_response (executed)'
    );
    expect(normalizeEventContent('\t⚡ state change')).toBe('⚡ state change');
  });

  it('strips spaces hidden behind leading ANSI sequences (chalk-wrapped live events)', () => {
    // chalk.dim('  🗑 evicted…') — SGR escape precedes the embedded spaces
    const dim = '\u001b[2m  🗑 evicted 5 entries\u001b[22m';
    expect(normalizeEventContent(dim)).toBe('\u001b[2m🗑 evicted 5 entries\u001b[22m');
    // Stacked sequences (e.g. dim + yellow)
    const stacked = '\u001b[2m\u001b[33m  ⛁ compacting\u001b[39m\u001b[22m';
    expect(normalizeEventContent(stacked)).toBe(
      '\u001b[2m\u001b[33m⛁ compacting\u001b[39m\u001b[22m'
    );
  });

  it('leaves unindented content untouched', () => {
    expect(normalizeEventContent('─── ⌃ out of context ───')).toBe('─── ⌃ out of context ───');
    expect(normalizeEventContent('\u001b[2m🛠 already flush\u001b[22m')).toBe(
      '\u001b[2m🛠 already flush\u001b[22m'
    );
  });
});
