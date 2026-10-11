import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { extractToolBlocks, stripLocalToolBlocks } from './agent-loop';

// Pure string parsing only. No tools, models, files, or executors are invoked.
describe('legacy tool_call scanning', () => {
  it('keeps case-insensitive, first-close matching and exact source offsets', () => {
    const raw = '<TOOL_CALL>\n {"name":"sample_tool","arguments":{"value":1}} \n</Tool_Call>';
    const text = `İ🙂 before ${raw} after`;
    expect(extractToolBlocks(text).calls).toEqual([
      { tool: 'sample_tool', args: { value: 1 }, raw, variantFormat: true },
    ]);
    expect(stripLocalToolBlocks(text)).toBe('İ🙂 before  after');
    expect(stripLocalToolBlocks('a<tool_call>x<tool_call>y</tool_call>b</tool_call>c')).toBe(
      'ab</tool_call>c'
    );
  });

  it('preserves unmatched tags and strips each complete pair, including empty pairs', () => {
    const text = 'a</tool_call>b<tool_call></tool_call>c<tool_call>x</tool_call>d<tool_call>tail';
    expect(stripLocalToolBlocks(text)).toBe('a</tool_call>bcd<tool_call>tail');
    expect(extractToolBlocks('<tool_call>   </tool_call>')).toMatchObject({
      calls: [],
      malformed: [],
    });
  });

  it('retains ordering across fenced and legacy calls and reports malformed JSON', () => {
    const text = [
      '<tool_call>{"name":"first"}</tool_call>',
      '```ink-tool\n{"tool":"second","args":{}}\n```',
      '<tool_call>{"name":"third"}</tool_call>',
      '<tool_call>{"name":"broken",</tool_call>',
    ].join('\n');
    const result = extractToolBlocks(text);
    expect(result.calls.map((call) => call.tool)).toEqual(['first', 'second', 'third']);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toMatchObject({ tool: 'broken', fenceClosed: true });
    expect(stripLocalToolBlocks(text)).toBe('');
  });

  it.each(['strip', 'extract'] as const)('bounds repeated unmatched openers: %s', (mode) => {
    // The former lazy regex retried the entire suffix for every opener. The
    // VM deadline interrupts that CPU-only failure; the linear scan has wide
    // headroom. This is a bounded regression, not an end-to-end benchmark.
    const text = '<tool_call>'.repeat(100_000);
    const parse = mode === 'strip' ? stripLocalToolBlocks : extractToolBlocks;
    const result = runInNewContext('parse(text)', { parse, text }, { timeout: 1_000 });
    if (mode === 'strip') expect(result).toBe(text);
    else expect(result).toMatchObject({ calls: [], malformed: [] });
  });
});
