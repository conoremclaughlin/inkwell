/**
 * Pins the property the rest of the suite cannot observe: the logging hot path
 * must use the ASYNC filesystem API. A synchronous write inside the promise
 * chain would still look "deferred" to a caller, so deferral tests can't catch
 * a regression back to `appendFileSync` — only asserting which API is reached
 * can. Blocking here stalls the plugin's event loop, which the MCP stdio
 * transport shares (repo rule: never block the event loop).
 *
 * Lives in its own file because it mocks `fs`/`fs/promises` module-wide.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const appendFileSyncSpy = vi.fn();
const appendFileSpy = vi.fn(async () => {});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    appendFileSync: (...args: unknown[]) => appendFileSyncSpy(...args),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0 })),
    appendFile: (...args: unknown[]) => appendFileSpy(...args),
  };
});

const { createLogger } = await import('./logger');

beforeEach(() => {
  appendFileSyncSpy.mockClear();
  appendFileSpy.mockClear();
});

describe('blocking-API contract', () => {
  it('log() writes via async appendFile and never appendFileSync', async () => {
    const logger = createLogger({ dir: '/tmp/ink-fake', file: '/tmp/ink-fake/plugin.log' });
    logger.log('info', 'Thread drain result', { injected: 1 });
    await logger.flush();

    expect(appendFileSpy).toHaveBeenCalledTimes(1);
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
  });

  it('every level on the hot path stays async', async () => {
    const logger = createLogger({
      dir: '/tmp/ink-fake',
      file: '/tmp/ink-fake/plugin.log',
      level: 'debug',
    });
    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');
    await logger.flush();

    expect(appendFileSpy).toHaveBeenCalledTimes(4);
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
  });

  it('logSync() is the one deliberate exception — exit handlers only', () => {
    const logger = createLogger({ dir: '/tmp/ink-fake', file: '/tmp/ink-fake/plugin.log' });
    logger.logSync('info', 'Detach: process exiting');

    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(appendFileSpy).not.toHaveBeenCalled();
  });
});
