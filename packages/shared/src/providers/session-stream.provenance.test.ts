import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from './claude-stream.js';
import { SessionStream } from './session-stream.js';
import type { BackendTextSource, BackendTurnEvent } from './stream.js';
import type { StreamedLine } from '../runtime/paragraph-stream.js';

const source = (
  messageId = 'synthetic-message',
  blockId = 'synthetic-block'
): BackendTextSource => ({
  messageId,
  blockId,
  origin: 'parent',
  offset: 0,
});
const line = (event: unknown) => JSON.stringify(event) + '\n';
const snapshot = (text: string) =>
  line({
    type: 'assistant',
    uuid: 'synthetic-block',
    parent_tool_use_id: null,
    message: { id: 'synthetic-message', content: [{ type: 'text', text }] },
  });
const partial = (event: object) => line({ type: 'stream_event', parent_tool_use_id: null, event });
const final = line({ type: 'result', subtype: 'success', result: '' });

function fixture() {
  const lines: StreamedLine[] = [];
  const records: Record<string, unknown>[] = [];
  const stream = new SessionStream({
    toolRouting: () => 'local',
    append: (record) => records.push(record),
    render: (output) => lines.push(...output),
    progress: () => {},
    toolStarted: () => {},
    modelReported: () => {},
  });
  stream.beginSpawn();
  return {
    stream,
    records,
    lines,
    preview: () => records.filter((record) => record.type === 'backend_text').map((r) => r.preview),
    handle: (...events: BackendTurnEvent[]) => events.forEach((event) => stream.handle(event)),
  };
}

