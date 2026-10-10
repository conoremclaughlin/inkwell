import { describe, expect, it } from 'vitest';
import { ClaudeSearchStream, validatedUrl, verifyCapabilities } from './claude.js';
import { CLAUDE_VERSION, LIMITS } from './config.js';
import { WebSearchError } from './errors.js';
import { HELP, MODEL, searchEvents } from './fixtures.test-support.js';

function read(events: Record<string, unknown>[], maxResults = 10) {
  const stream = new ClaudeSearchStream(MODEL, maxResults);
  for (const event of events) stream.accept(JSON.stringify(event));
  return stream.output();
}

describe('Claude capability and native search evidence (synthetic only)', () => {
  const invalidate = {
    type: 'system',
    subtype: 'ui_invalidate',
    event: 'ui.render',
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'synthetic-session',
  };

  it('discards only a validated UI invalidation before init or during a search', () => {
    const events = searchEvents();
    expect(read([invalidate, events[0], invalidate, ...events.slice(1)])).toEqual(read(events));
    expect(
      read([
        {
          ...invalidate,
          instances: [{ surface: 'synthetic', component: 'synthetic', instance_id: 'synthetic' }],
        },
        ...events,
      ])
    ).toEqual(read(events));
    expect(() => read([invalidate])).toThrow('search_not_observed');
    expect(() => read([invalidate, ...events.slice(1)])).toThrow('invalid_output');
    expect(() => read([...events, invalidate])).toThrow('invalid_output');
  });

  it('does not turn UI tolerance into arbitrary pre-init/system/hook traffic tolerance', () => {
    for (const patch of [
      { event: 'tool.call' },
      { event: undefined },
      { uuid: 'not-a-uuid' },
      { session_id: '' },
      { session_id: 's'.repeat(201) },
      { instances: [{ surface: 'synthetic' }] },
      { instances: Array(33).fill({}) },
      { parent_tool_use_id: 'synthetic' },
      { extra: true },
    ])
      expect(() => read([{ ...invalidate, ...patch }, ...searchEvents()])).toThrow(
        'invalid_output'
      );
    for (const subtype of ['hook_started', 'ui_log', 'commands_changed', 'new_event']) {
      expect(() => read([{ ...invalidate, subtype }, ...searchEvents()])).toThrow();
    }
    const events = searchEvents();
    events[0].plugins = [{ name: 'cc-plugin-agents-md', path: 'builtin' }];
    expect(() => read([invalidate, ...events])).toThrow('unsupported_capability');
  });

  it('counts ignored UI events toward the same bounded event budget', () => {
    const stream = new ClaudeSearchStream(MODEL, 1);
    for (let i = 0; i < LIMITS.events; i++) stream.accept(JSON.stringify(invalidate));
    expect(() => stream.accept(JSON.stringify(invalidate))).toThrow('output_limit');
  });

  it('accepts bounded thinking estimates only between init and result, never as evidence', () => {
    const notice = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 12,
      estimated_tokens_delta: 2,
      uuid: invalidate.uuid,
      session_id: invalidate.session_id,
    };
    const events = searchEvents();
    expect(read([events[0], notice, ...events.slice(1)])).toEqual(read(events));
    expect(() => read([notice, ...events])).toThrow('invalid_output');
    expect(() => read([...events, notice])).toThrow('invalid_output');
    expect(() => read([events[0], notice, events[3]])).toThrow('search_not_observed');
    for (const patch of [
      { estimated_tokens: -1 },
      { estimated_tokens_delta: 0.5 },
      { estimated_tokens: 10_000_001 },
      { estimated_tokens_delta: undefined },
      { extra: 'synthetic' },
    ])
      expect(() => read([events[0], { ...notice, ...patch }, ...events.slice(1)])).toThrow(
        'invalid_output'
      );
  });

  it('requires the reviewed version AND structural isolation flags', () => {
    expect(() => verifyCapabilities(`${CLAUDE_VERSION} (Claude Code)\n`, HELP)).not.toThrow();
    for (const version of ['2.1.293', '2.1.295', '3.0.0']) {
      expect(() => verifyCapabilities(`${version} (Claude Code)`, HELP)).toThrow(
        'unsupported_capability'
      );
    }
    for (const flag of [
      '--tools',
      '--bare',
      '--safe-mode',
      '--strict-mcp-config',
      '--disallowedTools',
      '--setting-sources',
    ]) {
      expect(() =>
        verifyCapabilities(`${CLAUDE_VERSION} (Claude Code)`, HELP.replace(flag, 'omitted'))
      ).toThrow('unsupported_capability');
    }
  });

  it('discards opaque rate-limit accounting only inside an initialized stream', () => {
    const notice = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', utilization: 0.1 },
      uuid: invalidate.uuid,
      session_id: invalidate.session_id,
    };
    const events = searchEvents();
    expect(read([events[0], notice, ...events.slice(1)])).toEqual(read(events));
    expect(() => read([notice, ...events])).toThrow('invalid_output');
    expect(() => read([...events, notice])).toThrow('invalid_output');
    expect(() => read([events[0], notice, events[3]])).toThrow('search_not_observed');
    for (const patch of [
      { rate_limit_info: null },
      { rate_limit_info: { status: 'invented' } },
      { extra: true },
    ]) {
      expect(() => read([events[0], { ...notice, ...patch }, ...events.slice(1)])).toThrow(
        'invalid_output'
      );
    }
  });

  it.each([undefined, 'ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'oauth'])(
    'refuses unexpected init auth source %s without treating the stream as accepted',
    (source) => {
      const events = searchEvents();
      events[0].apiKeySource = source;
      expect(() => read(events)).toThrow('unsupported_capability');
    }
  );

  it('uses native links and observed queries; never assistant claims or commentary', () => {
    const events = searchEvents();
    events[3].result = JSON.stringify({
      results: [
        { title: 'Hallucinated', url: 'https://example.org/invented', snippet: 'invented' },
      ],
      searchQueries: ['claimed query'],
    });
    const output = read(events);
    expect(output).toEqual({
      provider: 'claude',
      model: MODEL,
      results: [{ title: 'Synthetic search hit', url: 'https://example.com/result', snippet: '' }],
      searchQueries: ['synthetic query'],
      usage: { inputTokens: 42, outputTokens: 8 },
    });
  });

  it('deduplicates and caps results, but validates even discarded links', () => {
    const events = searchEvents('q', [
      'https://example.com/a',
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(read(events, 1).results).toHaveLength(1);
    expect(() =>
      read(searchEvents('q', ['https://example.com/a', 'file:///synthetic']), 1)
    ).toThrow('invalid_output');
  });

  it('accepts a successful zero-hit native search', () => {
    expect(read(searchEvents('empty query', [])).results).toEqual([]);
  });

  it('refuses answers and tool-call announcements without actual search results', () => {
    const events = searchEvents();
    expect(() => read([events[0], events[3]])).toThrow('search_not_observed');
    expect(() => read([events[0], events[1], events[3]])).toThrow('search_not_observed');
    expect(() => read(events.slice(0, 3))).toThrow('search_not_observed');
  });

  it('refuses commentary-only success, budget skips, missing native metadata and errors', () => {
    for (const results of [
      [],
      ['Some links: https://example.com'],
      ['Web search error: limit'],
      ['Web search was not performed'],
    ]) {
      const events = searchEvents();
      (events[2].tool_use_result as Record<string, unknown>).results = results;
      expect(() => read(events)).toThrow('search_not_observed');
    }
    const events = searchEvents();
    delete events[2].tool_use_result;
    expect(() => read(events)).toThrow('invalid_output');
    const zeroBudget = searchEvents();
    (zeroBudget[2].tool_use_result as Record<string, unknown>).searchCount = 0;
    expect(() => read(zeroBudget)).toThrow('invalid_output');
  });

  it.each(['Bash', 'Read', 'WebFetch', 'Agent', 'mcp__synthetic__search', 'apply_patch'])(
    'refuses %s in the observed tool surface',
    (tool) => {
      const events = searchEvents();
      events[0].tools = ['WebSearch', tool];
      expect(() => read(events)).toThrow('unsupported_capability');
    }
  );

  it('refuses MCP connections, plugins, wrong models/versions, and missing init', () => {
    for (const patch of [
      { mcp_servers: [{ name: 'synthetic' }] },
      { plugins: [{ name: 'synthetic' }] },
      { model: 'different-model' },
      { claude_code_version: '0.0.0' },
      { tools: [] },
    ]) {
      const events = searchEvents();
      Object.assign(events[0], patch);
      expect(() => read(events)).toThrow('unsupported_capability');
    }
    expect(() => read(searchEvents().slice(1))).toThrow('invalid_output');
  });

  it('correlates tool results by ID and query, rejects duplicate/reordered results', () => {
    const events = searchEvents();
    expect(() => read([events[0], events[2], events[1], events[3]])).toThrow('invalid_output');
    expect(() => read([events[0], events[1], events[2], events[2], events[3]])).toThrow(
      'invalid_output'
    );
    (events[2].tool_use_result as Record<string, unknown>).query = 'not the observed query';
    expect(() => read(events)).toThrow('invalid_output');
  });

  it('refuses denied/error events and unexpected tool calls even with valid earlier results', () => {
    const events = searchEvents();
    events[1] = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
    };
    expect(() => read(events)).toThrow('unsupported_capability');
    const denied = searchEvents();
    denied[2] = {
      ...denied[2],
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'search-1',
            is_error: true,
            content: 'synthetic private stderr',
          },
        ],
      },
    };
    expect(() => read(denied)).toThrow('provider_failed');
    const failed = searchEvents();
    failed[3].is_error = true;
    expect(() => read(failed)).toThrow('provider_failed');
    const hook = searchEvents();
    hook.splice(1, 0, { type: 'system', subtype: 'hook_started' });
    expect(() => read(hook)).toThrow('unsupported_capability');
  });

  it('bounds tool calls, event count, fields, and usage; malformed input errors remain static', () => {
    const events = searchEvents();
    const stream = new ClaudeSearchStream(MODEL, 10);
    stream.accept(JSON.stringify(events[0]));
    for (let index = 0; index < 4; index++) {
      stream.accept(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: `s-${index}`, name: 'WebSearch', input: { query: 'q' } },
            ],
          },
        })
      );
    }
    expect(() =>
      stream.accept(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 's-5', name: 'WebSearch', input: { query: 'q' } }],
          },
        })
      )
    ).toThrow('output_limit');
    events[3].usage = { input_tokens: -1 };
    expect(() => read(events)).toThrow('invalid_output');
    expect(() => stream.accept('synthetic provider private text')).toThrow(
      /^Web search refused: invalid_output$/
    );
    expect(new WebSearchError('timeout').cause).toBeUndefined();
    expect(() => read(searchEvents('q'.repeat(501)))).toThrow('invalid_output');
    const many = new ClaudeSearchStream(MODEL, 1);
    many.accept(JSON.stringify(searchEvents()[0]));
    for (let index = 0; index < 255; index++)
      many.accept(JSON.stringify({ type: 'assistant', message: { content: [] } }));
    expect(() => many.accept('{}')).toThrow('output_limit');
  });

  it.each([
    'file:///tmp/synthetic',
    'javascript:synthetic',
    'data:text/plain,synthetic',
    'https://name:secret@example.com',
    'http://localhost/a',
    'http://127.0.0.1',
    'http://0x7f000001',
    'http://2130706433',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'https://example.local',
    'https://example.internal',
    'https://example.com:8080',
    'https://example.com\\@localhost',
    'https://example.com/\n',
    '//example.com/a',
  ])('rejects invalid/nonpublic URL %s without DNS/fetch', (url) => {
    expect(() => validatedUrl(url)).toThrow('invalid_output');
  });
});
