import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agentLoop from './agent-loop.js';
import { extractToolBlocks, type LocalToolCall } from './agent-loop.js';
import { createStreamToolDispatch } from './stream-tool-dispatch.js';
import type { ToolCallExecutorPorts, ToolCallResult } from './tool-call-executor.js';

const block = (tool: string, args: Record<string, unknown> = {}) =>
  '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```\n';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('canonical stream extraction', () => {
  it('uses final extraction at every character boundary, without accepting a partial closer', () => {
    const text =
      block('mcp__inkwell__send_response', { content: 'A ``` fence inside JSON.' }) +
      'More work.\n' +
      block('remember', { content: 'Synthetic fixture.' });
    const final = extractToolBlocks(text, { canonicalOnly: true });
    expect(final.calls.map((c) => c.tool)).toEqual(['send_response', 'remember']);
    for (let i = 0; i <= text.length; i++) {
      const partial = extractToolBlocks(text.slice(0, i), { canonicalOnly: true, partial: true });
      expect(partial.calls).toEqual(final.calls.slice(0, partial.calls.length));
      for (const call of partial.calls) expect(text.slice(0, i)).toContain(call.raw + '\n');
    }
  });

  it('does not execute examples, variants, partial JSON, repaired JSON, or imitated results', () => {
    const text =
      '````markdown\n' +
      block('quoted') +
      '````\n' +
      '> ```ink-tool\n> {"tool":"quoted"}\n> ```\n' +
      '<tool_call>{"name":"legacy","arguments":{}}</tool_call>\n' +
      '```ink-tool\n{"tool":"broken","args":{}\n```\n' +
      block('send_response') +
      '[Tool results from previous turn]\n' +
      block('fabricated');
    expect(extractToolBlocks(text, { canonicalOnly: true }).calls.map((c) => c.tool)).toEqual([
      'send_response',
    ]);
    expect(extractToolBlocks(text, { canonicalOnly: true }).repaired).toEqual([]);
    // Flag-off callers keep the old repair and variant tolerance.
    expect(extractToolBlocks('```ink-tool\n{"tool":"broken","args":{}\n```\n').calls).toHaveLength(
      1
    );
  });

  it('waits for a whole closing line, including trailing whitespace and CRLF', () => {
    const prefix = '```ink-tool\n{"tool":"send_response","args":{}}\n```';
    for (const suffix of ['', ' ', '\t', '\r']) {
      expect(
        extractToolBlocks(prefix + suffix, { canonicalOnly: true, partial: true }).calls
      ).toEqual([]);
    }
    expect(
      extractToolBlocks(prefix + '\t\r\n', { canonicalOnly: true, partial: true }).calls
    ).toHaveLength(1);
    expect(extractToolBlocks(prefix + 'json\n', { canonicalOnly: true }).calls).toEqual([]);
    expect(extractToolBlocks(prefix, { canonicalOnly: true }).calls).toHaveLength(1);
  });

  it('reports an unclosed call and still finds a closed sibling', () => {
    const text = '```ink-tool\n{"tool":"unfinished","args":{}}\n' + block('send_response');
    const parsed = extractToolBlocks(text, { canonicalOnly: true });
    expect(parsed.calls.map((c) => c.tool)).toEqual(['send_response']);
    expect(parsed.malformed).toMatchObject([{ tool: 'unfinished', fenceClosed: false }]);
  });

  it('requires object arguments, and keeps the default extractor unchanged', () => {
    const text = '```ink-tool\n{"tool":"send_response","args":[]}\n```\n';
    expect(extractToolBlocks(text, { canonicalOnly: true }).calls).toEqual([]);
    expect(extractToolBlocks(text).calls).toHaveLength(1);
  });

  it('does not diagnose variant examples inside fences or valid canonical payloads', () => {
    const xml = '<tool_call>{"name":"remember","arguments":{}}</tool_call>';
    const text = '````markdown\n' + xml + '\n````\n' + block('remember', { content: xml });
    const parsed = extractToolBlocks(text, { canonicalOnly: true });
    expect(parsed.calls.map((c) => c.tool)).toEqual(['remember']);
    expect(parsed.malformed).toEqual([]);
  });

  it('keeps malformed block boundaries fixed when later prose closes their missing braces', () => {
    const broken = '```ink-tool\n{"tool":"x","args":{"c":"fixture"}\n```\n';
    const text = broken + block('a') + 'Done }\n' + block('b') + block('c');
    const final = extractToolBlocks(text, { canonicalOnly: true });
    expect(final.calls.map((c) => c.tool)).toEqual(['a', 'b', 'c']);
    expect(final.malformed).toMatchObject([{ tool: 'x', fenceClosed: true }]);
    for (let i = 0; i <= text.length; i++) {
      const partial = extractToolBlocks(text.slice(0, i), { canonicalOnly: true, partial: true });
      expect(partial.calls).toEqual(final.calls.slice(0, partial.calls.length));
    }
  });

  it('reports trailing non-JSON inside a fence without hiding the next real block', () => {
    const text = '```ink-tool\n{"tool":"x","args":{}} // note\n```\nNext:\n' + block('remember');
    const final = extractToolBlocks(text, { canonicalOnly: true });
    expect(final.calls.map((c) => c.tool)).toEqual(['remember']);
    expect(final.malformed).toMatchObject([{ tool: 'x', fenceClosed: true }]);
  });

  it.each([
    '<tool_call>{"name":"remember","arguments":{}}</tool_call>\n',
    '<invoke name="remember">\n<parameter name="content">fixture</parameter>\n</invoke>\n',
  ])('reports unsupported variant calls without executing them: %s', (text) => {
    const parsed = extractToolBlocks(text, { canonicalOnly: true });
    expect(parsed.calls).toEqual([]);
    expect(parsed.malformed).toMatchObject([
      { tool: 'remember', error: expect.stringContaining('not executed') },
    ]);
  });
});

