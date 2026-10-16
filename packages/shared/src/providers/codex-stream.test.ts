import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from './codex-stream.js';
import type { BackendTurnEvent } from './stream.js';
const parser = () => new CodexStreamParser();
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const message = (text: string, id = 'synthetic-item') => ({
  type: 'item.completed',
  item: { type: 'agent_message', id, text },
});
const complete = {
  type: 'turn.completed',
  usage: {
    input_tokens: 1200,
    cached_input_tokens: 1000,
    output_tokens: 300,
    reasoning_output_tokens: 200,
  },
};

describe('Codex exec streaming adapter', () => {
  it('reassembles split frames and keeps the last assistant message as the final answer', () => {
    const p = parser();
    const input =
      line(message('Working on it.', 'synthetic-first')) + line(message('Done.')) + line(complete);
    const events: BackendTurnEvent[] = [];
    for (const char of input) events.push(...p.push(char));
    expect(events.filter((e) => e.kind === 'text')).toMatchObject([
      { kind: 'text', text: 'Working on it.' },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: 'result',
      text: 'Done.',
      usage: { inputTokens: 1200, cacheReadTokens: 1000, totalTokens: 1500, reasoningTokens: 200 },
    });
    const result = events.at(-1);
    if (result?.kind === 'result') expect(result.usage?.contextTokens).toBeUndefined();
    expect(p.end()).toEqual([]);
  });

  it('flushes a newline-less final frame and does not replay it on repeated end', () => {
    const p = parser();
    p.push(line(message('Final answer.')));
    expect(p.push(JSON.stringify(complete))).toEqual([]);
    expect(p.end()).toMatchObject([{ kind: 'result', text: 'Final answer.' }]);
    expect(p.end()).toEqual([]);
  });

  it('does not publish reasoning, native tool output, or JSON chrome as assistant text', () => {
    const p = parser();
    const events = p.push(
      'startup chrome\nnull\n[]\n' +
        line({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } }) +
        line({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            id: 'synthetic-cmd',
            command: 'echo hello',
            aggregated_output: 'tool output',
            exit_code: 0,
          },
        }) +
        line(complete)
    );
    expect(events.some((e) => e.kind === 'text')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'result', text: '' });
  });

  it('reports native tool activity without treating the event stream as enforcement', () => {
    const p = parser();
    const item = {
      type: 'mcp_tool_call',
      id: 'synthetic-tool',
      server: 'synthetic',
      tool: 'lookup',
      arguments: { query: 'fixture' },
      status: 'in_progress',
    };
    expect(p.push(line({ type: 'item.started', item }))).toEqual([
      {
        kind: 'tool-use',
        id: 'synthetic-tool',
        name: 'mcp__synthetic__lookup',
        input: { query: 'fixture' },
      },
    ]);
    expect(p.push(line({ type: 'item.completed', item: { ...item, status: 'failed' } }))).toEqual([
      { kind: 'tool-result', id: 'synthetic-tool', isError: true },
    ]);
  });

  it('refuses a truncated stream, even after plausible assistant text', () => {
    const p = parser();
    p.push(line(message('Possibly done.')) + '{"type":');
    expect(p.end()).toMatchObject([
      { kind: 'result', text: '', error: expect.stringContaining('before turn completion') },
    ]);
  });

  it('keeps a terminal failure distinct from reconnecting error notifications', () => {
    const p = parser();
    expect(p.push(line({ type: 'error', message: 'reconnecting' }))).toEqual([]);
    expect(p.push(line({ type: 'turn.failed', error: { message: 'synthetic refusal' } }))).toEqual([
      { kind: 'result', text: '', error: 'synthetic refusal' },
    ]);
    expect(p.push(line(message('late')) + line(complete))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it('allows an empty final message to replace earlier progress', () => {
    const p = parser();
    p.push(line(message('Progress.', 'synthetic-progress')));
    expect(p.push(line(message('')) + line(complete)).at(-1)).toMatchObject({
      kind: 'result',
      text: '',
    });
  });

  it('never fabricates a usage sample when the provider reported none', () => {
    const p = parser();
    const events = p.push(line(message('Answer.')) + line({ type: 'turn.completed' }));
    expect(events.at(-1)).toMatchObject({ kind: 'result', text: 'Answer.' });
    expect(events.at(-1)).not.toHaveProperty('usage');
  });
});

describe('Codex frame limits', () => {
  const limit = 4 * 1024 * 1024;

  it('refuses an oversized unfinished frame and ignores everything after that refusal', () => {
    const p = parser();
    expect(p.push('x'.repeat(limit))).toEqual([]);
    expect(p.push('x')).toMatchObject([
      { kind: 'result', text: '', error: expect.stringContaining('event exceeded') },
    ]);
    expect(p.push('\n' + line(message('late')) + line(complete))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it('applies the same byte limit to complete frames and multibyte fragments', () => {
    for (const content of ['x'.repeat(limit + 1) + '\n', 'é'.repeat(limit / 2 + 1)]) {
      const p = parser();
      expect(p.push(content)).toMatchObject([
        { kind: 'result', text: '', error: expect.stringContaining('event exceeded') },
      ]);
    }
  });

  it('accepts a bounded frame followed by a separate terminal frame', () => {
    const p = parser();
    const text = 'x'.repeat(limit - 200);
    const events = p.push(line(message(text)) + line(complete));
    expect(events.find((event) => event.kind === 'text')).toMatchObject({ kind: 'text', text });
    expect(events.at(-1)).toMatchObject({ kind: 'result', text });
  });
});

describe('Codex output correlation', () => {
  it('retains conflicting snapshot text under its original identity for the consumer to refuse', () => {
    const events = parser().push(
      line(message('original')) + line(message('rewritten')) + line(complete)
    );
    const texts = events.filter((event) => event.kind === 'text');
    expect(texts.map((event) => event.text)).toEqual(['original', 'rewritten']);
    expect(texts[0].source).toEqual(texts[1].source);
    expect(events.at(-1)).toMatchObject({ text: 'original' });
  });

  it('scopes reused item IDs to one attempt and ignores late events after success', () => {
    for (const text of ['first attempt', 'second attempt']) {
      const p = parser();
      expect(p.push(line(message(text)) + line(complete)).at(-1)).toMatchObject({
        text,
        source: { messageId: 'synthetic-item' },
      });
      expect(p.push(line(message('late')))).toEqual([]);
      expect(p.end()).toEqual([]);
    }
  });

  it('keeps distinct equal-text items separate and names only the final item', () => {
    const events = parser().push(
      line(message('same', 'synthetic-one')) +
        line(message('same', 'synthetic-two')) +
        line(complete)
    );
    expect(events.filter((event) => event.kind === 'text').map((event) => event.source)).toEqual([
      { messageId: 'synthetic-one', origin: 'unknown', blockId: 'synthetic-one', offset: 0 },
      { messageId: 'synthetic-two', origin: 'unknown', blockId: 'synthetic-two', offset: 0 },
    ]);
    expect(events.at(-1)).toMatchObject({
      source: { messageId: 'synthetic-two', origin: 'unknown' },
    });
    expect(
      events.filter((event) => event.kind === 'text-boundary').map((event) => event.boundary)
    ).toEqual(['message-start', 'message-end', 'message-start', 'message-end']);
  });

  it('does not promote an older repeated snapshot to the final item', () => {
    const events = parser().push(
      line(message('one', 'synthetic-one')) +
        line(message('two', 'synthetic-two')) +
        line(message('one', 'synthetic-one')) +
        line(complete)
    );
    expect(events.at(-1)).toMatchObject({ text: 'two', source: { messageId: 'synthetic-two' } });
  });

  it('does not invent identity for a completed item without an ID', () => {
    const events = parser().push(
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'text' } }) +
        line(complete)
    );
    expect(events.find((event) => event.kind === 'text')).not.toHaveProperty('source');
    expect(events.at(-1)).not.toHaveProperty('source');
  });
});
