import { describe, it, expect } from 'vitest';
import {
  parseClaudeUsage,
  parseAssistantContextTokens,
  parseModelUsage,
  primaryModel,
  createLineReader,
} from './claude-runner.js';
import {
  resultWithUsage,
  resultWithHighUsage,
} from '../../test/fixtures/claude-stream-messages.js';

/**
 * Regression cover for the field names in Claude's stream-json `result.usage`.
 *
 * The runner used to read `cache_read_tokens` / `cache_write_tokens`, which do
 * not exist. Every cached token was therefore invisible, and since
 * `input_tokens` carries only the non-cached remainder, recorded input for a
 * heavily-cached agent collapsed to near zero — the reason per-agent cost
 * attribution could not be trusted.
 */
describe('parseClaudeUsage', () => {
  it('counts cached input as input, using the real field names', () => {
    const usage = parseClaudeUsage(resultWithUsage.usage as Record<string, unknown>);

    // 12500 fresh + 18000 cache read + 4500 cache write
    expect(usage.inputTokens).toBe(35_000);
    expect(usage.outputTokens).toBe(850);
    expect(usage.cacheReadTokens).toBe(18_000);
    expect(usage.cacheWriteTokens).toBe(4_500);
  });

  it('reports billing totals only — context is measured elsewhere', () => {
    const usage = parseClaudeUsage(resultWithHighUsage.usage as Record<string, unknown>);

    expect(usage.inputTokens).toBe(175_000);
    expect(usage.outputTokens).toBe(3_500);
    // result.usage aggregates every model step in the query, so it cannot
    // stand in for live context occupancy. Absent means unknown, not zero.
    expect(usage.contextTokens).toBeUndefined();
  });

  // The misspelled names must not quietly resurrect: a payload carrying only
  // them contributes nothing, which is exactly what the bug looked like.
  it('ignores the field names that never existed', () => {
    const usage = parseClaudeUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 500_000,
      cache_write_tokens: 250_000,
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('treats absent and malformed usage fields as zero', () => {
    const usage = parseClaudeUsage({ output_tokens: 'lots' });

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
  });
});

/**
 * Context occupancy comes from per-step assistant messages, never from the
 * query aggregate. A 20-step query re-reads its cached prompt each step, so
 * result.usage bills a multiple of the live context — using it for context
 * tripped the 150k compaction threshold on runs nowhere near full.
 */
describe('parseAssistantContextTokens', () => {
  it('measures one API call’s prompt, cached parts included', () => {
    const tokens = parseAssistantContextTokens({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 9,
          cache_read_input_tokens: 18_101,
          cache_creation_input_tokens: 7_447,
          output_tokens: 4,
        },
      },
    });

    expect(tokens).toBe(25_557);
  });

  // Subagents run their own context; counting theirs as the parent's would
  // make compaction fire on the wrong conversation.
  it('skips subagent messages', () => {
    const tokens = parseAssistantContextTokens({
      type: 'assistant',
      parent_tool_use_id: 'toolu_123',
      message: { usage: { input_tokens: 500_000 } },
    });

    expect(tokens).toBeUndefined();
  });

  it('returns undefined when no usage is present', () => {
    expect(parseAssistantContextTokens({ type: 'assistant', message: {} })).toBeUndefined();
  });
});

/**
 * modelUsage is the authoritative record of which models actually served a
 * query — the requested model is only what we asked for.
 */
describe('parseModelUsage / primaryModel', () => {
  const raw = {
    'claude-haiku-4-5-20251001': {
      inputTokens: 524,
      outputTokens: 12,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000584,
      canonicalModel: 'claude-haiku-4-5',
    },
    'claude-opus-5': {
      inputTokens: 9,
      outputTokens: 48,
      cacheReadInputTokens: 22_168,
      cacheCreationInputTokens: 3_374,
      costUSD: 0.0092138,
      canonicalModel: 'claude-opus-5',
    },
  };

  it('maps Claude’s camelCase fields and keeps cost', () => {
    const parsed = parseModelUsage(raw)!;

    expect(parsed['claude-opus-5'].cacheReadTokens).toBe(22_168);
    expect(parsed['claude-opus-5'].cacheWriteTokens).toBe(3_374);
    expect(parsed['claude-opus-5'].costUSD).toBeCloseTo(0.0092138);
  });

  // A query can report both a dated id and an alias; whether those are one
  // model or two is not decidable here, so entries stay separate.
  it('preserves every reported key without merging them', () => {
    const parsed = parseModelUsage(raw)!;

    expect(Object.keys(parsed).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
  });

  it('picks the model that did the work, by output volume', () => {
    expect(primaryModel(parseModelUsage(raw))).toBe('claude-opus-5');
  });

  it('returns undefined for absent or malformed reports', () => {
    expect(parseModelUsage(undefined)).toBeUndefined();
    expect(parseModelUsage({})).toBeUndefined();
    expect(primaryModel(undefined)).toBeUndefined();
  });
});

/**
 * The bug this covers is silent: a result line split across stdout chunks
 * parsed as two invalid fragments, both swallowed by the surrounding catch,
 * taking the turn's entire usage and model attribution with it.
 */
describe('createLineReader', () => {
  it('reassembles a JSON line split across chunks', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    const payload = JSON.stringify({ type: 'result', usage: { output_tokens: 42 } });
    const split = Math.floor(payload.length / 2);
    reader.push(payload.slice(0, split));
    reader.push(payload.slice(split) + '\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).usage.output_tokens).toBe(42);
  });

  it('handles many lines arriving in one chunk, and one line across many', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"a":1}\n{"b":2}\n{"c":');
    reader.push('3');
    reader.push('}\n');

    expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  // Claude's final result line frequently arrives without a trailing newline.
  it('emits an unterminated final line on flush', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"type":"result","usage":{"output_tokens":7}}');
    expect(lines).toHaveLength(0);

    reader.flush();
    expect(JSON.parse(lines[0]).usage.output_tokens).toBe(7);
  });

  it('ignores blank lines and flushing an empty buffer', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('\n\n  \n');
    reader.flush();

    expect(lines).toEqual([]);
  });
});
