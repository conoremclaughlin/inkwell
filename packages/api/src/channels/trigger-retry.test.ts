import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyError } from '@inklabs/shared';
import type { AgentTriggerPayload } from './agent-gateway';
import {
  TriggerRetryScheduler,
  TRIGGER_MAX_ATTEMPTS,
  TRIGGER_RETRY_DELAYS_MS,
  getTriggerAttempt,
  getTriggerRetryKey,
  isRoutingRefusal,
} from './trigger-retry';

const TRANSIENT = { category: 'network' as const, summary: 'fetch failed', retryable: true };
const PERMANENT = { category: 'auth' as const, summary: 'HTTP 401', retryable: false };

function makePayload(overrides: Partial<AgentTriggerPayload> = {}): AgentTriggerPayload {
  return {
    fromSlug: 'wren',
    toSlug: 'lumen',
    triggerType: 'message',
    inboxMessageId: 'inbox-msg-1',
    threadKey: 'pr:42',
    ...overrides,
  };
}

describe('getTriggerAttempt', () => {
  it('defaults to 1 when metadata is absent', () => {
    expect(getTriggerAttempt(makePayload())).toBe(1);
  });

  it('reads triggerAttempt from metadata', () => {
    expect(getTriggerAttempt(makePayload({ metadata: { triggerAttempt: 2 } }))).toBe(2);
  });

  it('ignores invalid values', () => {
    expect(getTriggerAttempt(makePayload({ metadata: { triggerAttempt: 'x' } }))).toBe(1);
    expect(getTriggerAttempt(makePayload({ metadata: { triggerAttempt: 0 } }))).toBe(1);
    expect(getTriggerAttempt(makePayload({ metadata: { triggerAttempt: 1.5 } }))).toBe(1);
  });
});

describe('getTriggerRetryKey', () => {
  it('includes toSlug with source id for fan-out safety', () => {
    expect(getTriggerRetryKey(makePayload())).toBe('inbox-msg-1::lumen');
    expect(
      getTriggerRetryKey(makePayload({ inboxMessageId: undefined, threadMessageId: 'tm-1' }))
    ).toBe('tm-1::lumen');
    expect(getTriggerRetryKey(makePayload({ inboxMessageId: undefined, threadId: 'th-1' }))).toBe(
      'th-1::lumen'
    );
  });

  it('falls back to threadKey when no message ids present', () => {
    expect(getTriggerRetryKey(makePayload({ inboxMessageId: undefined }))).toBe('pr:42::lumen');
    expect(
      getTriggerRetryKey(makePayload({ inboxMessageId: undefined, threadKey: undefined }))
    ).toBe('no-thread::lumen');
  });

  it('produces distinct keys for fan-out to different recipients', () => {
    const msg = { inboxMessageId: undefined as string | undefined, threadMessageId: 'tm-shared' };
    const keyLumen = getTriggerRetryKey(makePayload({ ...msg, toSlug: 'lumen' }));
    const keyAster = getTriggerRetryKey(makePayload({ ...msg, toSlug: 'aster' }));
    expect(keyLumen).toBe('tm-shared::lumen');
    expect(keyAster).toBe('tm-shared::aster');
    expect(keyLumen).not.toBe(keyAster);
  });
});

