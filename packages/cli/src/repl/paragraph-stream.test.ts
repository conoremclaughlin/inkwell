import { describe, it, expect } from 'vitest';
import { ParagraphStreamBuffer } from './paragraph-stream.js';

describe('ParagraphStreamBuffer', () => {
  it('holds partial text until a blank-line boundary completes it', () => {
    const buf = new ParagraphStreamBuffer();
    expect(buf.push('Hello ')).toEqual([]);
    expect(buf.push('world.')).toEqual([]);
    expect(buf.push('\n\nNext')).toEqual(['Hello world.']);
    expect(buf.flush()).toBe('Next');
  });

  it('emits multiple paragraphs completed by one chunk', () => {
    const buf = new ParagraphStreamBuffer();
    expect(buf.push('One.\n\nTwo.\n\nThr')).toEqual(['One.', 'Two.']);
    expect(buf.flush()).toBe('Thr');
  });

  it('keeps single newlines (bullet lists) inside one paragraph', () => {
    const buf = new ParagraphStreamBuffer();
    const paras = buf.push('Notable:\n• a\n• b\n\ntail');
    expect(paras).toEqual(['Notable:\n• a\n• b']);
  });

  it('treats three-plus newlines as one boundary', () => {
    const buf = new ParagraphStreamBuffer();
    expect(buf.push('One.\n\n\n\nTwo.\n\n')).toEqual(['One.', 'Two.']);
    expect(buf.flush()).toBeNull();
  });

  it('never splits an open code fence across paragraphs', () => {
    const buf = new ParagraphStreamBuffer();
    expect(buf.push('Before.\n\n```ink-tool\n{"tool":"x",\n\n"args":{}}\n')).toEqual(['Before.']);
    // Fence still open — blank lines inside it must not flush.
    expect(buf.push('```\n\nAfter.\n\n')).toEqual([
      '```ink-tool\n{"tool":"x",\n\n"args":{}}\n```',
      'After.',
    ]);
  });

  it('flush() drains an unclosed fence at block end', () => {
    const buf = new ParagraphStreamBuffer();
    buf.push('```json\n{"a":1}\n\nstill inside');
    expect(buf.flush()).toBe('```json\n{"a":1}\n\nstill inside');
    expect(buf.flush()).toBeNull();
  });

  it('reset() drops buffered content', () => {
    const buf = new ParagraphStreamBuffer();
    buf.push('half a paragraph');
    buf.reset();
    expect(buf.flush()).toBeNull();
  });

  it('skips whitespace-only paragraphs', () => {
    const buf = new ParagraphStreamBuffer();
    expect(buf.push('   \n\nReal.\n\n')).toEqual(['Real.']);
  });
});
