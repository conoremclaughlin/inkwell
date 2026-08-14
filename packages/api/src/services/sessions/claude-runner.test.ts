import { describe, it, expect } from 'vitest';
import { parseClaudeUsage } from './claude-runner.js';
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
    expect(usage.contextTokens).toBe(35_000);
    expect(usage.outputTokens).toBe(850);
    expect(usage.cacheReadTokens).toBe(18_000);
    expect(usage.cacheWriteTokens).toBe(4_500);
  });

  it('matches the fixture comment arithmetic on a large turn', () => {
    const usage = parseClaudeUsage(resultWithHighUsage.usage as Record<string, unknown>);

    // The fixture documents context = 125000 + 45000 + 5000 = 175000.
    expect(usage.contextTokens).toBe(175_000);
    expect(usage.outputTokens).toBe(3_500);
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
