import { describe, expect, it, vi } from 'vitest';
import { InputDrainRefusal, SerialInputDrain } from './serial-input-drain.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function drain(run: (input: string) => Promise<void>, maxPendingInputs = 3, maxPendingBytes = 30) {
  return new SerialInputDrain({
    run,
    maxPendingInputs,
    maxPendingBytes,
    sizeOf: (s: string) => s.length,
  });
}

describe('SerialInputDrain', () => {
  it('serializes concurrent input sources while another session and controls make progress', async () => {
    const held = gate();
    const started: string[] = [];
    const queue = drain(async (source) => {
      started.push(source);
      if (source === 'tui') await held.promise;
    });
    const first = queue.enqueue('tui');
    const second = queue.enqueue('inkmail');
    const third = queue.enqueue('channel');
    await Promise.resolve();
    expect(started).toEqual(['tui']);
    expect(queue.pendingInputs).toBe(3);
    expect(queue.pendingBytes).toBe(17);

    const otherRun = vi.fn(async () => undefined);
    await drain(otherRun).enqueue('another-session');
    expect(otherRun).toHaveBeenCalledOnce();
    // Controls go straight to the active owner, not behind ordinary input.
    held.resolve();
    await Promise.all([first, second, third]);
    expect(started).toEqual(['tui', 'inkmail', 'channel']);
    expect(queue.pendingInputs).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });

  it('refuses capacity synchronously before local preparation, including the active input', async () => {
    const held = gate();
    const queue = drain(async () => held.promise, 1);
    const first = queue.enqueue('first');
    const prepare = vi.fn();
    expect(() => queue.enqueue('second', prepare)).toThrow(InputDrainRefusal);
    expect(prepare).not.toHaveBeenCalled();
    expect(queue.pendingInputs).toBe(1);
    held.resolve();
    await first;
    await queue.enqueue('second');
  });

  it('bounds retained bytes independently of count and releases them only on settlement', async () => {
    const held = gate();
    const queue = drain(async () => held.promise, 10, 5);
    const first = queue.enqueue('12345');
    expect(() => queue.enqueue('6')).toThrow('capacity');
    held.resolve();
    await first;
    await queue.enqueue('abcde');
    expect(queue.pendingBytes).toBe(0);
    expect(() => queue.enqueue('123456')).toThrow('too-large');
  });

  it('distinguishes permanently oversized input even while count capacity is occupied', async () => {
    const held = gate();
    const queue = drain(async () => held.promise, 1, 5);
    const first = queue.enqueue('first');
    const prepare = vi.fn();
    expect(() => queue.enqueue('123456', prepare)).toThrow('too-large');
    expect(prepare).not.toHaveBeenCalled();
    expect(queue.pendingInputs).toBe(1);
    expect(queue.pendingBytes).toBe(5);
    held.resolve();
    await first;
    expect(() => queue.enqueue('123456')).toThrow('too-large');
    await queue.enqueue('fits');
  });

  it('does not acknowledge or run an input whose local preparation throws', async () => {
    const run = vi.fn(async () => undefined);
    const queue = drain(run);
    expect(() =>
      queue.enqueue('inbox', () => {
        throw new Error('display unavailable');
      })
    ).toThrow('display unavailable');
    expect(queue.pendingInputs).toBe(0);
    expect(queue.pendingBytes).toBe(0);
    await queue.flush();
    expect(run).not.toHaveBeenCalled();
    await queue.enqueue('retry');
    expect(run).toHaveBeenCalledExactlyOnceWith('retry');
  });

  it('rejects the failed input but keeps draining later inputs after synchronous and asynchronous failures', async () => {
    const seen: string[] = [];
    const queue = drain((input) => {
      seen.push(input);
      if (input === 'sync') throw new Error('sync');
      if (input === 'async') return Promise.reject(new Error('async'));
      return Promise.resolve();
    });
    const first = queue.enqueue('sync');
    const second = queue.enqueue('async');
    const third = queue.enqueue('ok');
    await expect(first).rejects.toThrow('sync');
    await expect(second).rejects.toThrow('async');
    await third;
    await queue.flush();
    expect(seen).toEqual(['sync', 'async', 'ok']);
    expect(queue.pendingInputs).toBe(0);
  });

  it('close refuses new inputs but does not cancel or release an unsettled run', async () => {
    const held = gate();
    const seen: string[] = [];
    const queue = drain(async (s) => {
      seen.push(s);
      await held.promise;
    });
    queue.enqueue('first');
    queue.enqueue('queued');
    let drained = false;
    const closing = queue.close().then(() => {
      drained = true;
    });
    expect(() => queue.enqueue('late')).toThrow('closed');
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(queue.pendingInputs).toBe(2);
    held.resolve();
    await closing;
    expect(seen).toEqual(['first', 'queued']);
  });

  it('refuses reentrant preparation without disturbing outer acceptance', async () => {
    const run = vi.fn(async () => undefined);
    const queue = drain(run);
    await queue.enqueue('outer', () => {
      expect(() => queue.enqueue('inner')).toThrow('reentrant');
    });
    expect(run).toHaveBeenCalledExactlyOnceWith('outer');
  });

  it('a preparation callback cannot bypass closed intake', async () => {
    const run = vi.fn(async () => undefined);
    const queue = drain(run);
    expect(() =>
      queue.enqueue('late', () => {
        void queue.close();
      })
    ).toThrow('closed');
    await queue.flush();
    expect(run).not.toHaveBeenCalled();
    expect(queue.pendingInputs).toBe(0);
  });

  it('a size callback cannot reenter or close intake and still accept the input', async () => {
    const run = vi.fn(async () => undefined);
    const queue: SerialInputDrain<string> = new SerialInputDrain({
      maxPendingInputs: 1,
      maxPendingBytes: 10,
      sizeOf: () => {
        expect(() => queue.enqueue('nested')).toThrow('reentrant');
        void queue.close();
        return 1;
      },
      run,
    });
    const prepare = vi.fn();
    expect(() => queue.enqueue('input', prepare)).toThrow('closed');
    expect(prepare).not.toHaveBeenCalled();
    await queue.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('captures limits at construction and uses the host UTF-8 byte measure', async () => {
    const held = gate();
    const options = {
      maxPendingInputs: 2,
      maxPendingBytes: 4,
      sizeOf: (s: string) => Buffer.byteLength(s, 'utf8'),
      run: async () => held.promise,
    };
    const queue = new SerialInputDrain(options);
    options.maxPendingBytes = 100;
    const first = queue.enqueue('🌱');
    expect(queue.pendingBytes).toBe(4);
    expect(() => queue.enqueue('a')).toThrow('capacity');
    held.resolve();
    await first;
  });

  it.each([0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid bounds: %s',
    (limit) => {
      expect(() => drain(async () => undefined, limit)).toThrow(RangeError);
      expect(() => drain(async () => undefined, 3, limit)).toThrow(RangeError);
    }
  );

  it.each([-1, Infinity, NaN, 0.5])('refuses invalid input size: %s', (size) => {
    const queue = new SerialInputDrain({
      maxPendingInputs: 1,
      maxPendingBytes: 1,
      sizeOf: () => size,
      run: async () => undefined,
    });
    expect(() => queue.enqueue('input')).toThrow(RangeError);
    expect(queue.pendingInputs).toBe(0);
  });
});
