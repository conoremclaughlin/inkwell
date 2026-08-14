import { describe, expect, it } from 'vitest';
import { InputSlot, InkInputAborted } from './input-slot.js';

describe('InputSlot', () => {
  it('delivers a submitted line to the waiter', async () => {
    const slot = new InputSlot();
    const pending = slot.wait();
    expect(slot.occupied).toBe(true);

    expect(slot.submit('hello')).toBe(true);
    await expect(pending).resolves.toBe('hello');
    expect(slot.occupied).toBe(false);
  });

  it('ignores a submission when nobody is waiting', () => {
    const slot = new InputSlot();
    expect(slot.submit('nobody home')).toBe(false);
  });

  it('rejects a second concurrent waiter instead of stranding the first', async () => {
    const slot = new InputSlot();
    const first = slot.wait();

    // The old inline version reassigned the slot here and the first promise
    // never settled again — a silent hang instead of a visible error.
    await expect(slot.wait()).rejects.toThrow(/already occupied/);

    slot.submit('for the first caller');
    await expect(first).resolves.toBe('for the first caller');
  });

  it('releases the slot when the waiter aborts', async () => {
    const slot = new InputSlot();
    const controller = new AbortController();
    const pending = slot.wait({ signal: controller.signal });

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(InkInputAborted);
    expect(slot.occupied).toBe(false);

    // The next caller gets the slot rather than inheriting a stuck one.
    const next = slot.wait();
    slot.submit('next');
    await expect(next).resolves.toBe('next');
  });

  it('rejects immediately when the signal already fired', async () => {
    const slot = new InputSlot();
    const controller = new AbortController();
    controller.abort();

    await expect(slot.wait({ signal: controller.signal })).rejects.toBeInstanceOf(InkInputAborted);
    expect(slot.occupied).toBe(false);
  });

  it('does not let a stale abort evict a later waiter', async () => {
    const slot = new InputSlot();
    const controller = new AbortController();

    const first = slot.wait({ signal: controller.signal });
    slot.submit('done');
    await expect(first).resolves.toBe('done');

    const second = slot.wait();
    // The first waiter's signal fires after it already settled. It must not
    // clear the slot the second waiter now holds.
    controller.abort();
    expect(slot.occupied).toBe(true);

    slot.submit('still mine');
    await expect(second).resolves.toBe('still mine');
  });

  it('fails the current waiter on exit', async () => {
    const slot = new InputSlot();
    const pending = slot.wait();
    const sentinel = new Error('exit');

    expect(slot.fail(sentinel)).toBe(true);
    await expect(pending).rejects.toBe(sentinel);
    expect(slot.occupied).toBe(false);
    expect(slot.fail(sentinel)).toBe(false);
  });
});