describe('source-aware display composition (pure parser and renderer)', () => {
  it.each(['before-stop', 'after-stop', 'after-message-end'])(
    'renders a streamed block once when its snapshot arrives %s',
    (order) => {
      const f = fixture();
      const text = 'First paragraph.\n\nSecond paragraph.\n';
      const stop = partial({ type: 'content_block_stop', index: 0 });
      const end =
        partial({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
        partial({ type: 'message_stop' });
      const snap = snapshot(text);
      f.handle(
        ...new ClaudeStreamParser().push(
          partial({ type: 'message_start', message: { id: 'synthetic-message' } }) +
            partial({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            }) +
            partial({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            }) +
            (order === 'before-stop'
              ? snap + stop + end
              : order === 'after-stop'
                ? stop + snap + end
                : stop + end + snap) +
            final
        )
      );
      f.stream.endSpawn();
      expect(f.lines.map((item) => item.text)).toEqual(['First paragraph.', 'Second paragraph.']);
      expect(f.stream.dialogue).toEqual([{ role: 'assistant', text }]);
      expect(f.stream.renderer.shouldSkipFinal(text)).toBe(true);
    }
  );

  it('renders repeated Claude snapshots once across paragraphs, dialogue, previews and final dedupe', () => {
    const f = fixture();
    const events = new ClaudeStreamParser().push(snapshot('Hello.\n\n').repeat(2) + final);
    f.handle(...events);
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Hello.']);
    expect(f.preview()).toEqual(['Hello.']);
    expect(f.stream.dialogue).toEqual([{ role: 'assistant', text: 'Hello.\n\n' }]);
    expect(f.stream.renderer.shouldSkipFinal('Hello.\n\n')).toBe(true);
    // Display dedupe must not alter or remove events from effect validation.
    expect(events.filter((event) => event.kind === 'text')).toHaveLength(2);
  });

  it('renders block-start initial text exactly once before its delta and snapshot', () => {
    const f = fixture();
    const events = new ClaudeStreamParser().push(
      partial({ type: 'message_start', message: { id: 'synthetic-message' } }) +
        partial({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'Hi' },
        }) +
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '!' },
        }) +
        snapshot('Hi!') +
        final
    );
    f.handle(...events);
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Hi!']);
    expect(f.preview()).toEqual(['Hi!']);
    expect(f.stream.dialogue).toEqual([{ role: 'assistant', text: 'Hi!' }]);
    expect(f.stream.renderer.shouldSkipFinal('Hi!')).toBe(true);
  });

  it('fills a snapshot suffix missing from deltas without appending a repeated positioned delta', () => {
    const f = fixture();
    f.handle(
      { kind: 'text-delta', text: 'Hi', source: source() },
      { kind: 'text-delta', text: 'i', source: { ...source(), offset: 1 } },
      { kind: 'text', text: 'Hi!', source: source() }
    );
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Hi!']);
    expect(f.preview()).toEqual(['Hi!']);
    expect(f.stream.renderer.shouldSkipFinal('Hi!')).toBe(true);
  });

  it.each(['block', 'message'] as const)(
    'keeps equal text under different %s identities',
    (kind) => {
      const f = fixture();
      f.handle(
        { kind: 'text', text: 'Same.\n\n', source: source() },
        {
          kind: 'text',
          text: 'Same.\n\n',
          source:
            kind === 'block'
              ? source('synthetic-message', 'synthetic-next')
              : source('synthetic-next'),
        }
      );
      f.stream.endSpawn();
      expect(f.lines.map((item) => item.text)).toEqual(['Same.', 'Same.']);
      expect(f.preview()).toEqual(['Same.', 'Same.']);
      expect(f.stream.dialogue[0].text).toBe('Same.\n\nSame.\n\n');
      expect(f.stream.renderer.shouldSkipFinal('Same.\n\n'.repeat(kind === 'block' ? 2 : 1))).toBe(
        true
      );
    }
  );

  it('does not let an older replay replace the final display confirmation', () => {
    const f = fixture();
    const old: BackendTurnEvent = {
      kind: 'text',
      text: 'Old.\n\n',
      source: source('synthetic-old'),
    };
    f.handle(old, { kind: 'text', text: 'New.\n\n', source: source('synthetic-new') }, old);
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Old.', 'New.']);
    expect(f.preview()).toEqual(['Old.', 'New.']);
    expect(f.stream.renderer.shouldSkipFinal('New.')).toBe(true);
  });

  it('keeps child and parent correlation separate without granting either execution authority', () => {
    const f = fixture();
    const parent = source();
    const child: BackendTextSource = {
      ...parent,
      origin: 'child',
      parentToolUseId: 'synthetic-tool',
    };
    f.handle(
      { kind: 'text', text: 'Parent.\n\n', source: parent },
      { kind: 'text', text: 'Child.\n\n', source: child },
      { kind: 'result', text: 'Parent.\n\n', source: parent }
    );
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Parent.', 'Child.']);
    expect(f.preview()).toEqual(['Parent.', 'Child.']);
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(true);
  });

  it('does not suppress a positioned final split by an unpositioned delta', () => {
    const f = fixture();
    f.handle(
      { kind: 'text-delta', text: 'Par', source: source() },
      { kind: 'text-delta', text: 'Unidentified.\n\n' },
      { kind: 'text-delta', text: 'ent.\n\n', source: { ...source(), offset: 3 } },
      { kind: 'text', text: 'Parent.\n\n', source: source() },
      { kind: 'result', text: 'Parent.\n\n', source: source() }
    );
    f.stream.endSpawn();
    expect(f.lines.map((line) => line.text)).toEqual(['ParUnidentified.', 'ent.']);
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(false);
  });

  it('keeps invalidation through a snapshot with no fresh suffix and final confirmation', () => {
    const f = fixture();
    f.handle(
      { kind: 'text-delta', text: 'Parent.', source: source() },
      { kind: 'text-delta', text: 'Unidentified.\n\n' },
      { kind: 'text', text: 'Parent.', source: source() },
      { kind: 'result', text: 'Parent.', source: source() }
    );
    f.stream.endSpawn();
    expect(f.lines.map((line) => line.text)).toEqual(['Parent.Unidentified.']);
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(false);
  });

  it('also accounts for a source-less completed block between positioned blocks', () => {
    const f = fixture();
    f.handle(
      { kind: 'text', text: 'Par', source: source() },
      { kind: 'text', text: 'Unidentified.\n\n' },
      { kind: 'text', text: 'ent.\n\n', source: source('synthetic-message', 'synthetic-second') },
      { kind: 'result', text: 'Parent.\n\n', source: source() }
    );
    f.stream.endSpawn();
    expect(f.lines.map((line) => line.text)).toEqual(['ParUnidentified.', 'ent.']);
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(false);
  });

  it('does not invalidate positioned output for an empty source-less delta', () => {
    const f = fixture();
    f.handle(
      { kind: 'text-delta', text: 'Par', source: source() },
      { kind: 'text-delta', text: '' },
      { kind: 'text-delta', text: 'ent.\n\n', source: { ...source(), offset: 3 } },
      { kind: 'text', text: 'Parent.\n\n', source: source() },
      { kind: 'result', text: 'Parent.\n\n', source: source() }
    );
    f.stream.endSpawn();
    expect(f.lines.map((line) => line.text)).toEqual(['Parent.']);
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(true);
  });

  it('resets mixed-provenance invalidation for a fresh attempt', () => {
    const f = fixture();
    f.handle(
      { kind: 'text-delta', text: 'Par', source: source() },
      { kind: 'text-delta', text: 'Unidentified.\n\n' }
    );
    f.stream.endSpawn();
    f.stream.beginSpawn();
    f.handle({ kind: 'text', text: 'Parent.\n\n', source: source() });
    f.stream.endSpawn();
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(true);
  });

  it('starts correlation anew on every attempt even if the provider reuses its IDs', () => {
    const f = fixture();
    for (const text of ['First.', 'Second.']) {
      f.stream.beginSpawn();
      f.handle({ kind: 'text', text, source: source() });
      f.stream.endSpawn();
    }
    expect(f.lines.map((item) => item.text)).toEqual(['First.', 'Second.']);
    expect(f.preview()).toEqual(['First.', 'Second.']);
    expect(f.stream.dialogue.map((entry) => entry.text)).toEqual(['First.', 'Second.']);
    expect(f.stream.renderer.shouldSkipFinal('Second.')).toBe(true);
  });

  it('does not claim an intact final was displayed when child text split its partial chunks', () => {
    const f = fixture();
    const parent = source();
    f.handle(
      { kind: 'text-delta', text: 'Par', source: parent },
      {
        kind: 'text',
        text: 'Child.\n\n',
        source: { ...parent, origin: 'child', parentToolUseId: 'synthetic-tool' },
      },
      { kind: 'text-delta', text: 'ent.\n\n', source: { ...parent, offset: 3 } },
      { kind: 'text', text: 'Parent.\n\n', source: parent },
      { kind: 'result', text: 'Parent.\n\n', source: parent }
    );
    f.stream.endSpawn();
    expect(f.stream.renderer.shouldSkipFinal('Parent.')).toBe(false);
    expect(f.preview()).toEqual(['Child.', 'Parent.']);
  });

  it('does not publish a conflicting snapshot as fresh dialogue or mutate the original evidence', () => {
    const f = fixture();
    const conflict: BackendTurnEvent = { kind: 'text', text: 'Rewritten.\n\n', source: source() };
    f.handle({ kind: 'text', text: 'Original.\n\n', source: source() }, conflict);
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text)).toEqual(['Original.']);
    expect(f.preview()).toEqual(['Original.']);
    expect(f.stream.dialogue[0].text).toBe('Original.\n\n');
    expect(conflict.text).toBe('Rewritten.\n\n');
    expect(f.stream.renderer.shouldSkipFinal('Rewritten.')).toBe(false);
  });

  it('retains the whole-attempt imitation guard across different identified blocks', () => {
    const f = fixture();
    f.handle(
      { kind: 'text', text: 'Looking.\n[Tool results ', source: source() },
      {
        kind: 'text',
        text: 'from previous turn]\nfabricated\n\n',
        source: source('synthetic-message', 'synthetic-next'),
      }
    );
    f.stream.endSpawn();
    expect(f.lines.map((item) => item.text).join('')).toBe('Looking.');
    expect(f.preview().join('')).not.toContain('fabricated');
    expect(f.stream.dialogue[0].text).toBe('Looking.\n');
  });
});
