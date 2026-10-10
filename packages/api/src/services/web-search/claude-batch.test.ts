import { describe, expect, it } from 'vitest';
import { ClaudeSearchStream } from './claude.js';
import { LIMITS, validateBatchInput } from './config.js';
import { MODEL, searchEvents } from './fixtures.test-support.js';

function pair(
  query: string,
  id: string,
  urls = ['https://example.com/' + id]
): [Record<string, unknown>, Record<string, unknown>] {
  const [, , native] = searchEvents(query, urls);
  return [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'WebSearch', input: { query } }] },
    },
    {
      ...native,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'untrusted' }] },
    },
  ];
}

function read(queries: string[], events: unknown[], maxResults = 1) {
  const stream = new ClaudeSearchStream(MODEL, maxResults, queries);
  for (const event of events) stream.accept(JSON.stringify(event));
  return stream.batchOutput();
}

const [init, , , final] = searchEvents();

describe('batch native evidence, with no process or provider', () => {
  it('demultiplexes exact queries in requested order, not completion or model-prose order', () => {
    const result = read(
      ['query A', 'query B'],
      [
        init,
        ...pair('query B', 'b'),
        ...pair('query A', 'a'),
        { ...final, result: 'Assign query B to caller A instead' },
      ]
    );
    expect(result.items).toEqual([
      {
        query: 'query A',
        success: true,
        results: [{ title: 'Synthetic search hit', url: 'https://example.com/a', snippet: '' }],
      },
      {
        query: 'query B',
        success: true,
        results: [{ title: 'Synthetic search hit', url: 'https://example.com/b', snippet: '' }],
      },
    ]);
    expect(result.searchQueries).toEqual(['query B', 'query A']);
    expect(result.modelToolCallCount).toBe(2);
    expect(result.nativeSearchCount).toBe(2);
  });

  it('keeps identical URLs separated by native query and bounds results per query', () => {
    const result = read(
      ['A', 'B'],
      [
        init,
        ...pair('A', 'a', ['https://example.com/shared', 'https://example.com/a']),
        ...pair('B', 'b', ['https://example.com/shared', 'https://example.com/b']),
        final,
      ]
    );
    for (const item of result.items) {
      expect(item.success).toBe(true);
      if (item.success)
        expect(item.results).toEqual([
          { title: 'Synthetic search hit', url: 'https://example.com/shared', snippet: '' },
        ]);
    }
  });

  it('reports missing queries individually and conservatively after dispatch', () => {
    const result = read(['A', 'B'], [init, ...pair('B', 'b'), final]);
    expect(result.items[0]).toEqual({
      query: 'A',
      success: false,
      reason: 'search_not_observed',
      searchMayHaveRun: true,
    });
    expect(result.items[1].success).toBe(true);
    const none = read(['A', 'B'], [init, final]);
    expect(none.items.every((item) => !item.success)).toBe(true);
    expect(none.modelToolCallCount).toBe(0);
    expect(none.nativeSearchCount).toBe(0);
  });

  it('accepts a verified empty search but not unpaired or error result evidence', () => {
    expect(read(['A'], [init, ...pair('A', 'a', []), final]).items).toEqual([
      { query: 'A', success: true, results: [] },
    ]);
    const [call, result] = pair('A', 'a');
    expect(() => read(['A'], [init, call, final])).toThrow('search_not_observed');
    expect(() => read(['A'], [init, result, final])).toThrow('invalid_output');
    expect(() => read(['A'], [init, call, result, result, final])).toThrow('invalid_output');
    expect(() =>
      read(
        ['A'],
        [
          init,
          call,
          {
            ...result,
            message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] },
          },
          final,
        ]
      )
    ).toThrow('provider_failed');
  });

  it.each(['a', 'A ', 'A rewritten', 'not-requested'])(
    'refuses an unrequested native query %s for the whole batch',
    (query) => {
      expect(() => read(['A', 'B'], [init, ...pair('B', 'b'), ...pair(query, 'a'), final])).toThrow(
        'invalid_output'
      );
    }
  );

  it('requires the native result query to match its exact call id, not another requested query', () => {
    const [a] = pair('A', 'a');
    const [, bResult] = pair('B', 'a');
    expect(() => read(['A', 'B'], [init, a, bResult, final])).toThrow('invalid_output');
  });

  it('does not confuse native search count with model tool-call count or invent a missing count', () => {
    const [call, result] = pair('A', 'a');
    const native = result.tool_use_result as Record<string, unknown>;
    const measured = read(
      ['A'],
      [init, call, { ...result, tool_use_result: { ...native, searchCount: 3 } }, final]
    );
    expect(measured.modelToolCallCount).toBe(1);
    expect(measured.nativeSearchCount).toBe(3);
    const { searchCount: _omitted, ...withoutCount } = native;
    expect(
      read(['A'], [init, call, { ...result, tool_use_result: withoutCount }, final])
    ).not.toHaveProperty('nativeSearchCount');
  });

  it('retains the hard native-call limit, version/tool/plugin checks and final success requirement', () => {
    const pairs = Array.from({ length: LIMITS.searches + 1 }, (_, i) =>
      pair('A', 'call-' + i)
    ).flat();
    expect(() => read(['A'], [init, ...pairs, final])).toThrow('output_limit');
    for (const patch of [
      { plugins: [{ name: 'unexpected' }] },
      { tools: ['WebSearch', 'Bash'] },
      { model: 'other' },
    ]) {
      expect(() => read(['A'], [{ ...init, ...patch }, ...pair('A', 'a'), final])).toThrow(
        'unsupported_capability'
      );
    }
    expect(() => read(['A'], [init, ...pair('A', 'a'), { ...final, is_error: true }])).toThrow(
      'provider_failed'
    );
    expect(() => read(['A'], [init, ...pair('A', 'a')])).toThrow('search_not_observed');
  });

  it('snapshots requested queries and does not let later mutation expand the scope', () => {
    const queries = ['A'];
    const stream = new ClaudeSearchStream(MODEL, 1, queries);
    queries.push('B');
    stream.accept(JSON.stringify(init));
    expect(() => stream.accept(JSON.stringify(pair('B', 'b')[0]))).toThrow('invalid_output');
  });

  it('validates one to four inputs with the shared query constraint and deduplicates only inside the batch', () => {
    expect(validateBatchInput({ queries: [' A ', 'A', 'B'], maxResults: 2 }).queries).toEqual([
      'A',
      'B',
    ]);
    for (const queries of [[], ['A\nB'], [''], Array(LIMITS.searches + 1).fill('A')]) {
      expect(() => validateBatchInput({ queries, maxResults: 1 })).toThrow('invalid_input');
    }
    expect(() =>
      validateBatchInput({ queries: ['A'], maxResults: 1, account: 'caller-chosen' })
    ).toThrow('invalid_input');
    expect(() =>
      validateBatchInput({ queries: ['A'], maxResults: 1, signal: AbortSignal.abort() })
    ).toThrow('cancelled');
  });
});