describe('TriggerRetryScheduler', () => {
  let redispatch: ReturnType<typeof vi.fn>;
  let scheduler: TriggerRetryScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    redispatch = vi.fn();
    scheduler = new TriggerRetryScheduler(redispatch);
  });

  afterEach(() => {
    scheduler.clear();
    vi.useRealTimers();
  });

  it('schedules attempt 2 after ~2min for a transient failure', () => {
    const result = scheduler.scheduleRetry(makePayload(), TRANSIENT);
    expect(result).toEqual({ scheduled: true, attempt: 2, delayMs: TRIGGER_RETRY_DELAYS_MS[0] });
    expect(scheduler.pendingCount).toBe(1);

    vi.advanceTimersByTime(TRIGGER_RETRY_DELAYS_MS[0] - 1);
    expect(redispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(redispatch).toHaveBeenCalledTimes(1);
    const retried = redispatch.mock.calls[0][0] as AgentTriggerPayload;
    expect(retried.metadata?.triggerAttempt).toBe(2);
    expect(retried.inboxMessageId).toBe('inbox-msg-1');
    expect(scheduler.pendingCount).toBe(0);
  });

  it('schedules attempt 3 after ~10min when attempt 2 fails', () => {
    const result = scheduler.scheduleRetry(
      makePayload({ metadata: { triggerAttempt: 2 } }),
      TRANSIENT
    );
    expect(result).toEqual({ scheduled: true, attempt: 3, delayMs: TRIGGER_RETRY_DELAYS_MS[1] });

    vi.advanceTimersByTime(TRIGGER_RETRY_DELAYS_MS[1]);
    expect(redispatch).toHaveBeenCalledTimes(1);
    const retried = redispatch.mock.calls[0][0] as AgentTriggerPayload;
    expect(retried.metadata?.triggerAttempt).toBe(3);
  });

  it('caps at TRIGGER_MAX_ATTEMPTS total attempts', () => {
    const result = scheduler.scheduleRetry(
      makePayload({ metadata: { triggerAttempt: TRIGGER_MAX_ATTEMPTS } }),
      TRANSIENT
    );
    expect(result).toEqual({ scheduled: false, reason: 'exhausted' });
    expect(scheduler.pendingCount).toBe(0);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('does not retry non-transient failures', () => {
    const result = scheduler.scheduleRetry(makePayload(), PERMANENT);
    expect(result).toEqual({ scheduled: false, reason: 'not_transient' });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('deduplicates retries for the same trigger identity', () => {
    expect(scheduler.scheduleRetry(makePayload(), TRANSIENT).scheduled).toBe(true);
    expect(scheduler.scheduleRetry(makePayload(), TRANSIENT)).toEqual({
      scheduled: false,
      reason: 'already_pending',
    });
    expect(scheduler.pendingCount).toBe(1);
  });

  it('does not fire again after a successful retry (no new failure, no new timer)', () => {
    scheduler.scheduleRetry(makePayload(), TRANSIENT);
    vi.advanceTimersByTime(TRIGGER_RETRY_DELAYS_MS[0]);
    expect(redispatch).toHaveBeenCalledTimes(1);

    // Retry succeeded → nothing schedules another attempt. Advancing time
    // arbitrarily far must not re-dispatch.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('cancel() clears a pending retry', () => {
    scheduler.scheduleRetry(makePayload(), TRANSIENT);
    expect(scheduler.cancel('inbox-msg-1::lumen')).toBe(true);
    expect(scheduler.cancel('inbox-msg-1::lumen')).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('schedules independent retries for fan-out to different recipients', () => {
    const base = { inboxMessageId: undefined as string | undefined, threadMessageId: 'tm-shared' };
    const toLumen = makePayload({ ...base, toSlug: 'lumen' });
    const toAster = makePayload({ ...base, toSlug: 'aster' });

    expect(scheduler.scheduleRetry(toLumen, TRANSIENT).scheduled).toBe(true);
    expect(scheduler.scheduleRetry(toAster, TRANSIENT).scheduled).toBe(true);
    expect(scheduler.pendingCount).toBe(2);

    vi.advanceTimersByTime(TRIGGER_RETRY_DELAYS_MS[0]);
    expect(redispatch).toHaveBeenCalledTimes(2);
    expect(redispatch.mock.calls[0][0].toSlug).toBe('lumen');
    expect(redispatch.mock.calls[1][0].toSlug).toBe('aster');
  });

  it('respects custom maxAttempts and delays', () => {
    const custom = new TriggerRetryScheduler(redispatch, { maxAttempts: 2, delaysMs: [500] });
    const first = custom.scheduleRetry(makePayload(), TRANSIENT);
    expect(first).toEqual({ scheduled: true, attempt: 2, delayMs: 500 });
    vi.advanceTimersByTime(500);
    expect(redispatch).toHaveBeenCalledTimes(1);

    const second = custom.scheduleRetry(
      makePayload({ metadata: { triggerAttempt: 2 } }),
      TRANSIENT
    );
    expect(second).toEqual({ scheduled: false, reason: 'exhausted' });
    custom.clear();
  });

  describe('end-to-end with classifyError (observed failure signatures)', () => {
    const signatures = [
      'failed to refresh available models: timeout waiting for child process',
      'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'Codex exited with code 1: Reading additional input from stdin; press Ctrl-D to submit it.\nfailed to refresh available models: timeout waiting for child process\n\nexitCode=1 signal=none',
      'TypeError: fetch failed',
      'ConnectTimeoutError: Connect Timeout Error (code: UND_ERR_CONNECT_TIMEOUT)',
    ];

    for (const errorText of signatures) {
      it(`retries: ${errorText.split('\n')[0].slice(0, 60)}`, () => {
        const classification = classifyError({ errorText });
        expect(classification.retryable).toBe(true);
        const result = scheduler.scheduleRetry(
          makePayload({ inboxMessageId: `msg-${signatures.indexOf(errorText)}` }),
          classification
        );
        expect(result.scheduled).toBe(true);
      });
    }

    it('does not retry an unknown, non-retryable error', () => {
      const classification = classifyError({ errorText: 'some totally novel failure mode' });
      expect(classification.retryable).toBe(false);
      const result = scheduler.scheduleRetry(makePayload(), classification);
      expect(result).toEqual({ scheduled: false, reason: 'not_transient' });
    });
  });
});

describe('isRoutingRefusal', () => {
  // Duck-typed, so the shapes that are NOT a refusal matter as much as the one
  // that is: a stray `code` on an unrelated error, or anything not an object,
  // must not silence a retry that should happen.
  it('recognises a refusal by its code, whatever the class', () => {
    class Refused extends Error {
      readonly code = 'ROUTING_REFUSED';
    }
    expect(isRoutingRefusal(new Refused('held'))).toBe(true);
    expect(isRoutingRefusal(Object.assign(new Error('held'), { code: 'ROUTING_REFUSED' }))).toBe(
      true
    );
  });

  it('does not mistake another coded error for a refusal', () => {
    expect(isRoutingRefusal(Object.assign(new Error('nope'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isRoutingRefusal(new Error('plain'))).toBe(false);
  });

  it('survives the values an error variable can actually hold', () => {
    for (const value of [null, undefined, 'ROUTING_REFUSED', 42]) {
      expect(isRoutingRefusal(value)).toBe(false);
    }
  });
});

describe('scheduleRetry with a refusal', () => {
  it('refuses before the classification, not after it', () => {
    // The whole point: the classification here says retryable, because the
    // refusal's prose names thread "pr:503". Reading the category first gives a
    // confident wrong answer, so the type has to be consulted first.
    const scheduler = new TriggerRetryScheduler(vi.fn());
    const refusal = Object.assign(new Error('Refusing to route "pr:503" for agent "wren"'), {
      code: 'ROUTING_REFUSED',
    });
    const classification = classifyError({ errorText: refusal.message });
    expect(classification.retryable).toBe(true);

    const result = scheduler.scheduleRetry(makePayload(), classification, refusal);
    expect(result).toEqual({ scheduled: false, reason: 'routing_refused' });
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('cancelFor', () => {
  it('cancels a timer held for the same message but a different payload object', () => {
    const redispatch = vi.fn();
    const scheduler = new TriggerRetryScheduler(redispatch);
    const payload = makePayload({ inboxMessageId: 'inbox-1' });

    expect(scheduler.scheduleRetry(payload, TRANSIENT).scheduled).toBe(true);
    expect(scheduler.pendingCount).toBe(1);

    // A separate delivery of the same message: same identity, different object,
    // and no shared metadata to carry a completion marker across.
    expect(scheduler.cancelFor(makePayload({ inboxMessageId: 'inbox-1' }))).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("leaves a different message's retry alone", () => {
    const scheduler = new TriggerRetryScheduler(vi.fn());
    scheduler.scheduleRetry(makePayload({ inboxMessageId: 'inbox-1' }), TRANSIENT);

    expect(scheduler.cancelFor(makePayload({ inboxMessageId: 'inbox-2' }))).toBe(false);
    expect(scheduler.pendingCount).toBe(1);
  });
});
