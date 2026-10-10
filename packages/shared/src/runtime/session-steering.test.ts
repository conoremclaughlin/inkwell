import { describe, expect, it } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { SessionLog } from './session-log.js';
import { hydrateLedgerFromEvents } from './session-history.js';
import {
  createSessionSteering,
  parseSessionSteering,
  readSessionSteeringInput,
  MAX_STEERING_GENERATION_BYTES,
  MAX_STEERING_TEXT_BYTES,
  type SessionSteeringReceipt,
} from './session-steering.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(write?: (event: Record<string, unknown>) => Promise<void>) {
  const events: Record<string, unknown>[] = [];
  const receipts: SessionSteeringReceipt[] = [];
  const ledger = new ContextLedger();
  let current = true;
  const log = new SessionLog({
    path: 'memory:steering',
    sink: {
      write: async (line) => {
        const event = JSON.parse(line);
        await write?.(event);
        events.push(event);
      },
    },
  });
  const steering = createSessionSteering({
    turnEpoch: 'synthetic-generation',
    log,
    ledger,
    assertCurrent: () => {
      if (!current) throw new Error('Retired generation');
    },
    receipt: (r) => {
      receipts.push(r);
    },
  });
  return {
    steering,
    events,
    receipts,
    ledger,
    log,
    retire: () => {
      current = false;
    },
  };
}
const request = (messageId = 'synthetic-message', text = 'Use UPDATED instead.') => ({
  messageId,
  text,
});

