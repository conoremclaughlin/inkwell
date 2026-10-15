import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from './claude-stream.js';
import type { BackendTurnEvent } from './stream.js';

const line = (value: unknown) => JSON.stringify(value) + '\n';
const partial = (event: object, parent: string | null | undefined = null) =>
  line({ type: 'stream_event', parent_tool_use_id: parent, event });
const snapshot = (messageId: string, uuid: string, text: string, extra: object = {}) =>
  line({
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: messageId, content: [{ type: 'text', text }] },
    ...extra,
  });
const final = (text = '') => line({ type: 'result', subtype: 'success', result: text });
const textEvents = (events: BackendTurnEvent[]) =>
  events.filter((e) => e.kind === 'text' || e.kind === 'text-delta');

describe('Claude output provenance (synthetic SDK frames, no provider)', () => {
  it('preserves conflicting snapshots under one identity so an effect consumer can refuse them', () => {
    const p = new ClaudeStreamParser();
    const events = p.push(
      snapshot('synthetic-message', 'synthetic-block', 'original') +
        snapshot('synthetic-message', 'synthetic-block', 'rewritten') +
        final()
    );
    const texts = textEvents(events);
    expect(texts.map((event) => event.text)).toEqual(['original', 'rewritten']);
    expect(texts[0].source).toEqual(texts[1].source);
    expect(events.at(-1)).toMatchObject({ text: 'original' });
  });

  it.each([
    { label: 'missing', id: undefined },
    { label: 'empty', id: '' },
    { label: 'number', id: 0 },
    { label: 'object', id: {} },
    { label: 'array', id: [] },
  ])('does not fabricate identity from an invalid $label ID', ({ id }) => {
    const p = new ClaudeStreamParser();
    expect(p.push(partial({ type: 'message_start', message: { id } }))).toEqual([]);
    expect(
      p.push(
        line({
          type: 'assistant',
          uuid: 'synthetic-block',
          parent_tool_use_id: null,
          message: { id, content: [{ type: 'text', text: 'displayed' }] },
        })
      )
    ).toEqual([{ kind: 'text', text: 'displayed' }]);
    expect(p.push(final())[0]).not.toHaveProperty('source');
  });

  it('keeps equal text in separate indexed blocks and ignores late output after the terminal result', () => {
    const p = new ClaudeStreamParser();
    const start = partial({ type: 'message_start', message: { id: 'synthetic-message' } });
    const block = (index: number) =>
      partial({ type: 'content_block_start', index, content_block: { type: 'text' } }) +
      snapshot('synthetic-message', `synthetic-snapshot-${index}`, 'same') +
      partial({ type: 'content_block_stop', index });
    const first = snapshot('synthetic-message', 'synthetic-snapshot-0', 'same');
    const events = p.push(start + block(0) + block(1) + first + final());
    expect(textEvents(events).map((event) => event.source?.blockId)).toEqual([
      'index:0',
      'index:1',
      'index:0',
    ]);
    expect(events.at(-1)).toMatchObject({ text: 'samesame' });
    expect(p.push(snapshot('synthetic-late', 'synthetic-late-block', 'late'))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it('correlates deltas and the snapshot before block-stop, keeping block and message ends distinct', () => {
    const p = new ClaudeStreamParser();
    const events = p.push(
      partial({ type: 'message_start', message: { id: 'synthetic-message' } }) +
        partial({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }) +
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi 🌱' },
        }) +
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '.' },
        }) +
        snapshot('synthetic-message', 'synthetic-snapshot-1', 'Hi 🌱.') +
        partial({ type: 'content_block_stop', index: 0 }) +
        partial({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
        partial({ type: 'message_stop' }) +
        final()
    );
    const source = { messageId: 'synthetic-message', origin: 'parent', blockId: 'index:0' };
    expect(textEvents(events)).toEqual([
      { kind: 'text-delta', text: 'Hi 🌱', source: { ...source, offset: 0 } },
      { kind: 'text-delta', text: '.', source: { ...source, offset: 5 } },
      { kind: 'text', text: 'Hi 🌱.', source: { ...source, offset: 0 } },
    ]);
    expect(events.filter((e) => e.kind === 'text-boundary').map((e) => e.boundary)).toEqual([
      'message-start',
      'block-start',
      'block-end',
      'message-end',
    ]);
    expect(events.at(-2)).toMatchObject({ boundary: 'message-end', complete: true });
    expect(events.at(-1)).toMatchObject({
      kind: 'result',
      text: 'Hi 🌱.',
      source: { messageId: 'synthetic-message', origin: 'parent' },
    });
  });

  it('carries initial block text and measures following offsets from it', () => {
    const p = new ClaudeStreamParser();
    const events = p.push(
      partial({ type: 'message_start', message: { id: 'synthetic-message' } }) +
        partial({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'text', text: 'Hi' },
        }) +
        partial({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '!' } })
    );
    expect(events[1]).toMatchObject({
      boundary: 'block-start',
      text: 'Hi',
      source: { blockId: 'index:2' },
    });
    expect(events[2]).toMatchObject({ kind: 'text-delta', source: { offset: 2 } });
  });

  it('uses identity, not equal text, for repeated snapshots and distinct blocks', () => {
    const p = new ClaudeStreamParser();
    const events = p.push(
      snapshot('synthetic-message', 'synthetic-block-1', 'same') +
        snapshot('synthetic-message', 'synthetic-block-1', 'same') +
        snapshot('synthetic-message', 'synthetic-block-2', 'same') +
        final()
    );
    const texts = textEvents(events);
    expect(texts[0].source).toEqual(texts[1].source);
    expect(texts[0].source?.blockId).not.toBe(texts[2].source?.blockId);
    expect(events.at(-1)).toMatchObject({
      text: 'samesame',
      source: { messageId: 'synthetic-message' },
    });
  });

  it('does not make a replayed older snapshot the final message or latest usage sample', () => {
    const p = new ClaudeStreamParser();
    const old = snapshot('synthetic-old', 'synthetic-old-block', 'same', {
      message: {
        id: 'synthetic-old',
        content: [{ type: 'text', text: 'same' }],
        usage: { input_tokens: 100 },
      },
    });
    p.push(old);
    p.push(
      snapshot('synthetic-new', 'synthetic-new-block', 'same', {
        message: {
          id: 'synthetic-new',
          content: [{ type: 'text', text: 'same' }],
          usage: { input_tokens: 200 },
        },
      })
    );
    const events = p.push(old + line({ type: 'result', usage: {}, subtype: 'success' }));
    expect(events.at(-1)).toMatchObject({
      text: 'same',
      source: { messageId: 'synthetic-new' },
      usage: { contextTokens: 200 },
    });
  });

  it('keeps child origin separate even when the message ID equals the parent ID', () => {
    const p = new ClaudeStreamParser();
    p.push(
      snapshot('synthetic-message', 'synthetic-parent-block', 'parent', {
        message: {
          id: 'synthetic-message',
          content: [{ type: 'text', text: 'parent' }],
          usage: { input_tokens: 100 },
        },
      })
    );
    const child = p.push(
      snapshot('synthetic-message', 'synthetic-child-block', 'child', {
        parent_tool_use_id: 'synthetic-parent-tool',
        message: {
          id: 'synthetic-message',
          content: [{ type: 'text', text: 'child' }],
          usage: { input_tokens: 999 },
        },
      })
    );
    expect(child[0]).toMatchObject({
      source: { origin: 'child', parentToolUseId: 'synthetic-parent-tool' },
    });
    expect(child[0]).not.toHaveProperty('continuesMessage');
    expect(p.push(line({ type: 'result', usage: {}, subtype: 'success' })).at(-1)).toMatchObject({
      text: 'child',
      source: { origin: 'child' },
      usage: { contextTokens: 100 },
    });
  });

  it.each(['synthetic-message', 'synthetic-child-message'])(
    'resumes parent assembly after an interleaved child message (%s)',
    (childId) => {
      const p = new ClaudeStreamParser();
      p.push(snapshot('synthetic-message', 'synthetic-first-block', 'Parent first.'));
      p.push(
        snapshot(childId, 'synthetic-child-block', 'Child text.', {
          parent_tool_use_id: 'synthetic-parent-tool',
        })
      );
      p.push(snapshot('synthetic-message', 'synthetic-second-block', ' Parent second.'));
      expect(p.push(final()).at(-1)).toMatchObject({
        text: 'Parent first. Parent second.',
        source: { messageId: 'synthetic-message', origin: 'parent' },
      });
    }
  );

  it('does not turn absent origin or missing message identity into parent provenance', () => {
    const p = new ClaudeStreamParser();
    expect(
      p.push(
        snapshot('synthetic-message', 'synthetic-block', 'text', { parent_tool_use_id: undefined })
      )[0]
    ).toMatchObject({
      source: { origin: 'unknown' },
    });
    p.push(partial({ type: 'message_start', message: { id: 'synthetic-valid' } }));
    p.push(partial({ type: 'message_start' }));
    const events = p.push(
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'unidentified' },
      })
    );
    expect(events).toEqual([{ kind: 'text-delta', text: 'unidentified' }]);
  });

  it.each([undefined, 'max_tokens', 'end_turn'])(
    'does not treat message-stop with %s and an open block as complete',
    (stop_reason) => {
      const p = new ClaudeStreamParser();
      const events = p.push(
        partial({ type: 'message_start', message: { id: 'synthetic-message' } }) +
          partial({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) +
          partial({ type: 'message_delta', delta: { stop_reason } }) +
          partial({ type: 'message_stop' })
      );
      expect(events.at(-1)).toMatchObject({ boundary: 'message-end', complete: false });
    }
  );

  it('requires a successful matching result before lending it message provenance', () => {
    for (const result of [
      { type: 'result', result: 'original' },
      { type: 'result', subtype: 'success', result: 'different' },
      { type: 'result', subtype: 'error_during_execution', result: 'original' },
    ]) {
      const p = new ClaudeStreamParser();
      p.push(snapshot('synthetic-message', 'synthetic-block', 'original'));
      expect(p.push(line(result))[0]).not.toHaveProperty('source');
    }
  });

  it('scopes reused message IDs to a fresh parser attempt', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = new ClaudeStreamParser();
      expect(
        p.push(snapshot('synthetic-message', 'synthetic-block', 'text') + final()).at(-1)
      ).toMatchObject({ text: 'text' });
    }
  });
});
