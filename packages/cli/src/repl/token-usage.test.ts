import { describe, expect, it } from 'vitest';
import { extractBackendTokenUsage, formatBackendTokenUsage } from './token-usage.js';

describe('extractBackendTokenUsage', () => {
  it('parses JSON usage payloads', () => {
    const stdout = '{"usage":{"input_tokens":1200,"output_tokens":300,"total_tokens":1500}}';
    const usage = extractBackendTokenUsage('codex', stdout, '');

    expect(usage).toMatchObject({
      backend: 'codex',
      source: 'json',
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
    });
  });

  it('parses text usage payloads with suffixes', () => {
    const stderr =
      'Input tokens: 1.2k\nOutput tokens: 450\nTotal tokens: 1.65k\nCache read tokens: 300';
    const usage = extractBackendTokenUsage('claude', '', stderr);

    expect(usage).toMatchObject({
      backend: 'claude',
      source: 'text',
      inputTokens: 1200,
      outputTokens: 450,
      totalTokens: 1650,
      cacheReadTokens: 300,
    });
  });

  it('derives total tokens when missing', () => {
    const stderr = 'prompt tokens: 800\ncompletion tokens: 250';
    const usage = extractBackendTokenUsage('gemini', '', stderr);

    expect(usage).toMatchObject({
      inputTokens: 800,
      outputTokens: 250,
      totalTokens: 1050,
    });
  });

  it('returns undefined when no usage is present', () => {
    const usage = extractBackendTokenUsage('claude', 'normal output', 'nothing here');
    expect(usage).toBeUndefined();
  });
});

describe('formatBackendTokenUsage', () => {
  it('formats usage summary with key metrics', () => {
    const formatted = formatBackendTokenUsage({
      backend: 'codex',
      source: 'json',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
    });

    expect(formatted).toContain('codex usage (json)');
    expect(formatted).toContain('in 1,000');
    expect(formatted).toContain('out 200');
    expect(formatted).toContain('total 1,200');
  });
});

describe('Gemini usage fields (Lumen, PR #576 round 6)', () => {
  it('usageMetadata nesting is read, and a synthesized total keeps the thoughts (Lumen, round 7)', () => {
    const usage = extractBackendTokenUsage(
      'gemini',
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 90_000,
          candidatesTokenCount: 500,
          thoughtsTokenCount: 2_000,
        },
      }),
      ''
    );
    expect(usage?.inputTokens).toBe(90_000);
    expect(usage?.reasoningTokens).toBe(2_000);
    expect(usage?.totalTokens).toBe(92_500);
  });

  it("REGRESSION (Lumen, round 8): OpenAI's reasoning is inside output — a synthesized total never adds it again", () => {
    const usage = extractBackendTokenUsage(
      'codex',
      JSON.stringify({
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          output_tokens_details: { reasoning_tokens: 200 },
        },
      }),
      ''
    );
    expect(usage?.reasoningTokens).toBe(200);
    expect(usage?.totalTokens).toBe(1_500);
  });

  it('REGRESSION (Lumen, round 8): a Gemini text summary with a thoughts label adds them to the total', () => {
    const usage = extractBackendTokenUsage(
      'gemini',
      'prompt tokens: 90000, candidate tokens: 500, thoughts tokens: 2000',
      ''
    );
    expect(usage?.source).toBe('text');
    expect(usage?.reasoningTokens).toBe(2_000);
    expect(usage?.totalTokens).toBe(92_500);
  });

  it('thoughtsTokenCount and totalTokenCount are normalized', () => {
    const usage = extractBackendTokenUsage(
      'gemini',
      JSON.stringify({
        usage: {
          promptTokenCount: 90_000,
          candidatesTokenCount: 500,
          thoughtsTokenCount: 2_000,
          totalTokenCount: 92_500,
        },
      }),
      ''
    );
    expect(usage?.inputTokens).toBe(90_000);
    expect(usage?.reasoningTokens).toBe(2_000);
    expect(usage?.totalTokens).toBe(92_500);
  });
});
