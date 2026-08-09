import { describe, it, expect } from 'vitest';
import { serializeError } from './serialize-error.js';

describe('serializeError', () => {
  it('returns the message for Error instances', () => {
    expect(serializeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the error name when the message is empty', () => {
    expect(serializeError(new TypeError(''))).toBe('TypeError');
  });

  // Regression: Supabase/PostgREST rejections are plain objects, not Errors.
  // `String(error)` yielded "[object Object]" and the result carried the
  // useless string 'Unknown error', which hid a Postgres 22003 overflow behind
  // "[Trigger] SessionService failed: Unknown error".
  it('preserves PostgREST error detail instead of "[object Object]"', () => {
    const pgError = {
      code: '22003',
      details: null,
      hint: null,
      message: 'value "3441018986" is out of range for type integer',
    };

    const result = serializeError(pgError);

    expect(result).toContain('out of range for type integer');
    expect(result).toContain('code=22003');
    expect(result).not.toContain('[object Object]');
  });

  it('includes details and hint when present', () => {
    const result = serializeError({
      message: 'permission denied',
      code: '42501',
      details: 'for table users',
      hint: 'grant select',
    });

    expect(result).toBe(
      'permission denied | code=42501 | details=for table users | hint=grant select'
    );
  });

  it('omits empty PostgREST fields', () => {
    expect(serializeError({ message: 'plain failure', code: '', details: null })).toBe(
      'plain failure'
    );
  });

  it('JSON-stringifies objects that have no message field', () => {
    expect(serializeError({ status: 500, reason: 'upstream' })).toBe(
      '{"status":500,"reason":"upstream"}'
    );
  });

  it('never throws or returns "[object Object]" for circular objects', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const result = serializeError(circular);

    expect(result).toBe('Unserializable error object');
    expect(result).not.toContain('[object Object]');
  });

  it('handles strings, null, and undefined', () => {
    expect(serializeError('just a string')).toBe('just a string');
    expect(serializeError(null)).toBe('Unknown error');
    expect(serializeError(undefined)).toBe('Unknown error');
  });

  it('handles non-object primitives', () => {
    expect(serializeError(42)).toBe('42');
    expect(serializeError(false)).toBe('false');
  });

  it('truncates very long JSON payloads', () => {
    const big = { padding: 'x'.repeat(5000) };
    const result = serializeError(big);
    expect(result.length).toBeLessThan(600);
    expect(result.endsWith('…')).toBe(true);
  });
});
