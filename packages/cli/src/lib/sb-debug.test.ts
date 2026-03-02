import { afterEach, describe, expect, it } from 'vitest';
import { isSbDebugEnabled, resolveSbDebugFile } from './sb-debug.js';

const originalSbDebug = process.env.SB_DEBUG;
const originalSbDebugFile = process.env.SB_DEBUG_FILE;

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
    process.env.SB_DEBUG_FILE = '/tmp/sb-debug.log';
    expect(isSbDebugEnabled()).toBe(true);
  });

  it('resolves file path from explicit arg, then env', () => {
    process.env.SB_DEBUG_FILE = '/tmp/from-env.log';
    expect(resolveSbDebugFile('/tmp/from-arg.log')).toBe('/tmp/from-arg.log');
    expect(resolveSbDebugFile()).toBe('/tmp/from-env.log');
  });
});
