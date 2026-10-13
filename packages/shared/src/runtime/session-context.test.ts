import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type LocalToolCall } from './agent-loop.js';
import { ContextLedger } from './context-ledger.js';
import { createSignalSink, handleClientLocalTool, type SessionStatus } from './context-tools.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** Real loop and context tools, with only the provider and UI replaced. */
function session() {
  const ledger = new ContextLedger();
  const signal = createSignalSink();
  const abort = new AbortController();
  const started = deferred<void>();
  const reply = deferred<SessionStatus>();
  const execute = vi.fn(async (calls: LocalToolCall[]) =>
    calls.map((call) => ({
      tool: call.tool,
      args: call.args,
      status: 'executed',
      result: handleClientLocalTool(call.tool, call.args, ledger, signal),
    }))
  );
  const run = () =>
    runAgentLoop(
      { prompt: 'fixture', toolRouting: 'local', signal: abort.signal },
      {
        backend: {
          runTurn: async () => {
            started.resolve();
            const status = await reply.promise;
            return {
              success: true,
              stdout: '',
              stderr: '',
              responseText:
                '```ink-tool\n' +
                JSON.stringify({ tool: 'signal_status', args: { status } }) +
                '\n```',
            };
          },
        },
        tools: { execute },
        ui: { printLine: () => {}, printEvent: () => {}, startWaiting: () => () => {} },
      }
    );
  return { ledger, signal, abort, started, reply, run, execute };
}

describe('session-local context controls', () => {
  it('fails closed when signal_status has no session binding', () => {
    const result = handleClientLocalTool(
      'signal_status',
      { status: 'completed' },
      new ContextLedger()
    );
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('session-local signal sink');
  });

  it('rejects invalid statuses without replacing an existing signal', () => {
    const signal = createSignalSink();
    signal.set({ status: 'continuing', signalledAt: 'fixture' });
    expect(
      handleClientLocalTool('signal_status', { status: 'invalid' }, new ContextLedger(), signal)
        ?.isError
    ).toBe(true);
    expect(signal.get()?.status).toBe('continuing');
  });

  it('two running parents and a clone can finish independently; clearing one does not clear another', async () => {
    const first = session();
    const second = session();
    const clone = session();
    const a = first.run();
    const b = second.run();
    const c = clone.run();
    await Promise.all([first.started.promise, second.started.promise, clone.started.promise]);
    clone.reply.resolve('completed');
    expect((await c).stopReason).toBe('terminal-signal');
    expect(first.signal.get()).toBeNull();
    expect(second.signal.get()).toBeNull();
    second.reply.resolve('blocked');
    expect((await b).stopReason).toBe('terminal-signal');
    first.reply.resolve('completed');
    expect((await a).stopReason).toBe('terminal-signal');
    first.signal.clear();
    expect(first.signal.get()).toBeNull();
    expect(second.signal.get()?.status).toBe('blocked');
    expect(clone.signal.get()?.status).toBe('completed');
  });

  it('cancelling one waiting provider neither dispatches its status nor cancels its peer', async () => {
    const cancelled = session();
    const peer = session();
    const a = cancelled.run();
    const b = peer.run();
    await Promise.all([cancelled.started.promise, peer.started.promise]);
    cancelled.abort.abort();
    cancelled.reply.resolve('completed');
    peer.reply.resolve('blocked');
    expect((await a).stopReason).toBe('aborted');
    expect(cancelled.execute).not.toHaveBeenCalled();
    expect(cancelled.signal.get()).toBeNull();
    expect((await b).stopReason).toBe('terminal-signal');
    expect(peer.abort.signal.aborted).toBe(false);
    expect(peer.signal.get()?.status).toBe('blocked');
  });

  it('context inspection and eviction touch only the bound ledger', () => {
    const first = session();
    const second = session();
    first.ledger.addEntry('inbox', 'first inbox', 'inkmail');
    second.ledger.addEntry('inbox', 'second inbox', 'inkmail');
    const listing = handleClientLocalTool('list_context', {}, first.ledger);
    expect(JSON.stringify(listing)).toContain('first inbox');
    expect(JSON.stringify(listing)).not.toContain('second inbox');
    handleClientLocalTool('evict_context', { source: 'inkmail' }, first.ledger);
    expect(first.ledger.listEntries()).toHaveLength(0);
    expect(second.ledger.listEntries().map((e) => e.content)).toEqual(['second inbox']);
  });
});
