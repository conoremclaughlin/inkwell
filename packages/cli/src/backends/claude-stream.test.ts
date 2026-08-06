import { describe, expect, it } from 'vitest';

import { ClaudeStreamParser } from './claude-stream.js';
import type { BackendTurnEvent } from './stream.js';

/** Fixture event shapes mirror packages/api/src/test/fixtures/claude-stream-messages.ts */
const asstTextAndTool = {
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: "I'll check your recent emails now." },
      {
        type: 'tool_use',
        id: 'toolu_01ABC',
        name: 'mcp__inkwell__list_emails',
        input: { maxResults: 5 },
      },
    ],
  },
};
const userToolResult = {
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABC', content: '{"success":true}' }],
  },
};
const asstSendResponse = {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_03GHI',
        name: 'mcp__inkwell__send_response',
        input: { channel: 'telegram' },
      },
    ],
  },
};
const resultWithUsage = {
  type: 'result',
  result: '',
  usage: {
    input_tokens: 12500,
    output_tokens: 850,
    cache_read_input_tokens: 18000,
    cache_creation_input_tokens: 4500,
  },
};

const line = (o: unknown) => JSON.stringify(o) + '\n';
const kinds = (evs: BackendTurnEvent[]) => evs.map((e) => e.kind);

describe('ClaudeStreamParser', () => {
  it('parses assistant text + nested tool_use (NOT top-level)', () => {
    const p = new ClaudeStreamParser();
    const evs = p.push(line(asstTextAndTool));
    expect(kinds(evs)).toEqual(['text', 'tool-use']);
    expect(evs[0]).toEqual({ kind: 'text', text: "I'll check your recent emails now." });
    expect(evs[1]).toEqual({
      kind: 'tool-use',
      id: 'toolu_01ABC',
      name: 'mcp__inkwell__list_emails',
      input: { maxResults: 5 },
    });
  });

  it('parses tool_result nested under a user event', () => {
    const p = new ClaudeStreamParser();
    const evs = p.push(line(userToolResult));
    expect(evs).toEqual([{ kind: 'tool-result', id: 'toolu_01ABC', isError: false }]);
  });

  it('extracts usage with the REAL claude field names on the result event', () => {
    const p = new ClaudeStreamParser();
    p.push(line(asstTextAndTool)); // seed lastAssistantText
    const evs = p.push(line(resultWithUsage));
    expect(evs).toHaveLength(1);
    const r = evs[0]!;
    expect(r.kind).toBe('result');
    if (r.kind !== 'result') throw new Error('unreachable');
    expect(r.usage).toMatchObject({
      backend: 'claude',
      source: 'json',
      inputTokens: 12500,
      outputTokens: 850,
      cacheReadTokens: 18000,
      cacheWriteTokens: 4500,
      totalTokens: 13350,
    });
  });

  it('uses the last assistant text as result text when `result` is empty', () => {
    const p = new ClaudeStreamParser();
    p.push(
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'final answer here' }] },
      })
    );
    const [r] = p.push(line(resultWithUsage));
    expect(r?.kind === 'result' && r.text).toBe('final answer here');
  });

  it('prefers a non-empty `result` string over accumulated assistant text', () => {
    const p = new ClaudeStreamParser();
    p.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'interim' }] } }));
    const [r] = p.push(line({ type: 'result', result: 'the real result', usage: {} }));
    expect(r?.kind === 'result' && r.text).toBe('the real result');
  });

  it('reassembles a JSON line split across two chunks', () => {
    const p = new ClaudeStreamParser();
    const full = line(asstTextAndTool);
    const mid = Math.floor(full.length / 2);
    expect(p.push(full.slice(0, mid))).toEqual([]); // incomplete → nothing yet
    const evs = p.push(full.slice(mid));
    expect(kinds(evs)).toEqual(['text', 'tool-use']);
  });

  it('handles multiple events in one chunk and ignores malformed lines', () => {
    const p = new ClaudeStreamParser();
    const chunk = line(asstTextAndTool) + 'not json at all\n' + line(userToolResult);
    const evs = p.push(chunk);
    expect(kinds(evs)).toEqual(['text', 'tool-use', 'tool-result']);
  });

  it('detects resume-failed-no-session from the result event', () => {
    const p = new ClaudeStreamParser();
    const evs = p.push(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Error: No conversation found with session ID abc-123'],
      })
    );
    expect(evs[0]).toMatchObject({ kind: 'result', resumeFailedNoSession: true });
  });

  it('does NOT flag resume-failure for an ordinary error result', () => {
    const p = new ClaudeStreamParser();
    const [r] = p.push(line({ type: 'result', subtype: 'success', result: 'ok', usage: {} }));
    expect(r?.kind === 'result' && r.resumeFailedNoSession).toBeUndefined();
  });

  it('flushes a trailing newline-less line on end()', () => {
    const p = new ClaudeStreamParser();
    expect(p.push(JSON.stringify(asstSendResponse))).toEqual([]); // no newline yet
    const evs = p.end();
    expect(evs).toEqual([
      {
        kind: 'tool-use',
        id: 'toolu_03GHI',
        name: 'mcp__inkwell__send_response',
        input: { channel: 'telegram' },
      },
    ]);
  });

  it('parses a full realistic sequence end-to-end', () => {
    const p = new ClaudeStreamParser();
    const seq =
      line({ type: 'system', session_id: 'sess-1' }) +
      line(asstTextAndTool) +
      line(userToolResult) +
      line(asstSendResponse) +
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_03GHI' }] },
      }) +
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done — 3 emails.' }] },
      }) +
      line(resultWithUsage);
    const evs = p.push(seq);
    expect(kinds(evs)).toEqual([
      'text', // "I'll check…"
      'tool-use', // list_emails
      'tool-result', // list_emails result
      'tool-use', // send_response
      'tool-result', // send_response result
      'text', // "Done — 3 emails."
      'result',
    ]);
    const last = evs[evs.length - 1]!;
    expect(last.kind === 'result' && last.text).toBe('Done — 3 emails.');
    expect(last.kind === 'result' && last.usage?.inputTokens).toBe(12500);
  });
});
