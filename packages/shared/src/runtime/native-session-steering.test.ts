import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { hydrateLedgerFromEvents } from './session-history.js';
import { SessionLog } from './session-log.js';
import {
  createNativeSessionSteering,
  type NativeSteeringDispatchResult,
} from './native-session-steering.js';
import {
  MAX_STEERING_GENERATION_BYTES,
  MAX_STEERING_RECEIPTS,
  MAX_STEERING_TEXT_BYTES,
  type SessionSteeringReceipt,
} from './session-steering.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const request = (messageId = 'message-one', text = 'Use the updated fixture.') => ({
  messageId,
  text,
});
function fixture(write?: (event: Record<string, unknown>) => Promise<void>) {
  const events: Record<string, unknown>[] = [];
  const receipts: SessionSteeringReceipt[] = [];
  const rpc = deferred<NativeSteeringDispatchResult>();
  const dispatch = vi.fn(() => rpc.promise);
  let current = true;
  const log = new SessionLog({
    path: 'memory:native-steering',
    sink: {
      write: async (line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        await write?.(event);
        events.push(event);
      },
    },
  });
  const steering = createNativeSessionSteering({
    turnEpoch: 'native-generation-one',
    log,
    dispatch,
    assertCurrent: () => {
      if (!current) throw new Error('Synthetic retired owner');
    },
    receipt: (receipt) => receipts.push(receipt),
  });
  return {
    steering,
    log,
    events,
    receipts,
    dispatch,
    rpc,
    retire: () => {
      current = false;
    },
  };
}

