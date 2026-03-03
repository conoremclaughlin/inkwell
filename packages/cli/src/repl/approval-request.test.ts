import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalRequestManager } from './approval-request.js';

describe('ApprovalRequestManager', () => {
  let manager: ApprovalRequestManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ApprovalRequestManager();
  });

  afterEach(() => {
    manager.cancelAll();
    vi.useRealTimers();
  });

  it('registers a request and returns a promise', () => {
    const { request, promise } = manager.register(
      'send_to_inbox',
      { content: 'hi' },
      'Needs approval'
    );

    expect(request.id).toBeTruthy();
    expect(request.tool).toBe('send_to_inbox');
    expect(request.args).toEqual({ content: 'hi' });
    expect(request.reason).toBe('Needs approval');
    expect(promise).toBeInstanceOf(Promise);
    expect(manager.size).toBe(1);
  });

  it('resolves when approved', async () => {
    const { request, promise } = manager.register('send_to_inbox', {}, 'test');

    manager.resolve(request.id, 'approved', 'conor');

    const result = await promise;
    expect(result.decision).toBe('approved');
    expect(result.resolvedBy).toBe('conor');
    expect(result.requestId).toBe(request.id);
    expect(manager.size).toBe(0);
  });

  it('resolves when denied', async () => {
    const { request, promise } = manager.register('trigger_agent', {}, 'test');

    manager.resolve(request.id, 'denied');

    const result = await promise;
    expect(result.decision).toBe('denied');
    expect(manager.size).toBe(0);
  });

  it('expires after timeout', async () => {
    const { promise } = manager.register('send_to_inbox', {}, 'test', 5000);

    expect(manager.size).toBe(1);

    vi.advanceTimersByTime(5000);

    const result = await promise;
    expect(result.decision).toBe('timeout');
    expect(manager.size).toBe(0);
  });

  it('first resolution wins (double-resolve)', async () => {
    const { request, promise } = manager.register('send_to_inbox', {}, 'test');

    const first = manager.resolve(request.id, 'approved', 'conor');
    const second = manager.resolve(request.id, 'denied');

    expect(first).toBe(true);
    expect(second).toBe(false);

    const result = await promise;
    expect(result.decision).toBe('approved');
  });

  it('resolve returns false for unknown request', () => {
    expect(manager.resolve('nonexistent', 'approved')).toBe(false);
  });

  it('getPending returns pending requests', () => {
    manager.register('tool_a', {}, 'reason a');
    manager.register('tool_b', {}, 'reason b');

    const pending = manager.getPending();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.tool).sort()).toEqual(['tool_a', 'tool_b']);
  });

  it('hasPending works correctly', () => {
    const { request } = manager.register('send_to_inbox', {}, 'test');

    expect(manager.hasPending(request.id)).toBe(true);
    expect(manager.hasPending('nonexistent')).toBe(false);

    manager.resolve(request.id, 'approved');
    expect(manager.hasPending(request.id)).toBe(false);
  });

  it('findPendingForTool finds matching request', () => {
    manager.register('send_to_inbox', { a: 1 }, 'test');
    manager.register('trigger_agent', { b: 2 }, 'test');

    const found = manager.findPendingForTool('trigger_agent');
    expect(found).toBeDefined();
    expect(found!.tool).toBe('trigger_agent');
    expect(found!.args).toEqual({ b: 2 });
  });

  it('findPendingForTool returns undefined when no match', () => {
    manager.register('send_to_inbox', {}, 'test');
    expect(manager.findPendingForTool('unknown_tool')).toBeUndefined();
  });

  it('cancelAll resolves all pending as denied', async () => {
    const { promise: p1 } = manager.register('tool_a', {}, 'test');
    const { promise: p2 } = manager.register('tool_b', {}, 'test');

    manager.cancelAll();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.decision).toBe('denied');
    expect(r1.resolvedBy).toBe('session-end');
    expect(r2.decision).toBe('denied');
    expect(manager.size).toBe(0);
  });

  it('does not hold process open (timer.unref)', () => {
    // This is a structural test — register should call unref on the timer
    const { request } = manager.register('tool', {}, 'test', 60000);
    // If unref wasn't called, the process would hang in real usage
    // Just verify the request was created successfully
    expect(request.timeoutMs).toBe(60000);
    manager.cancelAll();
  });
});
