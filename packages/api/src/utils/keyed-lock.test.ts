import { describe, it, expect } from 'vitest';
import { withKeyedLock, keyedLockCount } from './keyed-lock';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('withKeyedLock', () => {
  it('runs holders of the same key one at a time, in arrival order', async () => {
    const log: string[] = [];
    const run = (name: string) =>
      withKeyedLock('repo-a', async () => {
        log.push(`${name}:start`);
        await tick();
        log.push(`${name}:end`);
        return name;
      });
    const results = await Promise.all([run('first'), run('second'), run('third')]);
    expect(results).toEqual(['first', 'second', 'third']);
    expect(log).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third:start',
      'third:end',
    ]);
  });

  it('lets different keys interleave', async () => {
    const log: string[] = [];
    await Promise.all([
      withKeyedLock('repo-a', async () => {
        log.push('a:start');
        await tick();
        log.push('a:end');
      }),
      withKeyedLock('repo-b', async () => {
        log.push('b:start');
        await tick();
        log.push('b:end');
      }),
    ]);
    expect(log.slice(0, 2)).toEqual(['a:start', 'b:start']);
  });

  it('releases the key when a holder throws, so the next holder still runs', async () => {
    const failing = withKeyedLock('repo-c', async () => {
      await tick();
      throw new Error('git lock');
    });
    const following = withKeyedLock('repo-c', async () => 'ran');
    await expect(failing).rejects.toThrow('git lock');
    await expect(following).resolves.toBe('ran');
  });

  it('forgets a key once its last holder finishes', async () => {
    await withKeyedLock('repo-d', async () => tick());
    expect(keyedLockCount()).toBe(0);
  });
});
