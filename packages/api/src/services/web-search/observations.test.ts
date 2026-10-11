import { describe, expect, it } from 'vitest';
import { SearchObservations } from './observations';
import { searchEvents } from './fixtures.test-support';

const queryLine = (query: string) => JSON.stringify(searchEvents(query)[1]);

describe('bounded forensic observations, not parser authority', () => {
  it('records rejected/overlong query text before validation, truncates it and copies snapshots', () => {
    const observations = new SearchObservations(true);
    observations.observe(queryLine('x'.repeat(501)));
    const first = observations.snapshot();
    expect(first).toMatchObject({
      kind: 'unvalidated-stream-observations',
      queryCount: 1,
      truncated: true,
      queries: [{ query: 'x'.repeat(500), truncated: true }],
    });
    first.queries![0].query = 'mutated';
    expect(observations.snapshot().queries![0].query).toBe('x'.repeat(500));
  });

  it('retains only bounded query and native hit fields, not transcripts, stderr or other tool arguments', () => {
    const observations = new SearchObservations(true);
    for (let i = 0; i < 9; i++) observations.observe(queryLine('q' + i));
    observations.observe(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'private prose' },
            { type: 'tool_use', name: 'Bash', input: { command: 'private command' } },
          ],
        },
      })
    );
    const hit = { title: 't'.repeat(501), url: 'u'.repeat(2049), opaque: 'private native field' };
    observations.observe(
      JSON.stringify({
        type: 'user',
        tool_use_result: { results: ['private commentary', { content: Array(11).fill(hit) }] },
        message: { content: 'private display' },
      })
    );
    const result = observations.snapshot();
    expect(result.queries).toHaveLength(5);
    expect(result.queryCount).toBe(9);
    expect(result.hits).toHaveLength(10);
    expect(result.hitCount).toBe(11);
    expect(result.hits![0]).toEqual({
      title: 't'.repeat(500),
      url: 'u'.repeat(2048),
      truncated: true,
    });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('recording off retains only counts/flags, even for rejected or malformed observations', () => {
    const observations = new SearchObservations(false);
    for (const event of searchEvents('private query', ['https://example.com/private']))
      observations.observe(JSON.stringify(event));
    observations.observe('{not-json');
    expect(observations.snapshot()).toEqual({
      kind: 'unvalidated-stream-observations',
      queryCount: 1,
      hitCount: 1,
      truncated: false,
      malformedLines: 1,
    });
  });

  it('handles malformed shapes and non-text queries without serializing arbitrary values', () => {
    const observations = new SearchObservations(true);
    for (const event of [
      null,
      [],
      { type: 'assistant', message: { content: 'not blocks' } },
      { type: 'user', tool_use_result: { results: [{ content: [null, 1, 's'] }] } },
    ])
      observations.observe(JSON.stringify(event));
    observations.observe(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'WebSearch', input: { query: { secret: 'private' } } },
          ],
        },
      })
    );
    expect(observations.snapshot()).toMatchObject({
      queryCount: 1,
      truncated: true,
      queries: [],
      hits: [],
    });
    expect(JSON.stringify(observations.snapshot())).not.toContain('private');
  });
});

it('escapes NUL, quotes, backslashes and unpaired surrogates without losing the observed prefix', () => {
  const invalidUnicode = String.fromCharCode(0xd800);
  const query = [
    'q',
    String.fromCharCode(0, 34, 92),
    'literal',
    String.fromCharCode(92),
    'ud800',
    invalidUnicode,
  ].join('');
  const observations = new SearchObservations(true);
  observations.observe(queryLine(query));
  const snapshot = observations.snapshot();
  const recorded = snapshot.queries![0].query;
  expect(snapshot.textEncoding).toBe('json-string-content');
  expect(recorded).not.toContain(String.fromCharCode(0));
  expect(recorded).not.toContain(invalidUnicode);
  expect(JSON.parse('"' + recorded + '"')).toBe(query);
});
