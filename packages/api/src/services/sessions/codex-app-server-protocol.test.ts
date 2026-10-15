import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerProtocol } from './codex-app-server-protocol.js';

// Pure protocol fixtures: no subprocess, account, network, filesystem or DB.
function fixture() {
  const sent: Array<Record<string, any>> = [];
  const inserted = vi.fn(),
    terminal = vi.fn(),
    event = vi.fn();
  let current = true;
  const protocol = createCodexAppServerProtocol({
    write: (line) => {
      sent.push(JSON.parse(line));
    },
    assertCurrent: () => {
      if (!current) throw new Error('Retired');
    },
    inserted,
    terminal,
    event,
    requestTimeoutMs: 100,
  });
  const reply = (result: Record<string, unknown>) =>
    protocol.receive({ id: sent.at(-1)!.id, result });
  const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  async function start(backendSessionId?: string) {
    const running = protocol.start({
      text: 'Initial prompt',
      cwd: '/synthetic/work',
      backendSessionId,
    });
    reply({});
    await tick();
    expect(sent.at(-1)?.method).toBe(backendSessionId ? 'thread/resume' : 'thread/start');
    reply({ thread: { id: backendSessionId ?? 'thread-synthetic' } });
    await tick();
    expect(sent.at(-1)?.method).toBe('turn/start');
    reply({ turn: { id: 'turn-synthetic' } });
    return running;
  }
  const notify = (method: string, params: Record<string, unknown> = {}) =>
    protocol.receive({
      method,
      params: { threadId: 'thread-synthetic', turnId: 'turn-synthetic', ...params },
    });
  return {
    protocol,
    sent,
    inserted,
    terminal,
    event,
    reply,
    start,
    notify,
    retire: () => {
      current = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('owned Codex app-server protocol', () => {
  it('initializes once, owns one turn and fences steering with its exact native turn ID', async () => {
    const f = fixture();
    await f.start();
    expect(f.sent.map((x) => x.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    const steering = f.protocol.steer({ messageId: 'message-1', text: 'New direction' });
    expect(f.sent.at(-1)?.params.expectedTurnId).toBe('turn-synthetic');
    f.reply({ turnId: 'turn-synthetic' });
    expect(await steering).toEqual({ status: 'accepted' });
    expect(f.inserted).not.toHaveBeenCalled();
    await expect(
      f.protocol.start({ text: 'Forbidden second turn', cwd: '/synthetic/work' })
    ).rejects.toThrow('exactly one');
    f.protocol.close();
  });

  it('matches only its exact transport-tagged user input and can observe before acknowledgment', async () => {
    const f = fixture();
    await f.start();
    const steering = f.protocol.steer({ messageId: 'message-1', text: 'Same text' });
    const wire = f.sent.at(-1)!.params.input[0];
    f.notify('item/completed', {
      item: { type: 'userMessage', content: [{ type: 'text', text: 'Same text' }] },
    });
    f.notify('item/completed', {
      turnId: 'foreign-turn',
      item: { type: 'userMessage', content: [wire] },
    });
    expect(f.inserted).not.toHaveBeenCalled();
    f.notify('item/completed', { item: { type: 'userMessage', content: [wire] } });
    expect(f.inserted).toHaveBeenCalledExactlyOnceWith('message-1');
    f.notify('item/completed', { item: { type: 'userMessage', content: [wire] } });
    expect(f.inserted).toHaveBeenCalledTimes(1);
    f.reply({ turnId: 'turn-synthetic' });
    await steering;
    f.protocol.close();
  });

  it('refuses outside a started turn and never retries an uncertain send', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect((await f.protocol.steer({ messageId: 'm', text: 'No turn' })).status).toBe('refused');
    await f.start();
    const steering = f.protocol.steer({ messageId: 'm', text: 'One attempt' });
    await vi.advanceTimersByTimeAsync(101);
    expect((await steering).status).toBe('unknown');
    expect(f.sent.filter((x) => x.method === 'turn/steer')).toHaveLength(1);
    expect(f.sent.filter((x) => x.method === 'turn/start')).toHaveLength(1);
    f.protocol.close();
  });

  it('closes synchronously on completion, rejects in-flight RPCs, and ignores late echoes', async () => {
    const f = fixture();
    await f.start();
    const steering = f.protocol.steer({ messageId: 'm', text: 'Maybe' });
    const wire = f.sent.at(-1)!.params.input[0];
    f.notify('turn/completed', { turn: { id: 'turn-synthetic', status: 'completed' } });
    f.notify('item/completed', { item: { type: 'userMessage', content: [wire] } });
    expect((await steering).status).toBe('unknown');
    expect((await f.protocol.steer({ messageId: 'other', text: 'Late' })).status).toBe('refused');
    expect(f.terminal).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.inserted).not.toHaveBeenCalled();
  });

  it('accepts turn/started on either side of the turn/start response but never another turn', async () => {
    const f = fixture();
    await f.start();
    f.notify('turn/started', { turn: { id: 'turn-synthetic' } });
    expect(f.terminal).not.toHaveBeenCalled();
    f.notify('turn/started', { turn: { id: 'another-turn' } });
    expect(f.terminal).toHaveBeenCalledWith('Codex app-server attempted an unexpected turn');
  });

  it('fails closed on owner retirement, provider error or mismatched response', async () => {
    const f = fixture();
    await f.start();
    const steering = f.protocol.steer({ messageId: 'm', text: 'Update' });
    f.reply({ turnId: 'different-turn' });
    expect((await steering).status).toBe('unknown');
    f.retire();
    expect((await f.protocol.steer({ messageId: 'n', text: 'Later' })).status).toBe('refused');
    f.protocol.close();
  });

  it('never grants interactive server requests or forwards their arguments', async () => {
    const f = fixture();
    await f.start();
    f.protocol.receive({
      id: 'request-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'synthetic' },
    });
    expect(f.sent.at(-1)).toEqual({
      id: 'request-1',
      error: { code: -32601, message: 'Interactive requests are unavailable in this host' },
    });
    f.protocol.close();
  });

  it('adopts the acknowledged turn synchronously before the next frame in the same chunk', async () => {
    const f = fixture();
    const running = f.protocol.start({ text: 'Initial', cwd: '/synthetic/work' });
    f.reply({});
    await Promise.resolve();
    await Promise.resolve();
    f.reply({ thread: { id: 'thread-synthetic' } });
    await Promise.resolve();
    await Promise.resolve();
    f.reply({ turn: { id: 'turn-synthetic' } });
    f.notify('item/completed', { item: { type: 'agentMessage', text: 'First event' } });
    expect(f.event).toHaveBeenCalledWith(
      'item/completed',
      expect.objectContaining({ item: { type: 'agentMessage', text: 'First event' } })
    );
    await running;
    f.protocol.close();
  });

  it('cannot report success for a different turn before start acknowledgment validation', async () => {
    const f = fixture();
    const running = f.protocol.start({ text: 'Initial', cwd: '/synthetic/work' });
    f.reply({});
    await Promise.resolve();
    await Promise.resolve();
    f.reply({ thread: { id: 'thread-synthetic' } });
    await Promise.resolve();
    await Promise.resolve();
    f.notify('turn/started', { turn: { id: 'turn-wrong' } });
    f.notify('turn/completed', {
      turnId: 'turn-wrong',
      turn: { id: 'turn-wrong', status: 'completed' },
    });
    expect(f.terminal).not.toHaveBeenCalled();
    f.reply({ turn: { id: 'turn-synthetic' } });
    await expect(running).rejects.toThrow('different turn');
    expect(f.terminal).toHaveBeenCalledExactlyOnceWith(
      'Codex app-server response identity was invalid'
    );
  });

  it('rejects a mismatched started event immediately after a valid acknowledgment', async () => {
    const f = fixture();
    const running = f.protocol.start({ text: 'Initial', cwd: '/synthetic/work' });
    f.reply({});
    await Promise.resolve();
    await Promise.resolve();
    f.reply({ thread: { id: 'thread-synthetic' } });
    await Promise.resolve();
    await Promise.resolve();
    f.reply({ turn: { id: 'turn-synthetic' } });
    f.notify('turn/started', { turn: { id: 'turn-wrong' } });
    f.notify('turn/completed', {
      turnId: 'turn-wrong',
      turn: { id: 'turn-wrong', status: 'completed' },
    });
    await expect(running).rejects.toThrow('closed');
    expect(f.terminal).toHaveBeenCalledExactlyOnceWith(
      'Codex app-server attempted an unexpected turn'
    );
  });
});
