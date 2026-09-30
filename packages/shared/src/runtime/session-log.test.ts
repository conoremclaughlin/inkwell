import { describe, expect, it } from 'vitest';
import { SessionLog, type SessionLogOptions, type SessionLogSink } from './session-log.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

describe('shared journal has no implicit host storage', () => {
  it('requires an explicit sink, including for untyped hosts', () => {
    expect(() => new SessionLog({ path: 'fixture' } as SessionLogOptions)).toThrow(
      'host-provided sink'
    );
  });

  it('slow or failed writes in one session do not hold or poison another', async () => {
    const gate = deferred();
    const observedA: unknown[] = [];
    const observedB: unknown[] = [];
    const writtenA: string[] = [];
    const writtenB: string[] = [];
    const a = new SessionLog({
      path: 'session-a',
      sink: {
        write(line) {
          writtenA.push(line);
          return gate.promise;
        },
      },
      onProjection: (e) => observedA.push(e),
    });
    const b = new SessionLog({
      path: 'session-b',
      sink: {
        async write(line) {
          writtenB.push(line);
        },
      },
      onProjection: (e) => observedB.push(e),
    });
    a.append({ type: 'user', content: 'a' });
    a.append({ type: 'assistant', content: 'behind a' });
    b.seed(20);
    b.append({ type: 'user', content: 'b' });
    await b.flush();
    expect(observedA).toEqual([]);
    expect(observedB).toEqual([expect.objectContaining({ eid: 21, content: 'b' })]);
    gate.reject(new Error('fixture sink failure'));
    await expect(a.flush()).rejects.toThrow('fixture sink failure');
    expect(writtenA).toHaveLength(1);
    await expect(a.close()).rejects.toThrow('fixture sink failure');
    b.append({ type: 'assistant', content: 'b continues' });
    await b.close();
    expect(writtenB.map((s) => JSON.parse(s).eid)).toEqual([21, 22]);
    expect(observedB.map((s) => (s as Record<string, unknown>).content)).toEqual([
      'b',
      'b continues',
    ]);
  });

  it('commits each snapshot before observation, including nested values', async () => {
    const gates = [deferred(), deferred()];
    const written: string[] = [];
    const observed: unknown[] = [];
    const sink: SessionLogSink = {
      write(line) {
        written.push(line);
        return gates[written.length - 1]!.promise;
      },
    };
    const log = new SessionLog({
      path: 'fixture',
      sink,
      onProjection: (entry) => observed.push(entry),
    });
    const args = { value: 'at append' };
    log.append({ type: 'local_tool_call', args });
    log.append({ type: 'assistant', content: 'next' });
    args.value = 'after append';
    expect(written).toHaveLength(1);
    expect(observed).toEqual([]);
    // Flushing must wait for both reserved writes, not only the first sink call.
    const flushing = log.flush();
    gates[0]!.resolve();
    gates[1]!.resolve();
    await flushing;
    expect(observed).toEqual(written.map((line) => JSON.parse(line)));
    expect((observed[0] as Record<string, unknown>).args).toEqual({ value: 'at append' });
  });

  it('reserved intent ids are not projected; only a committed outcome becomes visible', async () => {
    const gate = deferred();
    const seen: unknown[] = [];
    const log = new SessionLog({
      path: 'fixture',
      sink: { write: () => gate.promise },
      onProjection: (entry) => seen.push(entry),
    });
    expect(log.append({ type: 'tool_intent', invocationId: 'fixture-invocation' })).toBe(1);
    expect(
      log.append({
        type: 'local_tool_call',
        invocationId: 'fixture-invocation',
        dispatchState: 'not-dispatched',
      })
    ).toBe(2);
    expect(seen).toEqual([]);
    gate.resolve();
    await log.close();
    expect(seen).toEqual([expect.objectContaining({ eid: 2, dispatchState: 'not-dispatched' })]);
  });
});
