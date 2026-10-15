import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const result = await h.stream.finish();
    expect(result.results).toMatchObject([
      { dispatchState: 'returned', invocationId: 'synthetic-invocation-1' },
    ]);
    expect(await h.stream.finish()).toEqual(result);
    expect(h.effects).toEqual(['send_response']);
  });

  it('does not duplicate identical calls at chunk boundaries or final extraction', async () => {
    const h = harness();
    for (const char of block('send_response') + block('send_response')) h.stream.append(char);
    expect((await h.stream.finish()).results).toHaveLength(2);
    await h.stream.finish();
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
    const result = await h.stream.finish();
    expect(h.effects).toEqual(['send_response']);
    expect(result.extracted.calls.map((call) => call.tool)).toEqual(['send_response']);
  });

  it('does not treat a closing-fence prefix as a complete call', async () => {
    const h = harness();
    h.stream.append(block('send_response').trimEnd());
    await tick();
    expect(h.effects).toEqual([]);
    h.stream.append('json\n');
    const result = await h.stream.finish();
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
    const result = await h.stream.finish();
    expect(result.results).toMatchObject([{ status: 'error', dispatchState: 'unknown' }]);
    await h.stream.finish();
    expect(effects).toBe(1);
  });

  it('applies the cap at admission, before the provider ends', async () => {
    const h = harness();
    for (let n = 0; n < 7; n++) h.stream.append(block('send_response', { n }));
    await vi.waitFor(() => expect(h.effects).toHaveLength(5));
    const result = await h.stream.finish();
    expect(result.notRun).toHaveLength(2);
    expect(result.notRun.every((r) => r.reason.includes('cap'))).toBe(true);
  });

  it('holds an opening exclusive call and refuses a mixed response whole', async () => {
    const h = harness();
    h.stream.append(block('mcp__inkwell__spawn_agent'));
    await tick();
    expect(h.effects).toEqual([]);
    h.stream.append(block('remember'));
    const result = await h.stream.finish();
    expect(result.results).toEqual([]);
    expect(result.notRun.map((r) => r.call.tool)).toEqual(['spawn_agent', 'remember']);
    expect(h.intents).toEqual([]);
  });

  it('runs an opening exclusive call only when the final screen proves it is alone', async () => {
    const h = harness();
    h.stream.append(block('spawn_agent'));
    await tick();
    expect(h.effects).toEqual([]);
    await h.stream.finish();
    expect(h.effects).toEqual(['spawn_agent']);
  });

  it('retains an admitted prefix and explicitly refuses a later exclusive call and suffix', async () => {
    const h = harness();
    h.stream.append(block('remember'));
    await vi.waitFor(() => expect(h.effects).toEqual(['remember']));
    h.stream.append(block('spawn_agent') + block('send_response'));
    const result = await h.stream.finish();
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
    const result = await h.stream.finish();
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
    await h.stream.finish();
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
    const result = await h.stream.finish();
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
    const result = await h.stream.finish();
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
    expect((await h.stream.finish()).results).toMatchObject([{ dispatchState: 'unknown' }]);
    expect(running).toBe(false);
  });
});