describe('native generation steering, with only in-memory log and fake dispatch', () => {
  it('flushes intent and pending receipt before dispatch, but never waits for RPC admission', async () => {
    const writing = deferred(),
      gate = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'native_steering_request') {
        writing.resolve();
        await gate.promise;
      }
    });
    const admission = f.steering.submit(request());
    await writing.promise;
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.receipts).toEqual([]);
    gate.resolve();
    expect(await admission).toEqual({ messageId: request().messageId, status: 'pending' });
    expect(f.events.map((event) => event.type)).toEqual([
      'native_steering_request',
      'native_steering_receipt',
    ]);
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(request());
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    expect(await f.steering.submit(request())).toMatchObject({
      status: 'pending',
      reason: 'provider_accepted',
    });
    expect(f.events.some((event) => event.type === 'native_steering_observation')).toBe(false);
  });

  it('deduplicates simultaneous submissions, rejects substitutions and freezes caller text', async () => {
    const gate = deferred();
    const f = fixture(async () => gate.promise);
    const input = request();
    const first = f.steering.submit(input);
    const second = f.steering.submit(request());
    input.text = 'Mutation after submission';
    expect(await f.steering.submit(input)).toMatchObject({ reason: 'message_id_conflict' });
    gate.resolve();
    expect(await first).toEqual(await second);
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(request());
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    await f.steering.observeInserted(request().messageId);
    expect(await f.steering.submit(request())).toMatchObject({ status: 'inserted' });
    expect(f.events.filter((event) => event.type === 'native_steering_request')).toHaveLength(1);
  });

  it('uses the shared strict text-only parser and generation validation', async () => {
    const f = fixture();
    for (const value of [
      null,
      [],
      {},
      request('', 'x'),
      request('bad\n', 'x'),
      request('x', '  '),
      request('x', 'nul\0text'),
      request('x', '😀'.repeat(MAX_STEERING_TEXT_BYTES / 4 + 1)),
      { ...request(), role: 'system' },
      { ...request(), grants: ['all'] },
      { ...request(), media: [] },
      { ...request(), sender: 'owner' },
    ]) {
      expect(await f.steering.submit(value as ReturnType<typeof request>)).toMatchObject({
        status: 'refused',
        reason: 'invalid_steering',
      });
    }
    expect(f.events).toEqual([]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(() =>
      createNativeSessionSteering({
        turnEpoch: 'bad\n',
        log: f.log,
        assertCurrent() {},
        dispatch: f.dispatch,
      })
    ).toThrow('generation');
  });

  it.each(['native_steering_request', 'native_steering_receipt'])(
    'never dispatches after a %s write failure and never retries an unknown request',
    async (type) => {
      const f = fixture(async (event) => {
        if (event.type === type) throw new Error('Synthetic disk failure');
      });
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      expect(await f.steering.submit(request('other'))).toMatchObject({
        reason: 'owner_unavailable',
      });
      expect(() => f.steering.assertHealthy()).toThrow('uncertain');
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  );

  it('refuses observations for unknown and not-yet-dispatched requests', async () => {
    const gate = deferred(),
      writing = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'native_steering_request') {
        writing.resolve();
        await gate.promise;
      }
    });
    expect(await f.steering.observeInserted('never-submitted')).toMatchObject({
      reason: 'not_dispatched',
    });
    const admission = f.steering.submit(request());
    await writing.promise;
    expect(await f.steering.observeInserted(request().messageId)).toMatchObject({
      reason: 'not_dispatched',
    });
    gate.resolve();
    await admission;
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    expect(f.events.some((event) => event.type === 'native_steering_observation')).toBe(false);
  });

  it('persists a trustworthy early provider echo before the RPC response without downgrading it', async () => {
    const f = fixture();
    let observation!: Promise<SessionSteeringReceipt>;
    f.dispatch.mockImplementation(() => {
      observation = f.steering.observeInserted(request().messageId);
      return f.rpc.promise;
    });
    await f.steering.submit(request());
    expect(await observation).toMatchObject({ status: 'inserted', eid: 3 });
    expect(f.events.at(-2)).toMatchObject({ type: 'native_steering_observation', eid: 3 });
    expect(f.events.at(-1)).toMatchObject({
      type: 'native_steering_receipt',
      status: 'inserted',
      observationEid: 3,
    });
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    expect(await f.steering.submit(request())).toMatchObject({ status: 'inserted', eid: 3 });
    expect(await f.steering.observeInserted(request().messageId)).toMatchObject({
      reason: 'observation_not_pending',
    });
    expect(f.events.filter((event) => event.type === 'native_steering_observation')).toHaveLength(
      1
    );
  });

  it('does not publish insertion until both observation and receipt have flushed', async () => {
    const writing = deferred(),
      gate = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'native_steering_receipt' && event.status === 'inserted') {
        writing.resolve();
        await gate.promise;
      }
    });
    await f.steering.submit(request());
    const observation = f.steering.observeInserted(request().messageId);
    await writing.promise;
    const duplicate = f.steering.observeInserted(request().messageId);
    expect(duplicate).toBe(observation);
    expect(f.receipts.some((receipt) => receipt.status === 'inserted')).toBe(false);
    gate.resolve();
    expect(await observation).toMatchObject({ status: 'inserted' });
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
  });

  it.each(['end', 'retire'] as const)(
    'fences an owner that will %s synchronously inside dispatch invocation',
    async (action) => {
      const f = fixture();
      let ending: Promise<void> | undefined;
      f.dispatch.mockImplementation(() => {
        if (action === 'end') ending = f.steering.end();
        else f.retire();
        return f.rpc.promise;
      });
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      await ending;
      f.rpc.resolve({ status: 'accepted' });
      await f.steering.settled();
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      expect(f.dispatch).toHaveBeenCalledOnce();
    }
  );

  it.each(['native_steering_observation', 'native_steering_receipt'])(
    'never claims insertion after the %s evidence write fails',
    async (type) => {
      const f = fixture(async (event) => {
        if (event.type === type && (type.endsWith('observation') || event.status === 'inserted'))
          throw new Error('Synthetic insertion journal failure');
      });
      await f.steering.submit(request());
      expect(await f.steering.observeInserted(request().messageId)).toMatchObject({
        status: 'unknown',
      });
      f.rpc.resolve({ status: 'accepted' });
      await f.steering.settled();
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      expect(f.receipts.some((receipt) => receipt.status === 'inserted')).toBe(false);
      expect(f.dispatch).toHaveBeenCalledOnce();
    }
  );

  it.each(['refused', 'unknown', 'reject', 'throw'] as const)(
    'settles a %s dispatch without a retry or an insertion claim',
    async (status) => {
      const f = fixture();
      if (status === 'throw')
        f.dispatch.mockImplementation(() => {
          throw new Error('Synthetic dispatch throw');
        });
      await f.steering.submit(request());
      if (status === 'reject') f.rpc.reject(new Error('Synthetic transport loss'));
      else if (status !== 'throw')
        f.rpc.resolve({ status, reason: 'provider unavailable with private output' });
      await f.steering.settled();
      const receipt = await f.steering.submit(request());
      expect(receipt.status).toBe(status === 'refused' ? 'refused' : 'unknown');
      expect(receipt.reason).toBe(
        status === 'refused' ? 'provider_refused' : 'provider_dispatch_uncertain'
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(await f.steering.observeInserted(request().messageId)).toMatchObject({
        reason: 'observation_not_pending',
      });
      expect(JSON.stringify(f.events)).not.toContain('private output');
    }
  );

  it('ends synchronously without awaiting a hung RPC and never upgrades a late response or echo', async () => {
    const f = fixture();
    await f.steering.submit(request());
    const ending = f.steering.end();
    expect(await f.steering.submit(request('late'))).toMatchObject({ status: 'refused' });
    expect(await f.steering.observeInserted(request().messageId)).toMatchObject({
      reason: 'no_active_turn',
    });
    await ending;
    expect(await f.steering.submit(request())).toMatchObject({
      status: 'unknown',
      reason: 'turn_finished',
    });
    const count = f.events.length;
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    await f.steering.close();
    expect(f.events).toHaveLength(count);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('ends a still-persisting intent as refused, so it cannot spill into another generation', async () => {
    const writing = deferred(),
      gate = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'native_steering_request') {
        writing.resolve();
        await gate.promise;
      }
    });
    const admission = f.steering.submit(request());
    await writing.promise;
    const end = f.steering.end();
    const close = f.steering.close();
    gate.resolve();
    expect(await admission).toMatchObject({ status: 'refused', reason: 'turn_finished' });
    await Promise.all([end, close]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.steering.submit(request('new'))).toMatchObject({ reason: 'no_active_turn' });
    const next = fixture();
    expect(await next.steering.observeInserted(request().messageId)).toMatchObject({
      reason: 'not_dispatched',
    });
    expect(next.dispatch).not.toHaveBeenCalled();
  });

  it.each(['end', 'close'] as const)(
    'persists refusal when %s races a successful initial pending receipt flush',
    async (action) => {
      const writing = deferred(),
        gate = deferred();
      const f = fixture(async (event) => {
        if (event.type === 'native_steering_receipt' && event.status === 'pending') {
          writing.resolve();
          await gate.promise;
        }
      });
      const admission = f.steering.submit(request());
      await writing.promise;
      expect(f.dispatch).not.toHaveBeenCalled();
      const end = f.steering[action]();
      gate.resolve();
      const receipt = {
        messageId: request().messageId,
        status: 'refused',
        reason: action === 'end' ? 'turn_finished' : 'owner_stopped',
      };
      expect(await admission).toEqual(receipt);
      await end;
      expect(await f.steering.submit(request())).toEqual(receipt);
      expect(f.events.at(-1)).toMatchObject({ type: 'native_steering_receipt', ...receipt });
      expect(f.receipts).toEqual([receipt]);
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(() => f.steering.assertHealthy()).not.toThrow();
    }
  );

  it.each(['pending', 'refused', 'retired-owner'] as const)(
    'keeps the outcome unknown when a terminal pending flush encounters %s uncertainty',
    async (failure) => {
      const writing = deferred(),
        gate = deferred();
      const f = fixture(async (event) => {
        if (event.type !== 'native_steering_receipt') return;
        if (event.status === 'pending') {
          writing.resolve();
          await gate.promise;
        }
        if (event.status === failure) throw new Error('Synthetic terminal persistence failure');
      });
      const admission = f.steering.submit(request());
      await writing.promise;
      const end = f.steering.end();
      if (failure === 'retired-owner') f.retire();
      gate.resolve();
      expect(await admission).toMatchObject({ status: 'unknown' });
      await end;
      expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
      expect(f.receipts.every((receipt) => receipt.status === 'unknown')).toBe(true);
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  );

  it('keeps a dispatched request unknown when end races its accepted pending receipt flush', async () => {
    const writing = deferred(),
      gate = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'native_steering_receipt' && event.reason === 'provider_accepted') {
        writing.resolve();
        await gate.promise;
      }
    });
    await f.steering.submit(request());
    f.rpc.resolve({ status: 'accepted' });
    await writing.promise;
    const end = f.steering.end();
    gate.resolve();
    await end;
    await f.steering.settled();
    expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
    expect(f.events.at(-1)).toMatchObject({ type: 'native_steering_receipt', status: 'unknown' });
    expect(f.receipts.some((receipt) => receipt.status === 'refused')).toBe(false);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each(['native_steering_observation', 'native_steering_receipt'])(
    'records uncertainty if Stop races the %s insertion barrier',
    async (type) => {
      const writing = deferred(),
        gate = deferred();
      const f = fixture(async (event) => {
        if (event.type === type && (type.endsWith('observation') || event.status === 'inserted')) {
          writing.resolve();
          await gate.promise;
        }
      });
      await f.steering.submit(request());
      const observation = f.steering.observeInserted(request().messageId);
      await writing.promise;
      const end = f.steering.end('owner_stopped');
      gate.resolve();
      expect(await observation).toMatchObject({ status: 'unknown' });
      await end;
      expect(f.receipts.some((receipt) => receipt.status === 'inserted')).toBe(false);
      expect(f.events.at(-1)).toMatchObject({ type: 'native_steering_receipt', status: 'unknown' });
      f.rpc.resolve({ status: 'accepted' });
      await f.steering.settled();
    }
  );

  it.each(['intent', 'observation', 'inserted-receipt'] as const)(
    'never writes again or promotes a receipt after ownership is lost during %s persistence',
    async (stage) => {
      const writing = deferred(),
        gate = deferred();
      const f = fixture(async (event) => {
        if (
          (stage === 'intent' && event.type === 'native_steering_request') ||
          (stage === 'observation' && event.type === 'native_steering_observation') ||
          (stage === 'inserted-receipt' &&
            event.type === 'native_steering_receipt' &&
            event.status === 'inserted')
        ) {
          writing.resolve();
          await gate.promise;
        }
      });
      const admission = f.steering.submit(request());
      let observation: Promise<SessionSteeringReceipt> | undefined;
      if (stage !== 'intent') {
        await admission;
        observation = f.steering.observeInserted(request().messageId);
      }
      await writing.promise;
      f.retire();
      gate.resolve();
      expect(await (observation ?? admission)).toMatchObject({ status: 'unknown' });
      const count = f.events.length;
      await f.steering.close();
      f.rpc.resolve({ status: 'accepted' });
      await f.steering.settled();
      expect(f.events).toHaveLength(count);
      expect(f.receipts.some((receipt) => receipt.status === 'inserted')).toBe(false);
      expect(f.dispatch).toHaveBeenCalledTimes(stage === 'intent' ? 0 : 1);
    }
  );

  it('does not claim provider refusal after a dispatch result arrives for a retired owner', async () => {
    const f = fixture();
    await f.steering.submit(request());
    f.retire();
    f.rpc.resolve({ status: 'refused' });
    await f.steering.settled();
    expect(await f.steering.submit(request())).toMatchObject({ status: 'unknown' });
    expect(f.events).toHaveLength(2);
  });

  it('bounds cumulative text and receipt evidence without eviction even after insertion', async () => {
    const f = fixture();
    f.dispatch.mockResolvedValue({ status: 'accepted' });
    for (let i = 0; i < MAX_STEERING_GENERATION_BYTES / MAX_STEERING_TEXT_BYTES; i++) {
      await f.steering.submit(request(`large-${i}`, 'a'.repeat(MAX_STEERING_TEXT_BYTES)));
      await f.steering.observeInserted(`large-${i}`);
    }
    expect(await f.steering.submit(request('overflow'))).toMatchObject({
      reason: 'steering_capacity',
    });
    expect(
      await f.steering.submit(request('large-0', 'a'.repeat(MAX_STEERING_TEXT_BYTES)))
    ).toMatchObject({ status: 'inserted' });
    await f.steering.settled();
    const g = fixture();
    g.dispatch.mockResolvedValue({ status: 'refused' });
    for (let i = 0; i < MAX_STEERING_RECEIPTS; i++)
      await g.steering.submit(request(`small-${i}`, 'x'));
    await g.steering.settled();
    expect(await g.steering.submit(request('overflow', 'x'))).toMatchObject({
      reason: 'steering_capacity',
    });
    expect(await g.steering.submit(request('small-0', 'x'))).toMatchObject({
      status: 'refused',
      reason: 'provider_refused',
    });
    expect(g.dispatch).toHaveBeenCalledTimes(MAX_STEERING_RECEIPTS);
  });

  it('never replays native journal evidence as hosted user input or inbox work', async () => {
    const f = fixture();
    await f.steering.submit(request());
    f.rpc.resolve({ status: 'accepted' });
    await f.steering.settled();
    await f.steering.observeInserted(request().messageId);
    await f.steering.end();
    expect(f.events.every((event) => String(event.type).startsWith('native_steering_'))).toBe(true);
    const ledger = new ContextLedger();
    const replay = hydrateLedgerFromEvents(ledger, f.events);
    expect(ledger.listEntries()).toEqual([]);
    expect(replay.seenInboxIds).toEqual([]);
    expect(replay.tailPreview).toEqual([]);
  });
});