describe('direct owner-text steering mailbox', () => {
  it('strictly bounds input and refuses sender, role, grants and media', () => {
    expect(parseSessionSteering(request())).toEqual(request());
    for (const value of [
      null,
      [],
      {},
      request('', 'text'),
      request('x', '  '),
      request('x\n', 'text'),
      request('x', 'bad\0text'),
      request('x', 'a'.repeat(MAX_STEERING_TEXT_BYTES + 1)),
      request('x', '😀'.repeat(MAX_STEERING_TEXT_BYTES / 4 + 1)),
      { ...request(), role: 'system' },
      { ...request(), sender: 'owner' },
      { ...request(), grants: ['all'] },
      { ...request(), media: [] },
    ])
      expect(parseSessionSteering(value)).toBeUndefined();
  });

  it('persists intent before pending acknowledgment and inserts only when drained', async () => {
    const gate = deferred();
    const f = fixture((event) =>
      event.type === 'steering_request' ? gate.promise : Promise.resolve()
    );
    f.steering.beginTurn();
    let acknowledged = false;
    const pending = f.steering.enqueue(request()).then((r) => {
      acknowledged = true;
      return r;
    });
    await Promise.resolve();
    expect(f.steering.pendingTextBytes()).toBe(new TextEncoder().encode(request().text).byteLength);
    expect(acknowledged).toBe(false);
    expect(f.ledger.listEntries()).toEqual([]);
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'pending' });
    expect(f.events.map((e) => e.type)).toEqual(['steering_request']);
    const inserted = await f.steering.drain();
    expect(inserted).toEqual([{ ...request(), eid: 2 }]);
    expect(f.ledger.listEntries()).toMatchObject([
      { role: 'user', content: request().text, source: 'steering', eid: 2 },
    ]);
    expect(f.receipts.at(-1)).toEqual({
      messageId: request().messageId,
      status: 'inserted',
      eid: 2,
    });
    expect(f.events.at(-1)).toMatchObject({
      type: 'steering_receipt',
      status: 'inserted',
      inputEid: 2,
    });
    expect(await f.steering.drain()).toEqual([]);
    expect(f.steering.pendingTextBytes()).toBe(0);
  });

  it('deduplicates simultaneous retries and conflicts without an extra durable write', async () => {
    const gate = deferred();
    const f = fixture(() => gate.promise);
    f.steering.beginTurn();
    const first = f.steering.enqueue(request());
    const retry = f.steering.enqueue(request());
    expect(await f.steering.enqueue(request('synthetic-message', 'Different'))).toMatchObject({
      status: 'refused',
      reason: 'message_id_conflict',
    });
    gate.resolve();
    expect(await first).toEqual(await retry);
    await f.steering.drain();
    expect(await f.steering.enqueue(request())).toMatchObject({ status: 'inserted' });
    expect(f.events.filter((e) => e.type === 'steering_request')).toHaveLength(1);
    expect(f.events.filter((e) => e.type === 'steering_input')).toHaveLength(1);
  });

  it('refuses before a turn, at a no-tools final, and never spills to the next turn', async () => {
    const f = fixture();
    expect(await f.steering.enqueue(request())).toMatchObject({
      status: 'refused',
      reason: 'no_active_turn',
    });
    f.steering.beginTurn();
    await f.steering.enqueue(request());
    const closing = f.steering.endTurn();
    expect(await f.steering.enqueue(request('late'))).toMatchObject({ status: 'refused' });
    await closing;
    expect(await f.steering.enqueue(request())).toMatchObject({
      status: 'refused',
      reason: 'turn_finished',
    });
    f.steering.beginTurn();
    expect(await f.steering.drain()).toEqual([]);
    expect(f.ledger.listEntries()).toEqual([]);
    await f.steering.close();
    expect(() => f.steering.beginTurn()).toThrow();
  });

  it('settles an admission whose intent write finishes after the turn ended', async () => {
    const gate = deferred();
    const f = fixture((event) =>
      event.type === 'steering_request' ? gate.promise : Promise.resolve()
    );
    f.steering.beginTurn();
    const pending = f.steering.enqueue(request());
    const ended = f.steering.endTurn();
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'refused', reason: 'turn_finished' });
    await ended;
    expect(f.events.filter((e) => e.type === 'steering_input')).toEqual([]);
  });

  it('queues arrivals during a drain for a later tool boundary, not its snapshot', async () => {
    const gate = deferred();
    const writing = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'steering_input' && event.messageId === 'first') {
        writing.resolve();
        await gate.promise;
      }
    });
    f.steering.beginTurn();
    await f.steering.enqueue(request('first'));
    const first = f.steering.drain();
    await writing.promise;
    const second = f.steering.enqueue(request('second'));
    await expect(f.steering.drain()).rejects.toThrow('already draining');
    gate.resolve();
    await second;
    expect((await first).map((r) => r.messageId)).toEqual(['first']);
    expect((await f.steering.drain()).map((r) => r.messageId)).toEqual(['second']);
    expect(f.events.filter((e) => e.type === 'steering_input').map((e) => e.boundary)).toEqual([
      1, 2,
    ]);
  });

  it('concurrent close calls both await outstanding admission settlement', async () => {
    const gate = deferred();
    const f = fixture((event) =>
      event.type === 'steering_request' ? gate.promise : Promise.resolve()
    );
    f.steering.beginTurn();
    const admission = f.steering.enqueue(request());
    const first = f.steering.close();
    let secondSettled = false;
    const second = f.steering.close().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    gate.resolve();
    await Promise.all([first, second, admission]);
    expect(f.events.filter((e) => e.type === 'steering_receipt')).toHaveLength(1);
  });

  it('bounds cumulative generation text even after earlier inputs were inserted', async () => {
    const f = fixture();
    f.steering.beginTurn();
    for (let i = 0; i < MAX_STEERING_GENERATION_BYTES / MAX_STEERING_TEXT_BYTES; i++) {
      await f.steering.enqueue(request(`synthetic-${i}`, 'a'.repeat(MAX_STEERING_TEXT_BYTES)));
      await f.steering.drain();
    }
    expect(await f.steering.enqueue(request('over-capacity'))).toMatchObject({
      status: 'refused',
      reason: 'steering_capacity',
    });
    expect(
      await f.steering.enqueue(request('synthetic-0', 'a'.repeat(MAX_STEERING_TEXT_BYTES)))
    ).toMatchObject({ status: 'inserted' });
  });

  it('bounds retained receipts independently of text and never evicts dedupe evidence', async () => {
    const f = fixture();
    f.steering.beginTurn();
    for (let i = 0; i < 128; i++) await f.steering.enqueue(request(`small-${i}`, 'x'));
    expect(await f.steering.enqueue(request('over'))).toMatchObject({
      reason: 'steering_capacity',
    });
    await f.steering.endTurn();
    expect(await f.steering.enqueue(request('small-0', 'x'))).toMatchObject({
      status: 'refused',
      reason: 'turn_finished',
    });
  });

  it('fails closed when intent persistence is uncertain', async () => {
    const f = fixture(async () => {
      throw new Error('Fixture write failed');
    });
    f.steering.beginTurn();
    expect(await f.steering.enqueue(request())).toMatchObject({ status: 'unknown' });
    expect(await f.steering.enqueue(request())).toMatchObject({ status: 'unknown' });
    await expect(f.steering.drain()).rejects.toThrow('uncertain');
    expect(() => f.steering.assertHealthy()).toThrow('uncertain');
    expect(f.ledger.listEntries()).toEqual([]);
    await f.steering.close();
  });

  it('marks a lost generation during input persistence unknown and prevents dispatch', async () => {
    const gate = deferred();
    const writing = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'steering_input') {
        writing.resolve();
        await gate.promise;
      }
    });
    f.steering.beginTurn();
    await f.steering.enqueue(request());
    const inserting = f.steering.drain();
    await writing.promise;
    f.retire();
    gate.resolve();
    await expect(inserting).rejects.toThrow();
    expect(f.receipts.at(-1)).toMatchObject({ status: 'unknown' });
    expect(f.ledger.listEntries()).toEqual([]);
    expect(() => f.steering.assertHealthy()).toThrow();
  });

  it('does not lose later pending entries when a boundary write fails', async () => {
    const f = fixture(async (event) => {
      if (event.type === 'steering_input') throw new Error('Fixture failure');
    });
    f.steering.beginTurn();
    await f.steering.enqueue(request('first'));
    await f.steering.enqueue(request('second'));
    await expect(f.steering.drain()).rejects.toThrow();
    expect(f.receipts.filter((r) => r.status === 'unknown').map((r) => r.messageId)).toEqual([
      'first',
      'second',
    ]);
    await f.steering.endTurn();
    expect(f.ledger.listEntries()).toEqual([]);
  });

  it('persists terminal uncertainty when Stop races an inserted receipt flush', async () => {
    const gate = deferred();
    const writing = deferred();
    const f = fixture(async (event) => {
      if (event.type === 'steering_receipt' && event.status === 'inserted') {
        writing.resolve();
        await gate.promise;
      }
    });
    f.steering.beginTurn();
    await f.steering.enqueue(request());
    const insertion = f.steering.drain();
    await writing.promise;
    f.retire();
    gate.resolve();
    await expect(insertion).rejects.toThrow();
    expect(f.ledger.listEntries()).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'steering_receipt', status: 'unknown' });
    expect(await f.steering.enqueue(request())).toMatchObject({ status: 'unknown' });
    expect(f.receipts.at(-1)).toMatchObject({ status: 'unknown' });
  });

  it('replays inserted context chronologically, never an intent or receipt as new work', async () => {
    const f = fixture();
    f.log.append({ type: 'user', content: 'Original task' });
    f.log.append({ type: 'assistant', content: 'Earlier output' });
    f.steering.beginTurn();
    await f.steering.enqueue(request('inserted'));
    await f.steering.drain();
    await f.steering.enqueue(request('not-inserted', 'Must not become context'));
    await f.steering.endTurn();
    const restored = new ContextLedger();
    const replay = hydrateLedgerFromEvents(restored, f.events);
    expect(restored.listEntries().map((e) => [e.role, e.content])).toEqual([
      ['user', 'Original task'],
      ['assistant', 'Earlier output'],
      ['user', request().text],
    ]);
    expect(replay.seenInboxIds).toEqual([]);
    expect(replay.tailPreview.at(-1)).toMatchObject({ role: 'user', label: 'steering' });
    expect(
      readSessionSteeringInput({
        type: 'steering_input',
        version: 2,
        ...request(),
        turnEpoch: 'x',
        boundary: 1,
      })
    ).toBeUndefined();
  });
});
