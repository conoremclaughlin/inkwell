/** All process, host-state, credential, and binary effects are replaced before import. */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('@inklabs/shared', async () => ({
  ...(await import('../../../../shared/src/errors/classify-error.js')),
  buildSessionEnv: vi.fn(() => ({ INK_CONTEXT: 'synthetic-context' })),
  resolveSpawnTarget: vi.fn((input) => input),
  writeRuntimeSessionHint: vi.fn(),
}));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn(async () => '/synthetic/codex'),
  buildSpawnPath: vi.fn(() => '/synthetic/bin'),
}));
vi.mock('./stop-process.js', () => ({
  stopProcessAndWait: vi.fn(async () => ({ exited: true })),
  isGroupId: (id: unknown) => typeof id === 'number' && Number.isInteger(id) && id > 1,
  probeGroup: vi.fn(() => 'alive'),
}));
import { spawn } from 'child_process';
import { resolveBinaryPath } from './resolve-binary.js';
import { stopProcessAndWait } from './stop-process.js';
import { buildCodexAppServerArgs, runOwnedCodexAppServer } from './codex-app-server.js';
import type { NativeSteeringBinding } from './native-steering-binding.js';
import type { SessionSteeringRequest, SessionSteeringReceipt } from '@inklabs/shared/runtime';

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  const sent: Array<Record<string, any>> = [];
  const records: Array<Record<string, unknown>> = [];
  const release = vi.fn();
  let submit: ((r: SessionSteeringRequest) => Promise<SessionSteeringReceipt>) | undefined;
  let current = true;
  const proc = Object.assign(new EventEmitter(), {
    pid: 222222,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(),
      end: vi.fn(),
    }),
    exitCode: null as number | null,
    signalCode: null,
  });
  const receive = (value: unknown) =>
    proc.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  const notify = (method: string, params: Record<string, unknown>) =>
    receive({
      method,
      params: {
        threadId: 'thread-synthetic',
        turnId: 'turn-synthetic',
        ...params,
      },
    });
  proc.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line);
    sent.push(message);
    if (message.id === undefined) return true;
    const result =
      message.method === 'thread/start' || message.method === 'thread/resume'
        ? { thread: { id: 'thread-synthetic' } }
        : message.method === 'turn/start'
          ? { turn: { id: 'turn-synthetic' } }
          : message.method === 'turn/steer'
            ? { turnId: 'turn-synthetic' }
            : {};
    queueMicrotask(() => receive({ id: message.id, result }));
    return true;
  });
  proc.stdin.end.mockImplementation(() => {
    proc.stdin.writableEnded = true;
    queueMicrotask(() => {
      proc.exitCode = 0;
      proc.emit('exit', 0);
      proc.emit('close', 0);
    });
  });
  vi.mocked(spawn).mockReturnValue(proc as never);
  const log = {
    path: '/synthetic/journal',
    append: (event: Record<string, unknown>) => {
      records.push(event);
      return records.length;
    },
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const binding: NativeSteeringBinding = {
    turnEpoch: 'synthetic-epoch',
    ownChild: () => ({
      sessionId: 'synthetic-session',
      turnEpoch: 'synthetic-epoch',
      release: vi.fn(),
    }),
    assertCurrent: () => {
      if (!current) throw new Error('Retired');
    },
    bind: (enqueue) => {
      submit = enqueue;
      return release;
    },
    openLog: vi.fn(async () => log),
  };
  const config = {
    workingDirectory: '/synthetic/work',
    mcpConfigPath: '',
    inkMcpUrl: 'http://127.0.0.1:45555/mcp',
    inkSessionId: 'synthetic-session',
    sbSlug: 'echo',
    nativeSteering: binding,
    onSpawned: vi.fn(),
  };
  const run = (extra = {}) =>
    runOwnedCodexAppServer({
      args: ['app-server', '--listen', 'stdio://'],
      message: 'Initial',
      config: { ...config, ...extra },
    });
  return {
    proc,
    run,
    config,
    log,
    sent,
    records,
    release,
    notify,
    receive,
    binding,
    submit: (request: SessionSteeringRequest) => {
      if (!submit) throw new Error('Not bound');
      return submit(request);
    },
    retire: () => {
      current = false;
    },
    complete: () =>
      notify('turn/completed', { turn: { id: 'turn-synthetic', status: 'completed' } }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('owned Codex app-server runner', () => {
  describe.each(['completed', 'notification'] as const)('failure from %s', (source) => {
    it.each([
      { category: 'quota', retryable: false, codexErrorInfo: 'usageLimitExceeded' },
      { category: 'auth', retryable: false, codexErrorInfo: 'unauthorized' },
      {
        category: 'network',
        retryable: true,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      },
    ])('preserves $category without retaining private diagnostics', async (expected) => {
      const f = fixture();
      const running = f.run();
      await tick();
      // Camel-case variants match the captured app-server v2 wire schema.
      const error = {
        codexErrorInfo: expected.codexErrorInfo,
        message: 'Synthetic private diagnostic',
        additionalDetails: 'Synthetic private detail',
      };
      if (source === 'notification') f.notify('error', { error, willRetry: false });
      f.notify('turn/completed', {
        turn: {
          id: 'turn-synthetic',
          status: 'failed',
          error: source === 'completed' ? error : null,
        },
      });
      const result = await running;
      expect(result).toMatchObject({
        success: false,
        classification: { category: expected.category, retryable: expected.retryable },
      });
      expect(JSON.stringify(result)).not.toContain('Synthetic private');
      expect(f.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    });
  });

  it.each([
    ['quota', 'Usage limit reached'],
    ['auth', 'Unauthorized'],
    ['network', 'Stream disconnected'],
  ])('classifies a message-only %s failure without retaining its text', async (category, text) => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('turn/completed', {
      turn: {
        id: 'turn-synthetic',
        status: 'failed',
        error: { message: `${text}: synthetic-private-detail`, codexErrorInfo: null },
      },
    });
    const result = await running;
    expect(result.classification?.category).toBe(category);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
  });

  it('does not carry a recovered notification failure into success', async () => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('error', {
      error: { codexErrorInfo: 'unauthorized', message: 'Synthetic private diagnostic' },
      willRetry: false,
    });
    f.complete();
    const result = await running;
    expect(result.success).toBe(true);
    expect(result.classification).toBeUndefined();
  });

  it.each(['retrying', 'foreign-turn', 'foreign-thread', 'assistant-text'] as const)(
    'does not classify %s diagnostics as the owned turn failure',
    async (source) => {
      const f = fixture();
      const running = f.run();
      await tick();
      const error = { codexErrorInfo: 'unauthorized', message: 'Unauthorized' };
      if (source === 'assistant-text')
        f.notify('item/completed', {
          item: { id: 'synthetic-item', type: 'agentMessage', text: 'Unauthorized' },
        });
      else
        f.notify('error', {
          error,
          willRetry: source === 'retrying',
          ...(source === 'foreign-turn' ? { turnId: 'another-turn' } : {}),
          ...(source === 'foreign-thread' ? { threadId: 'another-thread' } : {}),
        });
      f.notify('turn/completed', { turn: { id: 'turn-synthetic', status: 'failed' } });
      const result = await running;
      expect(result.success).toBe(false);
      expect(result.classification).toBeUndefined();
    }
  );

  it('never promotes a post-acceptance error to a pre-acceptance owner refusal', async () => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('turn/completed', {
      turn: {
        id: 'turn-synthetic',
        status: 'failed',
        error: { message: 'thread/resume: thread synthetic already has an active writer' },
      },
    });
    expect((await running).classification).toBeUndefined();
  });

  it('prefers structured HTTP auth failure to diagnostic quota words', async () => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('turn/completed', {
      turn: {
        id: 'turn-synthetic',
        status: 'failed',
        error: {
          message: 'Usage limit reached: synthetic-private-detail',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        },
      },
    });
    const result = await running;
    expect(result.classification).toMatchObject({ category: 'auth', retryable: false });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
  });

  it('does not reuse an earlier classification when the final error is explicitly unknown', async () => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('error', {
      error: { codexErrorInfo: 'usageLimitExceeded', message: 'Usage limit' },
      willRetry: false,
    });
    f.notify('turn/completed', {
      turn: {
        id: 'turn-synthetic',
        status: 'failed',
        error: { codexErrorInfo: 'other', message: 'Unrecognized synthetic failure' },
      },
    });
    expect((await running).classification).toBeUndefined();
  });

  it('retains a scoped terminal error notification when the child closes immediately', async () => {
    const f = fixture();
    const running = f.run();
    await tick();
    f.notify('error', {
      error: { codexErrorInfo: 'usageLimitExceeded', message: 'Synthetic private diagnostic' },
      willRetry: false,
    });
    f.proc.exitCode = 0;
    f.proc.emit('close', 0, null);
    expect(await running).toMatchObject({
      success: false,
      classification: { category: 'quota', retryable: false },
    });
  });

  it('binds the current turn, journals admission, waits for correlated insertion and exits its child', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    const request = { messageId: 'm', text: 'Revision' };
    expect((await f.submit(request)).status).toBe('pending');
    await tick();
    expect((await f.submit(request)).status).toBe('pending');
    const steering = f.sent.find((x) => x.method === 'turn/steer')!;
    expect(steering.params.expectedTurnId).toBe('turn-synthetic');
    expect(f.records.some((x) => x.type === 'native_steering_request')).toBe(true);
    expect(f.records.some((x) => x.status === 'inserted')).toBe(false);
    f.notify('item/completed', {
      item: { id: 'input-2', type: 'userMessage', content: steering.params.input },
    });
    await tick();
    expect((await f.submit(request)).status).toBe('inserted');
    expect(f.sent.filter((x) => x.method === 'turn/steer')).toHaveLength(1);
    f.notify('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } },
    });
    f.notify('item/completed', {
      item: { id: 'assistant-1', type: 'agentMessage', text: 'Updated' },
    });
    f.complete();
    expect(await result).toMatchObject({
      success: true,
      finalTextResponse: 'Updated',
      backendSessionId: 'thread-synthetic',
      usage: { inputTokens: 100, outputTokens: 10, cumulative: true },
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
    expect(f.proc.stdin.end).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.config.onSpawned).toHaveBeenCalledWith({ pid: 222222 });
  });

  it('settles unobserved input as unknown and never sends a second turn', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    const request = { messageId: 'm', text: 'Late revision' };
    await f.submit(request);
    await tick();
    f.complete();
    await result;
    expect((await f.submit(request)).status).toBe('unknown');
    expect(f.sent.filter((x) => x.method === 'turn/start')).toHaveLength(1);
    expect(f.sent.filter((x) => x.method === 'turn/steer')).toHaveLength(1);
  });

  it.each([1, null])(
    'does not report success if native completion is followed by unsuccessful child close %s',
    async (code) => {
      const f = fixture();
      f.proc.stdin.end.mockImplementation(() => {
        f.proc.stdin.writableEnded = true;
        queueMicrotask(() => {
          f.proc.exitCode = code;
          f.proc.emit('close', code, code === null ? 'SIGTERM' : null);
        });
      });
      const result = f.run();
      await tick();
      f.complete();
      expect(await result).toMatchObject({
        success: false,
        error: 'Codex app-server did not exit successfully',
      });
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.log.close).toHaveBeenCalledOnce();
    }
  );

  it('fails a provider initialization error without retry or exec fallback', async () => {
    const f = fixture();
    f.proc.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line);
      f.sent.push(message);
      queueMicrotask(() =>
        f.receive({
          id: message.id,
          error: { code: -32600, message: 'Private provider diagnostic' },
        })
      );
      return true;
    });
    expect(await f.run()).toMatchObject({
      success: false,
      error: 'Codex app-server initialization failed',
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(1);
  });

  it('checks ownership again after binary resolution and starts nothing if it was lost', async () => {
    const f = fixture();
    vi.mocked(resolveBinaryPath).mockImplementationOnce(async () => {
      f.retire();
      return '/synthetic/codex';
    });
    await expect(f.run()).rejects.toThrow('Retired');
    expect(spawn).not.toHaveBeenCalled();
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('cancels an active child and terminalizes pending steering', async () => {
    const f = fixture(),
      abort = new AbortController();
    const result = f.run({ signal: abort.signal });
    await tick();
    const request = { messageId: 'm', text: 'Pending' };
    await f.submit(request);
    abort.abort();
    expect(await result).toMatchObject({ success: false, error: 'Codex turn cancelled' });
    expect((await f.submit(request)).status).toBe('unknown');
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('preserves an unconfirmed stop instead of treating a sent signal as an exit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.proc.stdin.end.mockImplementation(() => {
      f.proc.stdin.writableEnded = true;
    });
    vi.mocked(stopProcessAndWait).mockResolvedValueOnce({ exited: false });
    const result = f.run();
    await tick();
    f.complete();
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toMatchObject({
      success: false,
      stopUnconfirmed: { leaderExited: false },
    });
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('uses explicit endpoint, no token argv, quoted paths, and the admitted sandbox profile', () => {
    const f = fixture();
    const args = buildCodexAppServerArgs({
      config: f.config,
      promptPath: '/synthetic/space name/identity.md',
      writableRoots: ['/synthetic/work'],
    });
    expect(args.slice(-3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('model_instructions_file="/synthetic/space name/identity.md"');
    expect(args).toContain('mcp_servers.inkwell.url="http://127.0.0.1:45555/mcp"');
    expect(args).toContain('mcp_servers.inkwell.bearer_token_env_var="INK_ACCESS_TOKEN"');
    expect(() =>
      buildCodexAppServerArgs({
        config: { ...f.config, inkMcpUrl: undefined },
        promptPath: '/synthetic/file',
        writableRoots: [],
      })
    ).toThrow('explicit MCP');
  });

  it('stops the owned child if launch tracking throws, before starting any native turn', async () => {
    const f = fixture();
    const result = await f.run({
      onSpawned: () => {
        throw new Error('Synthetic tracking failure');
      },
    });
    expect(result).toMatchObject({ success: false, error: 'Codex launch tracking failed' });
    expect(f.proc.stdin.end).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(0);
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('retains a surviving-process fence even if journal close fails too', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.proc.stdin.end.mockImplementation(() => {
      f.proc.stdin.writableEnded = true;
    });
    vi.mocked(stopProcessAndWait).mockResolvedValueOnce({ exited: false });
    f.log.close.mockRejectedValueOnce(new Error('Synthetic close failure'));
    const result = f.run();
    await tick();
    f.complete();
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toMatchObject({
      success: false,
      stopUnconfirmed: { leaderExited: false },
      error: 'Native steering journal close could not be confirmed',
    });
  });

  it('requires group-empty evidence even when the leader closed normally', async () => {
    const f = fixture();
    vi.mocked(stopProcessAndWait).mockResolvedValueOnce({ exited: true, group: 'alive' });
    const result = f.run({ killProcessGroup: true });
    await tick();
    f.complete();
    expect(await result).toMatchObject({
      success: false,
      stopUnconfirmed: { leaderExited: true, group: 'alive', pgid: 222222 },
    });
    expect(stopProcessAndWait).toHaveBeenCalledWith(f.proc, { group: true });
  });

  it('settles conservatively when input close, group stop, or release throws', async () => {
    const f = fixture();
    f.proc.stdin.end.mockImplementation(() => {
      throw new Error('Synthetic close failure');
    });
    vi.mocked(stopProcessAndWait).mockRejectedValueOnce(new Error('Synthetic stop failure'));
    f.release.mockImplementation(() => {
      throw new Error('Synthetic release failure');
    });
    vi.useFakeTimers();
    const result = f.run({ killProcessGroup: true });
    await tick();
    f.complete();
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toMatchObject({
      success: false,
      stopUnconfirmed: { leaderExited: false, group: 'unknown' },
    });
  });

  it('reports unknown when terminal arrives before the observation write barrier finishes', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    const request = { messageId: 'm', text: 'At the last boundary' };
    await f.submit(request);
    await tick();
    const steering = f.sent.find((x) => x.method === 'turn/steer')!;
    // Both notifications arrive synchronously, as in one stdout chunk.
    f.notify('item/completed', {
      item: { id: 'input-2', type: 'userMessage', content: steering.params.input },
    });
    f.complete();
    await result;
    expect((await f.submit(request)).status).toBe('unknown');
  });

  it.each(['stdout', 'stderr'])('settles on a readable %s stream error', async (name) => {
    const f = fixture();
    const result = f.run();
    await tick();
    f.proc[name as 'stdout' | 'stderr'].emit('error', new Error('Synthetic stream failure'));
    expect(await result).toMatchObject({ success: false });
    expect(f.proc.stdin.end).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('retains a stream failure during cleanup after native completion', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    f.complete();
    f.proc.stdout.emit('error', new Error('Synthetic late stream failure'));
    expect(await result).toMatchObject({
      success: false,
      error: 'Codex app-server output failed',
    });
  });

  it('decodes split UTF-8 frames without losing native output or terminal identity', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    const text = 'Synthetic output: café 🌙';
    const frames = Buffer.from(
      [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-synthetic',
            turnId: 'turn-synthetic',
            item: { id: 'assistant-synthetic', type: 'agentMessage', text },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread-synthetic',
            turn: { id: 'turn-synthetic', status: 'completed' },
          },
        },
      ]
        .map((frame) => JSON.stringify(frame) + '\n')
        .join('')
    );
    // One byte per chunk deliberately splits every multibyte character.
    for (const byte of frames) f.proc.stdout.emit('data', Buffer.from([byte]));
    expect(await result).toMatchObject({ success: true, finalTextResponse: text });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it.each(['malformed', 'oversized-frame', 'oversized-remainder'] as const)(
    'closes on a %s stream and settles pending steering without a resend',
    async (shape) => {
      const f = fixture();
      const result = f.run();
      await tick();
      const request = { messageId: 'pending-synthetic', text: 'One revision' };
      await f.submit(request);
      await tick();
      const frame =
        shape === 'malformed'
          ? '{invalid}\n'
          : 'x'.repeat(4 * 1024 * 1024 + 1) + (shape === 'oversized-frame' ? '\n' : '');
      f.proc.stdout.emit('data', Buffer.from(frame));
      expect(await result).toMatchObject({
        success: false,
        error:
          shape === 'malformed'
            ? 'Invalid Codex app-server stream'
            : 'Codex frame exceeded its bound',
      });
      expect((await f.submit(request)).status).toBe('unknown');
      expect(f.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
      expect(f.sent.filter((message) => message.method === 'turn/steer')).toHaveLength(1);
      expect(f.proc.stdin.end).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.log.close).toHaveBeenCalledOnce();
    }
  );

  it('closes a stalled handshake without binding a mailbox or starting a turn', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.proc.stdin.write.mockImplementation((line: string) => {
      f.sent.push(JSON.parse(line));
      return true;
    });
    const result = f.run();
    await tick();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await result).toMatchObject({
      success: false,
      error: 'Codex app-server initialization failed',
    });
    expect(f.sent.map((message) => message.method)).toEqual(['initialize']);
    expect(() => f.submit({ messageId: 'late', text: 'No native turn' })).toThrow('Not bound');
    expect(f.release).not.toHaveBeenCalled();
    expect(f.proc.stdin.end).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('enforces a configured ceiling and settles unobserved steering as unknown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = runOwnedCodexAppServer({
      args: ['app-server', '--listen', 'stdio://'],
      message: 'Initial',
      config: f.config,
      ceilingMs: 50,
    });
    await tick();
    const request = { messageId: 'pending-synthetic', text: 'One revision' };
    await f.submit(request);
    await vi.advanceTimersByTimeAsync(51);
    expect(await result).toMatchObject({
      success: false,
      error: 'Codex timeout: configured ceiling exceeded',
    });
    expect((await f.submit(request)).status).toBe('unknown');
    expect(f.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('does not mistake a clean child exit for native turn completion', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    f.proc.exitCode = 0;
    f.proc.emit('close', 0, null);
    expect(await result).toMatchObject({
      success: false,
      error: 'Codex exited before its native turn completed',
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });

  it('accepts a complete final frame without a newline on clean child close', async () => {
    const f = fixture();
    const result = f.run();
    await tick();
    f.proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-synthetic',
            turn: { id: 'turn-synthetic', status: 'completed' },
          },
        })
      )
    );
    f.proc.exitCode = 0;
    f.proc.emit('close', 0, null);
    expect(await result).toMatchObject({ success: true });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });
});
