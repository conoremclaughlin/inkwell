import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSbDebug, isSbDebugEnabled, resolveSbDebugFile, sbDebugLog } from './sb-debug.js';

const originalSbDebug = process.env.SB_DEBUG;
const originalSbDebugFile = process.env.SB_DEBUG_FILE;

beforeEach(() => {
  // Isolate from env — some tests depend on SB_DEBUG being absent
  delete process.env.SB_DEBUG;
  delete process.env.SB_DEBUG_FILE;
});

afterEach(() => {
  if (originalSbDebug === undefined) delete process.env.SB_DEBUG;
  else process.env.SB_DEBUG = originalSbDebug;

  if (originalSbDebugFile === undefined) delete process.env.SB_DEBUG_FILE;
  else process.env.SB_DEBUG_FILE = originalSbDebugFile;
});

describe('sb-debug helpers', () => {
  it('enables debug when explicit flag is true', () => {
    delete process.env.SB_DEBUG;
    delete process.env.SB_DEBUG_FILE;
    expect(isSbDebugEnabled(true)).toBe(true);
  });

  it('enables debug from env toggles', () => {
    process.env.SB_DEBUG = 'true';
    delete process.env.SB_DEBUG_FILE;
    expect(isSbDebugEnabled()).toBe(true);

    process.env.SB_DEBUG = '0';
    process.env.SB_DEBUG_FILE = '/tmp/from-env.log';
    expect(isSbDebugEnabled()).toBe(true);
  });

  it('resolves file path from explicit arg, then env', () => {
    process.env.SB_DEBUG_FILE = '/tmp/from-env.log';
    expect(resolveSbDebugFile('/tmp/from-arg.log')).toBe('/tmp/from-arg.log');
    expect(resolveSbDebugFile()).toBe('/tmp/from-env.log');
  });

  it('writes debug records only when enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-debug-test-'));
    const logFile = join(dir, 'sb-debug.log');

    sbDebugLog('test', 'before_enabled', { a: 1 }, { file: logFile });
    expect(() => readFileSync(logFile, 'utf-8')).toThrow();

    initSbDebug({ enabled: true, file: logFile });
    sbDebugLog('test', 'after_enabled', { a: 2 });
    const written = readFileSync(logFile, 'utf-8');
    expect(written).toContain('"event":"debug_enabled"');
    expect(written).toContain('"event":"after_enabled"');
  });
});
