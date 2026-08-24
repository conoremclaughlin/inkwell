import { afterEach, describe, expect, it, vi } from 'vitest';
import { divertConsoleLogToStderr, restoreConsoleLog } from './stdout-purity.js';

describe('stdout purity', () => {
  afterEach(() => {
    restoreConsoleLog();
    vi.restoreAllMocks();
  });

  it('sends console.log to stderr while diverted', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    divertConsoleLogToStderr();
    console.log('hook warning');
    expect(err).toHaveBeenCalledWith('hook warning');
  });

  it('restores the original console.log, so the payload reaches stdout', () => {
    const original = console.log;
    divertConsoleLogToStderr();
    expect(console.log).not.toBe(original);
    restoreConsoleLog();
    expect(console.log).toBe(original);
  });

  it('is idempotent — a second divert does not capture the diverted function', () => {
    // Both entry points (cli.ts and the command) may divert. If the second
    // call re-captured, restore would put the stderr-forwarding wrapper back
    // instead of the real console.log and the payload would land on stderr.
    const original = console.log;
    divertConsoleLogToStderr();
    divertConsoleLogToStderr();
    restoreConsoleLog();
    expect(console.log).toBe(original);
  });

  it('restoring without an active diversion is a no-op', () => {
    const original = console.log;
    restoreConsoleLog();
    expect(console.log).toBe(original);
  });
});
