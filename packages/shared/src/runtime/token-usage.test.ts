import { describe, expect, it } from 'vitest';
import {
  extractBackendTokenUsage,
  formatBackendTokenUsage,
  providerContextTokens,
} from './token-usage.js';

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

describe('providerContextTokens — the context a request was handed, per backend (Lumen, PR #583)', () => {
  it('Anthropic reports cache reads and writes DISJOINT from input, so they sum', () => {
    expect(
      providerContextTokens('claude', {
        inputTokens: 1_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 40_000,
      })
    ).toBe(541_000);
  });

  it('OpenAI input_tokens already includes cached_tokens — never double-counted', () => {
    const usage = extractBackendTokenUsage(
      'codex',
      JSON.stringify({
        usage: {
          input_tokens: 120_000,
          output_tokens: 300,
          prompt_tokens_details: { cached_tokens: 100_000 },
        },
      }),
      ''
    );
    expect(usage?.cacheReadTokens).toBe(100_000);
    expect(usage?.contextTokens).toBe(120_000);
    expect(usage?.contextParts).toEqual({ inputTokens: 120_000, cacheReadTokens: 100_000 });
  });

  it('Gemini promptTokenCount already includes the cache', () => {
    const usage = extractBackendTokenUsage(
      'gemini',
      JSON.stringify({ usage: { promptTokenCount: 90_000, candidatesTokenCount: 50 } }),
      ''
    );
    expect(usage?.contextTokens).toBe(90_000);
  });

  it('a Claude report parsed from stdout sums the same way the stream parser does', () => {
    const usage = extractBackendTokenUsage(
      'claude',
      JSON.stringify({
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          cache_read_tokens: 500_000,
          cache_write_tokens: 40_000,
        },
      }),
      ''
    );
    expect(usage?.contextTokens).toBe(541_000);
  });

  it('is absent when nothing about the input was reported', () => {
    expect(providerContextTokens('claude', {})).toBeUndefined();
    expect(providerContextTokens('codex', { cacheReadTokens: 5 })).toBeUndefined();
  });
});

describe('text usage fallback — linear scans of provider output', () => {
  it.each([
    [
      '1,200 input tokens; 450 output tokens; 1.65k total tokens',
      { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 },
    ],
    [
      '1.2 K prompt tokens; .45 k completion tokens; 1.65 K total tokens',
      { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 },
    ],
    [
      'input = 12; output: 3; all tokens = 15',
      { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    ],
    [
      'cached tokens: 2; cache hit token = 3; cache write tokens: 4; reasoning tokens: 5',
      { cacheReadTokens: 2, cacheWriteTokens: 4, reasoningTokens: 5 },
    ],
    [
      'input tokens have no number; 12 prompt tokens; 3 candidate tokens',
      { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    ],
    ['1 input tokens; input tokens: 7', { inputTokens: 7 }],
  ])('preserves usage formats and leading-label precedence: %s', (text, expected) => {
    expect(extractBackendTokenUsage('codex', text, '')).toMatchObject({
      source: 'text',
      ...expected,
    });
  });

  it.each(['input', 'cache'])('does not backtrack over a missing suffix after %s', (label) => {
    const payload = label + ' '.repeat(16_000) + '!\noutput tokens: 7';
    const started = performance.now();
    expect(extractBackendTokenUsage('codex', payload, '')?.outputTokens).toBe(7);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each([',', '1,'])('does not retry a numeric pattern at each character in %j runs', (unit) => {
    const payload = unit.repeat(8_000) + '!\ninput tokens: 12; output tokens: 3';
    const started = performance.now();
    expect(extractBackendTokenUsage('codex', payload, '')).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
    // Exercise the reverse total form on an otherwise unlabelled number run.
    expect(extractBackendTokenUsage('codex', unit.repeat(8_000) + '!', '')).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('does not lose a valid usage line after a long non-usage prefix', () => {
    const prefix = ','.repeat(100_000) + '\n' + 'plain prose\n'.repeat(10_000);
    expect(
      extractBackendTokenUsage(
        'gemini',
        prefix + 'prompt tokens: 12, candidate tokens: 3, thoughts tokens: 2',
        ''
      )
    ).toMatchObject({ inputTokens: 12, outputTokens: 3, reasoningTokens: 2, totalTokens: 17 });
  });
});
