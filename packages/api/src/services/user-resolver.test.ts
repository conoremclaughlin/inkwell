import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveUser } from './user-resolver';
import { resetSharedBreakerForTests } from '../utils/supabase-retry';

// getUserFromContext is a hard dependency on AsyncLocalStorage; stub it out.
vi.mock('../utils/request-context', () => ({
  getUserFromContext: vi.fn().mockReturnValue(undefined),
}));

function makeDc(usersRepo: unknown) {
  return {
    repositories: { users: usersRepo },
  } as unknown as Parameters<typeof resolveUser>[1];
}

describe('resolveUser — retry integration', () => {
  beforeEach(() => {
    resetSharedBreakerForTests();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  it('retries a transient 503 from findById and succeeds on the second try', async () => {
    const user = { id: 'u1', email: 'a@b.co' };
    const findById = vi
      .fn()
      .mockRejectedValueOnce({ status: 503, message: 'service unavailable' })
      .mockResolvedValueOnce(user);

    const result = await resolveUser({ userId: 'u1' } as any, makeDc({ findById }));

    expect(result).toEqual({ user, resolvedBy: 'userId' });
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it('does not retry a PGRST116 "not found" (non-transient); returns null', async () => {
    // usersRepo normalizes PGRST116 to null via handleError path — the
    // repository catches and returns null, so resolveUser sees null, not throw.
    const findById = vi.fn().mockResolvedValue(null);
    const findByEmail = vi.fn().mockResolvedValue(null);
    const result = await resolveUser(
      { userId: 'missing', email: 'nope@example.com' } as any,
      makeDc({ findById, findByEmail })
    );
    expect(result).toBeNull();
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findByEmail).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-transient error without retrying', async () => {
    const err = { status: 400, message: 'bad request' };
    const findById = vi.fn().mockRejectedValue(err);
    await expect(resolveUser({ userId: 'u1' } as any, makeDc({ findById }))).rejects.toEqual(err);
    expect(findById).toHaveBeenCalledTimes(1);
  });
});
