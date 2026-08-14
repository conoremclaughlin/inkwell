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

  it('rejects a second standing reader instead of stranding the first', async () => {
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

describe('InputSlot preemption', () => {
  it('lets a prompt take the line from the standing reader and give it back', async () => {
    const slot = new InputSlot();

    // This is the real shape: the REPL loop re-arms the instant it dispatches a
    // turn, so it already holds the line when an approval needs to ask.
    const reader = slot.wait();
    const prompt = slot.waitPriority();
    expect(slot.preempted).toBe(true);

    slot.submit('y');
    await expect(prompt).resolves.toBe('y');
    expect(slot.preempted).toBe(false);

    // The reader was never disturbed — it gets the next line, not a rejection.
    slot.submit('next command');
    await expect(reader).resolves.toBe('next command');
  });

  it('serves a prompt that arrives before any reader', async () => {
    const slot = new InputSlot();
    const prompt = slot.waitPriority();
    slot.submit('a');
    await expect(prompt).resolves.toBe('a');
  });

  it('lets the reader re-arm underneath a live prompt', async () => {
    const slot = new InputSlot();
    const prompt = slot.waitPriority();
    // No rejection: a reader may legitimately re-arm while a prompt holds the
    // line, and will be served once the prompt releases.
    const reader = slot.wait();

    slot.submit('y');
    await expect(prompt).resolves.toBe('y');
    slot.submit('later');
    await expect(reader).resolves.toBe('later');
  });

  it('still rejects a second prompt — that is the coordinator failing', async () => {
    const slot = new InputSlot();
    const first = slot.waitPriority();
    await expect(slot.waitPriority()).rejects.toThrow(/Another prompt already holds/);

    slot.submit('y');
    await expect(first).resolves.toBe('y');
  });

  it('returns the line to the reader when the prompt aborts', async () => {
    const slot = new InputSlot();
    const reader = slot.wait();
    const controller = new AbortController();
    const prompt = slot.waitPriority({ signal: controller.signal });

    controller.abort();
    await expect(prompt).rejects.toBeInstanceOf(InkInputAborted);
    expect(slot.preempted).toBe(false);

    slot.submit('back to the reader');
    await expect(reader).resolves.toBe('back to the reader');
  });

  it('fails both waiters on exit', async () => {
    const slot = new InputSlot();
    const reader = slot.wait();
    const prompt = slot.waitPriority();
    const sentinel = new Error('exit');

    expect(slot.fail(sentinel)).toBe(true);
    await expect(prompt).rejects.toBe(sentinel);
    await expect(reader).rejects.toBe(sentinel);
    expect(slot.occupied).toBe(false);
  });
});
