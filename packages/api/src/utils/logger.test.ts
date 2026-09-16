/**
 * The logger must not touch the operator's real log files during tests.
 *
 * Before this guard, importing the logger attached winston File transports to
 * ~/.ink/logs/{combined,error}.log — the SAME files the running server writes.
 * Every unit test run appended to them, and mocked test values became
 * indistinguishable from production events. Concretely: memory-repository's
 * "skips RPC when query embedding dimensions do not match" test mocks a 768-dim
 * nomic-embed-text query against 1024-dim storage to exercise a guard, and 118
 * copies of "Skipping semantic recall due to embedding dimension mismatch"
 * accumulated in combined.log. They read as a live embedding misconfiguration
 * silently degrading recall, and were investigated as one. The deployed config
 * (mxbai-embed-large, 1024) was correct throughout.
 */

import { describe, expect, it } from 'vitest';
import winston from 'winston';
import { logger } from './logger';

function fileTransports(target: winston.Logger) {
  return target.transports.filter((t) => t instanceof winston.transports.File);
}

describe('logger transports under test', () => {
  it('runs with the test guard active', () => {
    // Guards the guard: if neither signal is set, every assertion below passes
    // vacuously and the pollution could return unnoticed.
    expect(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test').toBe(true);
  });

  it('attaches NO file transports — nothing reaches ~/.ink/logs', () => {
    expect(fileTransports(logger)).toHaveLength(0);
  });

  it('keeps console output so test failures stay debuggable', () => {
    const consoleTransports = logger.transports.filter(
      (t) => t instanceof winston.transports.Console
    );
    expect(consoleTransports.length).toBeGreaterThan(0);
  });

  it('writes no file for any level, including error', () => {
    // error.log had its own transport; both must be gone.
    logger.info('test-marker-info');
    logger.error('test-marker-error');
    expect(fileTransports(logger)).toHaveLength(0);
  });

  it('registers no file-backed exception or rejection handlers', () => {
    // These wrote exceptions.log / rejections.log on import.
    const handlers = [
      ...((
        logger as unknown as { exceptions?: { handlers?: Map<string, unknown> } }
      ).exceptions?.handlers?.values() ?? []),
      ...((
        logger as unknown as { rejections?: { handlers?: Map<string, unknown> } }
      ).rejections?.handlers?.values() ?? []),
    ];
    const fileBacked = handlers.filter((h) => h instanceof winston.transports.File);
    expect(fileBacked).toHaveLength(0);
  });
});
