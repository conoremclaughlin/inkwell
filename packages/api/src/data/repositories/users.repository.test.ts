import { describe, it, expect, vi } from 'vitest';
import { UsersRepository } from './users.repository';
import { isTransientSupabaseError } from '../../utils/supabase-retry';

/**
 * Regression test for the blocker Lumen flagged on PR #333:
 * `PostgrestError` only carries `{ message, details, hint, code }` — the
 * HTTP status lives on the response wrapper, and our repository used to
 * drop it on rethrow. That silently defeated the 5xx / 429 branch of
 * `isTransientSupabaseError`, so the retry wrapper only kicked in on
 * PostgREST-specific codes and network errors.
 */

function makeSingle(response: { data: unknown; error: unknown; status: number }): {
  single: () => Promise<{ data: unknown; error: unknown; status: number }>;
} {
  return { single: () => Promise.resolve(response) };
}

function mockClient(response: { data: unknown; error: unknown; status: number }) {
  // Minimal chain to satisfy .from().select().eq().single()
  const eqStub = makeSingle(response);
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue(eqStub),
      }),
    }),
  } as any;
}

describe('UsersRepository — preserves HTTP status on rethrow', () => {
  it('findById attaches status=503 to rethrown PostgrestError', async () => {
    const pgErr = { code: 'XX000', message: 'Service Unavailable', details: '', hint: '' };
    const repo = new UsersRepository(mockClient({ data: null, error: pgErr, status: 503 }));
    try {
      await repo.findById('u1');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Record<string, unknown>).status).toBe(503);
      expect((err as Record<string, unknown>).code).toBe('XX000');
      // And crucially: the retry classifier must now recognize it as transient.
      expect(isTransientSupabaseError(err)).toBe(true);
    }
  });

  it('findByEmail attaches status=429 to rethrown error', async () => {
    const pgErr = { code: 'XX000', message: 'Too Many Requests', details: '', hint: '' };
    const repo = new UsersRepository(mockClient({ data: null, error: pgErr, status: 429 }));
    try {
      await repo.findByEmail('a@b.co');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Record<string, unknown>).status).toBe(429);
      expect(isTransientSupabaseError(err)).toBe(true);
    }
  });

  it('does NOT throw on PGRST116 (not found) — returns null, no status attached', async () => {
    const pgErr = { code: 'PGRST116', message: 'not found', details: '', hint: '' };
    const repo = new UsersRepository(mockClient({ data: null, error: pgErr, status: 406 }));
    const result = await repo.findById('missing');
    expect(result).toBeNull();
  });

  it('findByPhoneNumber preserves status=500', async () => {
    const pgErr = { code: 'XX000', message: 'Internal', details: '', hint: '' };
    const repo = new UsersRepository(mockClient({ data: null, error: pgErr, status: 500 }));
    try {
      await repo.findByPhoneNumber('+15555555555');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Record<string, unknown>).status).toBe(500);
      expect(isTransientSupabaseError(err)).toBe(true);
    }
  });
});
