import { describe, it, expect } from 'vitest';
import { ParagraphStreamBuffer, StreamedTurnRenderer } from './paragraph-stream.js';

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

describe('StreamedTurnRenderer', () => {
  it('labels the first line, continues the rest', () => {
    const r = new StreamedTurnRenderer();
    const lines = r.pushDelta('One.\n\nTwo.\n\ntail');
    expect(lines).toEqual([
      { text: 'One.', continuation: false },
      { text: 'Two.', continuation: true },
    ]);
  });

  it('REGRESSION (Lumen): an interleaved echo forces a fresh header on the next paragraph', () => {
    const r = new StreamedTurnRenderer();
    expect(r.pushDelta('First paragraph.\n\n')).toEqual([
      { text: 'First paragraph.', continuation: false },
    ]);
    // Queued user echo lands between streamed paragraphs.
    r.noteInterleave();
    expect(r.pushDelta('Second paragraph.\n\n')).toEqual([
      { text: 'Second paragraph.', continuation: false },
    ]);
  });

  it('REGRESSION (Lumen): multi-text-block message dedupes against the CONCATENATED final', () => {
    // The parser emits one message-level text event ("OneTwo") after both
    // blocks streamed as deltas. The old per-block comparison saw only "Two"
    // and reprinted the whole body.
    const r = new StreamedTurnRenderer();
    r.pushDelta('One');
    r.pushDelta('Two');
    const lines = r.completeMessage('OneTwo');
    expect(lines).toEqual([{ text: 'OneTwo', continuation: false }]);
    expect(r.shouldSkipFinal('OneTwo')).toBe(true);
  });

  it('a continued message (text → thinking → text) dedupes against the whole message (#569)', () => {
    // The parser emits the second text block of the same assistant message
    // flagged `continuesMessage`; final-response extraction concatenates the
    // blocks, so the dedupe comparison must too.
    const r = new StreamedTurnRenderer();
    r.pushDelta('One');
    r.completeMessage('One');
    r.pushDelta('Two');
    r.completeMessage('Two', { continuesMessage: true });
    expect(r.shouldSkipFinal('OneTwo')).toBe(true);
    expect(r.shouldSkipFinal('Two')).toBe(false);
  });

  it('renders the whole message when no deltas arrived (block-level fallback)', () => {
    const r = new StreamedTurnRenderer();
    const lines = r.completeMessage('Full message.\n\nTwo paragraphs.');
    expect(lines).toEqual([{ text: 'Full message.\n\nTwo paragraphs.', continuation: false }]);
    expect(r.shouldSkipFinal('Full message.\n\nTwo paragraphs.')).toBe(true);
  });

  it('does not skip the final render when nothing visible streamed', () => {
    const strip = (t: string) => t.replace(/```ink-tool[\s\S]*?```/gi, '').trim();
    const r = new StreamedTurnRenderer(strip);
    r.pushDelta('```ink-tool\n{"tool":"x","args":{}}\n```\n\n');
    const lines = r.completeMessage('```ink-tool\n{"tool":"x","args":{}}\n```');
    expect(lines).toEqual([]); // stripped to nothing — no visible stream
    expect(r.shouldSkipFinal('(local tool call emitted; see tool results above)')).toBe(false);
  });

  it('applies the display transform and dedupes on transformed text', () => {
    const strip = (t: string) => t.replace(/```ink-tool[\s\S]*?```/gi, '').trim();
    const r = new StreamedTurnRenderer(strip);
    r.pushDelta('Answer text.\n\n```ink-tool\n{"tool":"x","args":{}}\n```\n\n');
    r.completeMessage('Answer text.\n\n```ink-tool\n{"tool":"x","args":{}}\n```');
    // Display form (stripped) matches what streamed → skip.
    expect(r.shouldSkipFinal('Answer text.')).toBe(true);
  });

  it('does not skip when the final text differs from the streamed message', () => {
    const r = new StreamedTurnRenderer();
    r.pushDelta('Interim thought.\n\n');
    r.completeMessage('Interim thought.');
    expect(r.shouldSkipFinal('A different final result string.')).toBe(false);
  });

  it('reset() clears state between turns', () => {
    const r = new StreamedTurnRenderer();
    r.pushDelta('Old turn.\n\n');
    r.completeMessage('Old turn.');
    r.reset();
    expect(r.shouldSkipFinal('Old turn.')).toBe(false);
    expect(r.pushDelta('New turn.\n\n')).toEqual([{ text: 'New turn.', continuation: false }]);
  });
});
