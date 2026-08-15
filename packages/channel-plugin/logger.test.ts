import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger, formatLine, isLogLevel } from './logger';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ink-plugin-log-'));
  file = join(dir, 'channel-plugin.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

describe('formatLine', () => {
  it('matches the historical line shape so existing greps keep working', () => {
    const at = new Date('2026-08-15T02:57:11.053Z');
    expect(formatLine('debug', 'Poll result', { threadCount: 0 }, at)).toBe(
      '2026-08-15T02:57:11.053Z [debug] Poll result {"threadCount":0}\n'
    );
    expect(formatLine('info', 'MCP connected', undefined, at)).toBe(
      '2026-08-15T02:57:11.053Z [info] MCP connected\n'
    );
  });

  it('survives an unserializable payload instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLine('error', 'boom', circular)).not.toThrow();
    expect(formatLine('error', 'boom', circular)).toContain('[unserializable]');
  });
});

describe('isLogLevel', () => {
  it('accepts the four levels and rejects anything else', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(isLogLevel(level)).toBe(true);
    }
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel('')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });

  it('rejects inherited Object property names', () => {
    // `in` walks the prototype chain, so these all passed the old guard. The
    // rank then resolved to a function, every numeric comparison against it
    // was false, and INK_PLUGIN_LOG_LEVEL=toString silently opened the gate
    // to debug instead of falling back to info (Lumen, PR #499 review).
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(isLogLevel(name)).toBe(false);
    }
  });

  it('an inherited name falls back to info rather than enabling debug', async () => {
    // End-to-end proof of the consequence, not just the predicate.
    const logger = createLogger({ dir, file, level: 'toString' as never });
    logger.log('debug', 'must-not-appear');
    logger.log('info', 'must-appear');
    await logger.flush();

    expect(read(file)).not.toContain('must-not-appear');
    expect(read(file)).toContain('must-appear');
  });
});

describe('level gating', () => {
  it('drops debug at the default level — this is the 35k-lines/day fix', async () => {
    const logger = createLogger({ dir, file });
    logger.log('debug', 'Poll result', { threadCount: 0 });
    logger.log('info', 'Thread drain result', { injected: 1 });
    logger.log('warn', 'No session context');
    logger.log('error', 'Poll failed');
    await logger.flush();

    const contents = read(file);
    expect(contents).not.toContain('Poll result');
    expect(contents).toContain('Thread drain result');
    expect(contents).toContain('No session context');
    expect(contents).toContain('Poll failed');
  });

  it('emits debug when explicitly opted in', async () => {
    const logger = createLogger({ dir, file, level: 'debug' });
    logger.log('debug', 'Poll result', { threadCount: 0 });
    await logger.flush();
    expect(read(file)).toContain('Poll result');
  });

  it('level: error suppresses everything below it', async () => {
    const logger = createLogger({ dir, file, level: 'error' });
    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');
    await logger.flush();

    const lines = read(file).trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('] d');
  });
});

describe('async writes', () => {
  // Note: deferral alone does NOT prove non-blocking — a sync write inside an
  // already-async chain would defer too. The blocking-API contract is pinned
  // in logger.async.test.ts; this only covers the queueing behaviour.
  it('defers the write off the caller stack', () => {
    const logger = createLogger({ dir, file });
    logger.log('info', 'deferred');
    expect(read(file)).not.toContain('deferred');
  });

  it('flush() resolves only once the line has landed', async () => {
    const logger = createLogger({ dir, file });
    logger.log('info', 'landed');
    await logger.flush();
    expect(read(file)).toContain('landed');
  });

  it('preserves ordering across many rapid writes', async () => {
    const logger = createLogger({ dir, file });
    for (let i = 0; i < 200; i += 1) logger.log('info', `line-${i}`);
    await logger.flush();

    const lines = read(file).trim().split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain('line-0');
    expect(lines[199]).toContain('line-199');
  });
});

describe('rotation', () => {
  it('rotates to <file>.1 past maxBytes and keeps writing to the live path', async () => {
    // ~61 bytes per line; 10 lines crosses 400 exactly once.
    const logger = createLogger({ dir, file, maxBytes: 400 });
    for (let i = 0; i < 10; i += 1) logger.log('info', `entry-${i}-${'x'.repeat(20)}`);
    await logger.flush();

    expect(existsSync(`${file}.1`)).toBe(true);
    // Neither generation may exceed the cap — the uncapped-growth regression.
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(400);

    // Nothing is lost across a single rotation: every entry lives in one file
    // or the other.
    const all = `${read(`${file}.1`)}${read(file)}`;
    for (let i = 0; i < 10; i += 1) expect(all).toContain(`entry-${i}-`);
  });

  it('keeps exactly one old generation — .2 is never created', async () => {
    const logger = createLogger({ dir, file, maxBytes: 300 });
    for (let i = 0; i < 60; i += 1) logger.log('info', `entry-${i}-${'x'.repeat(20)}`);
    await logger.flush();

    expect(existsSync(`${file}.2`)).toBe(false);
    // Bounded total footprint is the point: two generations, both capped.
    expect(statSync(file).size).toBeLessThanOrEqual(300);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(300);
    // The newest line always survives.
    expect(`${read(`${file}.1`)}${read(file)}`).toContain('entry-59-');
  });

  it('adopts a pre-existing oversized file rather than appending to it forever', async () => {
    writeFileSync(file, 'x'.repeat(500));
    const logger = createLogger({ dir, file, maxBytes: 400 });
    logger.log('info', 'after-restart');
    await logger.flush();

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(read(`${file}.1`)).toContain('x'.repeat(500));
    expect(read(file)).toContain('after-restart');
    expect(statSync(file).size).toBeLessThanOrEqual(400);
  });

  it('survives another process having rotated underneath us', async () => {
    const logger = createLogger({ dir, file, maxBytes: 400 });
    logger.log('info', 'first');
    await logger.flush();

    // Simulate a sibling plugin process winning the rotation race.
    rmSync(file);
    writeFileSync(file, '');

    logger.log('info', 'second');
    await logger.flush();
    expect(read(file)).toContain('second');
  });
});

describe('failure containment', () => {
  it('never throws when the log directory cannot be created', async () => {
    // A file where the directory should be — mkdir must fail.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not-a-directory');
    const logger = createLogger({ dir: blocked, file: join(blocked, 'x.log') });

    expect(() => logger.log('error', 'still alive')).not.toThrow();
    expect(() => logger.logSync('error', 'still alive')).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

describe('logSync', () => {
  it('writes immediately — the exit-handler contract', () => {
    const logger = createLogger({ dir, file });
    logger.logSync('info', 'Detach: process exiting');
    // No flush, no await: it must already be on disk.
    expect(read(file)).toContain('Detach: process exiting');
  });

  it('respects the level gate like log() does', () => {
    const logger = createLogger({ dir, file });
    logger.logSync('debug', 'noisy');
    expect(read(file)).not.toContain('noisy');
  });
});
