import { describe, expect, it, vi } from 'vitest';
import { openClaudeInputQueue } from './claude-input-queue.js';
import type { NativeSteeringBinding } from './native-steering-binding.js';

async function fixture() {
  const sent: Array<Record<string, unknown> & { uuid: string }> = [];
  const events: Record<string, unknown>[] = [];
  const log = {
    append: vi.fn((event: Record<string, unknown>) => {
      events.push(event);
      return events.length;
    }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  let submit!: Parameters<NativeSteeringBinding['bind']>[0];
  const release = vi.fn();
  const binding: NativeSteeringBinding = {
    turnEpoch: 'synthetic-epoch',
    assertCurrent: vi.fn(),
    ownChild: vi.fn(),
    openLog: vi.fn(async () => log as never),
    bind: vi.fn((enqueue) => {
      submit = enqueue;
      return release;
    }),
  };
  const endInput = vi.fn();
  const failed = vi.fn();
  const write = vi.fn((line: string) => {
    sent.push(JSON.parse(line));
  });
  const queue = await openClaudeInputQueue({
    binding,
    nativeSessionId: 'synthetic-native',
    write,
    endInput,
    failed,
  });
  const receive = (frame: Record<string, unknown>) =>
    queue.receive({ session_id: 'synthetic-native', ...frame });
  queue.start('Initial synthetic request');
  const original = sent[1].uuid as string;
  const lifecycle = (uuid: string, state: string) =>
    receive({ type: 'command_lifecycle', command_uuid: uuid, state });
  const result = (...uuids: string[]) => receive({ type: 'result', user_message_uuids: uuids });
  const init = () =>
    receive({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] });
  const steer = (messageId = 'correction', text = 'Synthetic correction') =>
    submit({ messageId, text });
  const finish = async (...uuids: string[]) => {
    result(...uuids);
    for (const uuid of uuids) lifecycle(uuid, 'completed');
    await vi.waitFor(() => expect(endInput).toHaveBeenCalledOnce());
    await queue.dispose();
  };
  return {
    queue,
    sent,
    events,
    log,
    binding,
    release,
    endInput,
    failed,
    write,
    original,
    receive,
    lifecycle,
    result,
    init,
    steer,
    finish,
  };
}

describe('Claude default native input queue', () => {
  it('writes ordinary frames without priority or shouldQuery and keeps stdin open', async () => {
    const f = await fixture();
    f.init();
    expect(await f.steer()).toMatchObject({ status: 'pending' });
    expect(f.sent).toHaveLength(3);
    expect(f.sent[0]).toMatchObject({ request: { subtype: 'initialize', hooks: {} } });
    for (const frame of f.sent.slice(1)) {
      expect(frame).not.toHaveProperty('shouldQuery');
      expect(frame).not.toHaveProperty('priority');
    }
    expect(f.endInput).not.toHaveBeenCalled();
    await f.queue.dispose();
  });

  it('does not finish on a correction completed before the final reply', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    const correction = f.sent[2].uuid;
    f.lifecycle(correction, 'started');
    f.lifecycle(correction, 'completed');
    expect(f.endInput).not.toHaveBeenCalled();
    f.result(f.original, correction);
    expect(f.endInput).not.toHaveBeenCalled();
    f.lifecycle(f.original, 'completed');
    await vi.waitFor(() => expect(f.endInput).toHaveBeenCalledOnce());
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'native_steering_receipt', status: 'inserted' })
    );
    expect(await f.steer('late')).toMatchObject({ status: 'refused' });
    await f.queue.dispose();
  });

  it('waits through the first result for the queued correction and its own reply', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    const correction = f.sent[2].uuid;
    f.result(f.original);
    f.lifecycle(f.original, 'completed');
    expect(f.endInput).not.toHaveBeenCalled();
    f.lifecycle(correction, 'started');
    f.lifecycle(correction, 'completed');
    expect(f.endInput).not.toHaveBeenCalled();
    await f.finish(correction);
  });

  it('holds termination for an admitted correction still awaiting its write barrier', async () => {
    const f = await fixture();
    f.init();
    let unblock!: () => void;
    f.log.flush.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          unblock = done;
        })
    );
    const pending = f.steer();
    await vi.waitFor(() => expect(f.log.flush).toHaveBeenCalledOnce());
    f.result(f.original);
    f.lifecycle(f.original, 'completed');
    expect(f.endInput).not.toHaveBeenCalled();
    unblock();
    await pending;
    expect(f.sent).toHaveLength(3);
    const correction = f.sent[2].uuid;
    f.lifecycle(correction, 'started');
    await f.finish(correction);
  });

  it('same ID reconciles without another write; changed content refuses', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    await f.steer();
    expect(f.sent).toHaveLength(3);
    expect(await f.steer('correction', 'Different text')).toMatchObject({
      status: 'refused',
      reason: 'message_id_conflict',
    });
    f.lifecycle(f.sent[2].uuid, 'started');
    await vi.waitFor(async () => expect(await f.steer()).toMatchObject({ status: 'inserted' }));
    await f.finish(f.original, f.sent[2].uuid);
  });

  it('does not treat pipe acceptance, queued state, or foreign evidence as insertion', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    const correction = f.sent[2].uuid;
    f.lifecycle(correction, 'queued');
    f.receive({
      session_id: 'foreign',
      type: 'command_lifecycle',
      command_uuid: correction,
      state: 'started',
    });
    f.lifecycle('foreign-uuid', 'started');
    expect(await f.steer()).toMatchObject({ status: 'pending' });
    await f.queue.dispose();
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'native_steering_receipt', status: 'unknown' })
    );
    expect(f.events.some((e) => e.status === 'inserted')).toBe(false);
  });

  it('seals on stop and never upgrades unknown from a late completion', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    await f.queue.stop();
    f.lifecycle(f.sent[2].uuid, 'started');
    f.lifecycle(f.sent[2].uuid, 'completed');
    expect(await f.steer()).toMatchObject({ status: 'refused' });
    expect(f.events.some((e) => e.status === 'inserted')).toBe(false);
    await f.queue.dispose();
  });

  it('a thrown write is unknown and stops the owned run without replay', async () => {
    const f = await fixture();
    f.init();
    f.write.mockImplementationOnce(() => {
      throw new Error('Synthetic pipe failure');
    });
    await f.steer();
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    expect(f.sent).toHaveLength(2);
    expect(f.queue.error).toBeDefined();
    await f.queue.dispose();
    expect(f.events).toContainEqual(expect.objectContaining({ status: 'unknown' }));
  });

  it('refuses missing lifecycle capability before exposing a steering port', async () => {
    const f = await fixture();
    f.receive({ type: 'system', subtype: 'init', capabilities: [] });
    expect(f.binding.bind).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledOnce();
    await f.queue.dispose();
  });

  it('finishes an unsteered run only after both result and lifecycle completion', async () => {
    const f = await fixture();
    f.init();
    f.lifecycle(f.original, 'completed');
    expect(f.endInput).not.toHaveBeenCalled();
    await f.finish(f.original);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.log.close).toHaveBeenCalledOnce();
  });
});