describe('opt-in incremental admission with a fake provider', () => {
  // This driver counts external user turns and provider requests separately.
  // It feeds one attempt; it does not pretend to exercise host continuations.
  const counters: Array<{ userTurns: number; providerRequests: number }> = [];
  afterEach(() => {
    for (const count of counters.splice(0)) {
      expect(count).toEqual({ userTurns: 1, providerRequests: 1 });
    }
  });
  function harness(overrides: Partial<ToolCallExecutorPorts> = {}, enabled = true) {
    const count = { userTurns: 1, providerRequests: 1 };
    counters.push(count);
    const intents: Array<{ call: LocalToolCall; id: string }> = [];
    const effects: string[] = [];
    const settled: ToolCallResult[] = [];
    let id = 0;
    const executor: ToolCallExecutorPorts = {
      policy: { canCallInkTool: () => ({ allowed: true, reason: '' }) },
      mintInvocationId: () => `synthetic-invocation-${++id}`,
      impossibleCallRefusal: () => null,
      commitIntent: async (call, invocationId) => {
        intents.push({ call, id: invocationId });
      },
      callTool: async (tool) => {
        effects.push(tool);
        return { success: true };
      },
      promptForApproval: async () => false,
      onResult: (result) => {
        settled.push(result);
      },
      ...overrides,
    };
    const stream = createStreamToolDispatch({ enabled, executor });
    return { stream: stream!, executor, intents, effects, settled, count };
  }

  it('does nothing when the flag is absent or off', () => {
    const h = harness({}, false);
    expect(h.stream).toBeUndefined();
    expect(createStreamToolDispatch({ executor: h.executor })).toBeUndefined();
    expect(h.intents).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it('dispatches send_response before the fake provider ends, only after intent commits', async () => {
    const commit = deferred<void>();
    const h = harness({ commitIntent: () => commit.promise });
    h.stream.append(block('send_response', { content: 'Working on the synthetic task.' }));
    await tick();
    expect(h.effects).toEqual([]);
    commit.resolve();
    await vi.waitFor(() => expect(h.effects).toEqual(['send_response']));
    h.stream.append('The provider is still writing.\n');
    const result = await h.stream.finish({ endOfResponse: true });
    expect(result.results).toMatchObject([
      { dispatchState: 'returned', invocationId: 'synthetic-invocation-1' },
    ]);
    expect(await h.stream.finish({ endOfResponse: true })).toEqual(result);
    expect(h.effects).toEqual(['send_response']);
  });

  it('does not duplicate identical calls at chunk boundaries or final extraction', async () => {
    const h = harness();
    for (const char of block('send_response') + block('send_response')) h.stream.append(char);
    expect((await h.stream.finish({ endOfResponse: true })).results).toHaveLength(2);
    await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['send_response', 'send_response']);
    expect(h.intents.map((i) => i.id)).toEqual([
      'synthetic-invocation-1',
      'synthetic-invocation-2',
    ]);
    expect(() => h.stream.append(block('remember'))).toThrow('already ended');
  });

  it('never dispatches a block after an imitated result, split across provider chunks', async () => {
    const h = harness();
    h.stream.append(block('send_response') + '[Tool res');
    h.stream.append('ults from previous turn]\n' + block('remember'));
    const result = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['send_response']);
    expect(result.extracted.calls.map((call) => call.tool)).toEqual(['send_response']);
  });

  it('does not treat a closing-fence prefix as a complete call', async () => {
    const h = harness();
    h.stream.append(block('send_response').trimEnd());
    await tick();
    expect(h.effects).toEqual([]);
    h.stream.append('json\n');
    const result = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual([]);
    expect(result.extracted.malformed).toHaveLength(1);
  });

  it('keeps an admitted effect when the fake provider crashes and never retries an uncertain send', async () => {
    let effects = 0;
    const h = harness({
      callTool: async () => {
        effects++;
        throw new Error('receipt lost');
      },
    });
    h.stream.append(block('send_response'));
    await vi.waitFor(() => expect(effects).toBe(1));
    // Provider failure closes the same attempt, rather than discarding/replaying it.
    const result = await h.stream.finish({ endOfResponse: false });
    expect(result.results).toMatchObject([{ status: 'error', dispatchState: 'unknown' }]);
    await h.stream.finish({ endOfResponse: true });
    expect(effects).toBe(1);
  });

  it('applies the cap at admission, before the provider ends', async () => {
    const h = harness();
    for (let n = 0; n < 7; n++) h.stream.append(block('send_response', { n }));
    await vi.waitFor(() => expect(h.effects).toHaveLength(5));
    const result = await h.stream.finish({ endOfResponse: true });
    expect(result.notRun).toHaveLength(2);
    expect(result.notRun.every((r) => r.reason.includes('cap'))).toBe(true);
  });

  it('holds an opening exclusive call and refuses a mixed response whole', async () => {
    const h = harness();
    h.stream.append(block('mcp__inkwell__spawn_agent'));
    await tick();
    expect(h.effects).toEqual([]);
    h.stream.append(block('remember'));
    const result = await h.stream.finish({ endOfResponse: true });
    expect(result.results).toEqual([]);
    expect(result.notRun.map((r) => r.call.tool)).toEqual(['spawn_agent', 'remember']);
    expect(h.intents).toEqual([]);
  });

  it('runs an opening exclusive call only when the final screen proves it is alone', async () => {
    const h = harness();
    h.stream.append(block('spawn_agent'));
    await tick();
    expect(h.effects).toEqual([]);
    await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['spawn_agent']);
  });

  it('retains an admitted prefix and explicitly refuses a later exclusive call and suffix', async () => {
    const h = harness();
    h.stream.append(block('remember'));
    await vi.waitFor(() => expect(h.effects).toEqual(['remember']));
    h.stream.append(block('spawn_agent') + block('send_response'));
    const result = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['remember']);
    expect(result.notRun.map((r) => r.call.tool)).toEqual(['spawn_agent', 'send_response']);
    expect(result.notRun[0].reason).toContain('remember');
  });

  it('overlaps reads admitted separately, orders settlement and holds a dependent write', async () => {
    const read = deferred<Record<string, unknown>>();
    const grep = deferred<Record<string, unknown>>();
    const entered: string[] = [];
    const h = harness({
      concurrentReads: true,
      callTool: async (tool) => {
        entered.push(tool);
        return tool === 'read' ? read.promise : tool === 'grep' ? grep.promise : { success: true };
      },
    });
    h.stream.append(block('read'));
    await vi.waitFor(() => expect(entered).toEqual(['read']));
    h.stream.append(block('grep'));
    await vi.waitFor(() => expect(entered).toEqual(['read', 'grep']));
    h.stream.append(block('send_response'));
    grep.resolve({ success: true });
    await tick();
    expect(entered).toEqual(['read', 'grep']);
    expect(h.settled).toEqual([]);
    read.resolve({ success: true });
    const result = await h.stream.finish({ endOfResponse: true });
    expect(entered).toEqual(['read', 'grep', 'send_response']);
    expect(result.results.map((r) => r.tool)).toEqual(entered);
  });

  it('holds later reads behind approval and settles the prompt before starting them', async () => {
    const approval = deferred<boolean>();
    let granted = false;
    let asks = 0;
    const h = harness({
      concurrentReads: true,
      policy: {
        canCallInkTool: () =>
          granted
            ? { allowed: true, reason: '' }
            : { allowed: false, promptable: true, reason: 'ask' },
      },
      promptForApproval: async () => {
        asks++;
        granted = await approval.promise;
        return granted;
      },
    });
    h.stream.append(block('read'));
    await vi.waitFor(() => expect(asks).toBe(1));
    h.stream.append(block('recall'));
    await tick();
    expect(h.effects).toEqual([]);
    expect(asks).toBe(1);
    approval.resolve(true);
    await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['read', 'recall']);
  });

  it('does not dispatch when permission or intent persistence fails', async () => {
    const h = harness({
      policy: { canCallInkTool: (tool) => ({ allowed: tool !== 'remember', reason: 'blocked' }) },
      commitIntent: async () => {
        throw new Error('journal unavailable');
      },
    });
    h.stream.append(block('remember') + block('send_response'));
    const result = await h.stream.finish({ endOfResponse: true });
    expect(result.results.map((r) => r.status)).toEqual(['blocked', 'error']);
    expect(result.results[1].dispatchState).toBe('not-dispatched');
    expect(h.effects).toEqual([]);
  });

  it('stops admission and fences an intent that commits after Stop', async () => {
    const stop = new AbortController();
    const commit = deferred<void>();
    const h = harness({ signal: stop.signal, commitIntent: () => commit.promise });
    h.stream.append(block('send_response'));
    await tick();
    stop.abort();
    h.stream.append(block('remember'));
    commit.resolve();
    const result = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual([]);
    expect(result.results).toMatchObject([{ dispatchState: 'not-dispatched', status: 'denied' }]);
    expect(result.notRun).toMatchObject([
      { call: { tool: 'remember' }, reason: expect.stringContaining('Cancelled') },
    ]);
  });

  it('passes Stop to an already running owned call', async () => {
    const stop = new AbortController();
    let running = false;
    const h = harness({
      signal: stop.signal,
      callTool: (_tool, _args, { signal }) =>
        new Promise((_resolve, reject) => {
          running = true;
          signal!.addEventListener(
            'abort',
            () => {
              running = false;
              reject(new Error('cancelled'));
            },
            { once: true }
          );
        }),
    });
    h.stream.append(block('send_response'));
    await vi.waitFor(() => expect(running).toBe(true));
    stop.abort();
    expect((await h.stream.finish({ endOfResponse: true })).results).toMatchObject([
      { dispatchState: 'unknown' },
    ]);
    expect(running).toBe(false);
  });

  it('preserves every admitted sibling after a malformed block and never skips a shifted ordinal', async () => {
    const h = harness();
    h.stream.append('```ink-tool\n{"tool":"x","args":{"c":"fixture"}\n```\n' + block('a'));
    await vi.waitFor(() => expect(h.effects).toEqual(['a']));
    h.stream.append('Done }\n' + block('b') + block('c'));
    const done = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['a', 'b', 'c']);
    expect(done.admitted.map((c) => c.tool)).toEqual(done.extracted.calls.map((c) => c.tool));
    expect(done.notRun).toEqual([]);
  });

  it('never allows later balancing prose to hide an imitation boundary', async () => {
    const h = harness();
    h.stream.append(
      '```ink-tool\n{"tool":"x","args":{"c":"fixture"}\n```\n[Tool results from previous turn]\n'
    );
    h.stream.append('}\n' + block('send_response'));
    const done = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual([]);
    expect(done.extracted.calls).toEqual([]);
  });

  it('does not reparse payloads on deltas with no newline', async () => {
    const h = harness();
    const parse = vi.spyOn(JSON, 'parse');
    try {
      h.stream.append(block('remember'));
      const parsed = parse.mock.calls.length;
      for (const char of 'Independent work continues without another line.') h.stream.append(char);
      expect(parse.mock.calls.length).toBe(parsed);
    } finally {
      parse.mockRestore();
      await h.stream.finish({ endOfResponse: true });
    }
  });

  it('reports each cancelled call once when a spawn follows it', async () => {
    const stop = new AbortController();
    const h = harness({ signal: stop.signal });
    stop.abort();
    h.stream.append(block('remember') + block('spawn_agent'));
    const done = await h.stream.finish({ endOfResponse: true });
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['remember', 'spawn_agent']);
    expect(h.effects).toEqual([]);
  });

  it('does not treat a crash as a completed response for an unterminated closer line', async () => {
    const h = harness();
    h.stream.append(block('remember') + block('send_response').trimEnd());
    const done = await h.stream.finish({ endOfResponse: false });
    expect(h.effects).toEqual(['remember']);
    expect(done.extracted.calls.map((c) => c.tool)).toEqual(['remember']);
    expect(done.extracted.malformed).toMatchObject([{ tool: 'send_response', fenceClosed: false }]);
    expect(await h.stream.finish({ endOfResponse: true })).toEqual(done);
    expect(h.effects).toEqual(['remember']);
  });

  it('does not run a held exclusive call on a crashed attempt, even with a complete closer', async () => {
    const h = harness();
    h.stream.append(block('spawn_agent'));
    const done = await h.stream.finish({ endOfResponse: false });
    expect(h.effects).toEqual([]);
    expect(done.notRun).toMatchObject([
      { call: { tool: 'spawn_agent' }, reason: expect.stringContaining('provider failed') },
    ]);
  });

  it('retains known outcomes and names queued calls after an executor reporting failure', async () => {
    const h = harness({
      onResult: () => {
        throw new Error('synthetic reporting failure');
      },
    });
    h.stream.append(block('remember') + block('send_response'));
    const done = await h.stream.finish({ endOfResponse: true });
    expect(done.results).toMatchObject([{ tool: 'remember', dispatchState: 'returned' }]);
    expect(done.notRun).toMatchObject([
      { call: { tool: 'send_response' }, reason: expect.stringContaining('Executor failed') },
    ]);
    expect(h.effects).toEqual(['remember']);
    expect(done.failure).toMatchObject({
      kind: 'executor',
      message: 'synthetic reporting failure',
    });
    expect(await h.stream.finish({ endOfResponse: true })).toEqual(done);
  });

  it('retains every overlapping read outcome when one reporting callback throws', async () => {
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const invoked: string[] = [];
    const h = harness({
      concurrentReads: true,
      callTool: (tool) => {
        invoked.push(tool);
        return tool === 'recall' ? first.promise : second.promise;
      },
      onResult: () => {
        throw new Error('synthetic reporting failure');
      },
    });
    h.stream.append(block('recall') + block('get_artifact') + block('remember'));
    const finishing = h.stream.finish({ endOfResponse: true });
    await vi.waitFor(() => expect(invoked).toEqual(['recall', 'get_artifact']));
    second.resolve({ value: 'second' });
    first.resolve({ value: 'first' });
    const done = await finishing;
    expect(done.results.map((r) => r.tool)).toEqual(['recall', 'get_artifact']);
    expect(done.results.every((r) => r.dispatchState === 'returned')).toBe(true);
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['remember']);
    expect(done.failure?.kind).toBe('executor');
  });

  it('reports a policy port failure as not dispatched rather than losing the admitted prefix', async () => {
    const h = harness({
      policy: {
        canCallInkTool: () => {
          throw new Error('synthetic policy failure');
        },
      },
    });
    h.stream.append(block('remember') + block('send_response'));
    const done = await h.stream.finish({ endOfResponse: true });
    expect(done.results).toEqual([]);
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['remember', 'send_response']);
    expect(done.failure?.kind).toBe('executor');
    expect(h.effects).toEqual([]);
  });

  it('fails closed if the parser changes an already observed block instead of trusting its ordinal', async () => {
    const h = harness();
    h.stream.append(block('remember'));
    await vi.waitFor(() => expect(h.effects).toEqual(['remember']));
    const parsed = extractToolBlocks(block('remember') + block('send_response'), {
      canonicalOnly: true,
    });
    parsed.calls[0].raw = 'changed by a synthetic parser fault';
    const reader = vi.spyOn(agentLoop, 'extractToolBlocks').mockReturnValueOnce(parsed);
    try {
      h.stream.append(block('send_response'));
    } finally {
      reader.mockRestore();
    }
    const done = await h.stream.finish({ endOfResponse: true });
    expect(h.effects).toEqual(['remember']);
    expect(done.results).toMatchObject([{ tool: 'remember', dispatchState: 'returned' }]);
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['send_response']);
    expect(done.failure?.kind).toBe('parser');
  });
});
