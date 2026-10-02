/**
 * Principal enforcement for user resolution (security G0.1).
 *
 * An authenticated request carries its principal in the request context: the
 * MCP route sets it from a verified bearer token (or a verified session), and
 * the admin middleware from a verified admin token. Before this change an
 * explicit userId/email/phone/platform argument resolved directly, so a caller
 * authenticated as one account could act as another by naming it. Lumen's
 * source-level probe at 916b0369 showed four of six paths selecting the other
 * account; the first six cases below are those paths.
 *
 * Every person here is invented, and the repository is a mock: no database,
 * no token, no request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUser, resolveUserOrThrow, PrincipalMismatchError } from './user-resolver';
import {
  clearSessionContext,
  mergeWithContext,
  runWithRequestContext,
  setSessionContext,
} from '../utils/request-context';
import { resetSharedBreakerForTests } from '../utils/supabase-retry';

const ALPHA = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alpha@example.com',
  phone_number: '+15555550101',
  telegram_id: 100200300,
  whatsapp_id: '15555550101',
  discord_id: '900800700',
  slack_id: null,
};
const BETA = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'beta@example.com',
  phone_number: '+15555550102',
  telegram_id: 100200301,
  whatsapp_id: '15555550102',
  discord_id: '900800701',
  slack_id: null,
};
const NOBODY_ID = '33333333-3333-4333-8333-333333333333';
const USERS = [ALPHA, BETA];

function makeRepo() {
  return {
    findById: vi.fn(async (id: string) => USERS.find((u) => u.id === id) ?? null),
    findByEmail: vi.fn(async (email: string) => USERS.find((u) => u.email === email) ?? null),
    findByPhoneNumber: vi.fn(
      async (phone: string) => USERS.find((u) => u.phone_number === phone) ?? null
    ),
    findByPlatformId: vi.fn(async (platform: string, platformId: string | number) => {
      if (platform === 'telegram') {
        return USERS.find((u) => u.telegram_id === Number(platformId)) ?? null;
      }
      if (platform === 'whatsapp') return USERS.find((u) => u.whatsapp_id === platformId) ?? null;
      if (platform === 'discord') return USERS.find((u) => u.discord_id === platformId) ?? null;
      return null;
    }),
  };
}

type Repo = ReturnType<typeof makeRepo>;

function makeDc(repo: Repo) {
  return { repositories: { users: repo } } as unknown as Parameters<typeof resolveUser>[1];
}

/** The authenticated slice the MCP route puts in context for a bearer token. */
const ALPHA_PRINCIPAL = { userId: ALPHA.id, email: ALPHA.email };

function asAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(ALPHA_PRINCIPAL, fn) as Promise<T>;
}

/** Every lookup the resolver made, by repository method. */
function lookups(repo: Repo) {
  return {
    byId: repo.findById.mock.calls.map((c) => c[0]),
    byEmail: repo.findByEmail.mock.calls.map((c) => c[0]),
    byPhone: repo.findByPhoneNumber.mock.calls.map((c) => c[0]),
    byPlatform: repo.findByPlatformId.mock.calls.map((c) => c[1]),
  };
}

let repo: Repo;
let dc: ReturnType<typeof makeDc>;

beforeEach(() => {
  resetSharedBreakerForTests();
  clearSessionContext();
  repo = makeRepo();
  dc = makeDc(repo);
});

afterEach(() => {
  clearSessionContext();
});

describe('resolveUser with an authenticated principal — the probe cases', () => {
  it('no explicit identifier resolves the principal (control)', async () => {
    const result = await asAlpha(() => resolveUser({}, dc));
    expect(result?.user.id).toBe(ALPHA.id);
  });

  it("refuses another account's userId passed directly", async () => {
    await expect(asAlpha(() => resolveUser({ userId: BETA.id }, dc))).rejects.toBeInstanceOf(
      PrincipalMismatchError
    );
  });

  it("refuses another account's userId passed through mergeWithContext", async () => {
    await expect(
      asAlpha(() => resolveUser(mergeWithContext({ userId: BETA.id }), dc))
    ).rejects.toBeInstanceOf(PrincipalMismatchError);
  });

  it("refuses another account's email passed directly", async () => {
    await expect(asAlpha(() => resolveUser({ email: BETA.email }, dc))).rejects.toBeInstanceOf(
      PrincipalMismatchError
    );
  });

  it("refuses another account's email even when the merged userId is the principal's", async () => {
    // Before the fix this quietly resolved the principal and ignored the
    // email. An explicit identifier naming someone else is a refusal, not a
    // hint to drop.
    await expect(
      asAlpha(() => resolveUser(mergeWithContext({ email: BETA.email }), dc))
    ).rejects.toBeInstanceOf(PrincipalMismatchError);
  });

  it('refuses a missing userId with another account’s email as the fallback', async () => {
    await expect(
      asAlpha(() => resolveUser(mergeWithContext({ userId: NOBODY_ID, email: BETA.email }), dc))
    ).rejects.toBeInstanceOf(PrincipalMismatchError);
  });
});

describe('resolveUser with an authenticated principal — every identifier kind', () => {
  it.each([
    ['phone', { phone: BETA.phone_number }],
    ['telegram id', { platform: 'telegram' as const, platformId: String(BETA.telegram_id) }],
    ['whatsapp id', { platform: 'whatsapp' as const, platformId: BETA.whatsapp_id }],
    ['discord id', { platform: 'discord' as const, platformId: BETA.discord_id }],
  ])("refuses another account's %s", async (_kind, identifier) => {
    await expect(asAlpha(() => resolveUser(identifier, dc))).rejects.toBeInstanceOf(
      PrincipalMismatchError
    );
  });

  it('refuses when one identifier is the principal’s and another names someone else', async () => {
    await expect(
      asAlpha(() => resolveUser({ userId: ALPHA.id, email: BETA.email }, dc))
    ).rejects.toBeInstanceOf(PrincipalMismatchError);
    await expect(
      asAlpha(() => resolveUser({ email: ALPHA.email, phone: BETA.phone_number }, dc))
    ).rejects.toBeInstanceOf(PrincipalMismatchError);
  });

  it('never looks up another account: a refusal reads only the principal’s own row', async () => {
    await asAlpha(() =>
      resolveUser(
        {
          userId: BETA.id,
          email: BETA.email,
          phone: BETA.phone_number,
          platform: 'discord',
          platformId: BETA.discord_id,
        },
        dc
      )
    ).catch(() => undefined);
    expect(lookups(repo)).toEqual({ byId: [], byEmail: [], byPhone: [], byPlatform: [] });

    await asAlpha(() => resolveUser({ email: BETA.email }, dc)).catch(() => undefined);
    expect(lookups(repo)).toEqual({ byId: [ALPHA.id], byEmail: [], byPhone: [], byPlatform: [] });
  });

  it('refuses an account that exists and one that does not with the same error', async () => {
    const existing = await asAlpha(() => resolveUser({ userId: BETA.id }, dc)).catch((e) => e);
    const missing = await asAlpha(() => resolveUser({ userId: NOBODY_ID }, dc)).catch((e) => e);
    expect(existing).toBeInstanceOf(PrincipalMismatchError);
    expect(missing).toBeInstanceOf(PrincipalMismatchError);
    expect(existing.message).toBe(missing.message);
    expect(existing.message).not.toContain(BETA.id);
    expect(existing.message).not.toContain(NOBODY_ID);
  });

  it('resolveUserOrThrow refuses rather than returning another account', async () => {
    await expect(asAlpha(() => resolveUserOrThrow({ userId: BETA.id }, dc))).rejects.toBeInstanceOf(
      PrincipalMismatchError
    );
  });
});

describe('resolveUser with an authenticated principal — same-user identifiers still work', () => {
  it.each([
    ['userId', { userId: ALPHA.id }, 'userId'],
    ['email', { email: ALPHA.email }, 'email'],
    ['email in another case', { email: 'Alpha@Example.COM' }, 'email'],
    ['phone', { phone: ALPHA.phone_number }, 'phone'],
    [
      'telegram id',
      { platform: 'telegram' as const, platformId: String(ALPHA.telegram_id) },
      'platform',
    ],
    ['whatsapp id', { platform: 'whatsapp' as const, platformId: ALPHA.whatsapp_id }, 'platform'],
    ['discord id', { platform: 'discord' as const, platformId: ALPHA.discord_id }, 'platform'],
    [
      'every identifier at once',
      {
        userId: ALPHA.id,
        email: ALPHA.email,
        phone: ALPHA.phone_number,
        platform: 'discord' as const,
        platformId: ALPHA.discord_id,
      },
      'userId',
    ],
  ])('resolves the principal from its own %s', async (_label, identifier, resolvedBy) => {
    const result = await asAlpha(() => resolveUser(identifier, dc));
    expect(result).toEqual({ user: ALPHA, resolvedBy });
  });

  it('resolves the principal through mergeWithContext with its own email', async () => {
    const result = await asAlpha(() => resolveUser(mergeWithContext({ email: ALPHA.email }), dc));
    expect(result?.user.id).toBe(ALPHA.id);
  });

  it('accepts the email carried by the verified token even after the row’s email changed', async () => {
    // mergeWithContext fills email from the token; a renamed account must not
    // lock its own caller out.
    const renamed = { ...ALPHA, email: 'alpha.renamed@example.com' };
    repo.findById.mockImplementation(async (id: string) => (id === ALPHA.id ? renamed : null));
    const result = await asAlpha(() => resolveUser(mergeWithContext({}), dc));
    expect(result?.user.id).toBe(ALPHA.id);
  });

  it('returns null when the principal’s own row is gone, without falling back to its email', async () => {
    // The email lookup would still find a row here; a stale token must not be
    // re-pointed at whatever row carries its email now.
    repo.findById.mockResolvedValue(null);
    expect(await asAlpha(() => resolveUser({}, dc))).toBeNull();
    expect(await asAlpha(() => resolveUser({ userId: ALPHA.id }, dc))).toBeNull();
  });

  it('ignores a platform without a platformId, as before', async () => {
    const result = await asAlpha(() => resolveUser({ platform: 'telegram' }, dc));
    expect(result?.user.id).toBe(ALPHA.id);
  });
});

describe('resolveUser inside a request with no authenticated principal', () => {
  it('does not inherit the process-global context another client bootstrapped', async () => {
    // HTTP serves many clients in one process. bootstrap writes a process-
    // global context; a request that authenticated as nobody must not become
    // whoever bootstrapped last.
    setSessionContext({ userId: BETA.id, email: BETA.email });
    const result = await runWithRequestContext({}, () => resolveUser({}, dc));
    expect(result).toBeNull();
    expect(repo.findById).not.toHaveBeenCalled();
  });
});

describe('resolveUser with no request context at all (internal and stdio callers)', () => {
  it('resolves an explicit identifier directly, unchanged', async () => {
    const result = await resolveUser({ userId: BETA.id }, dc);
    expect(result?.user.id).toBe(BETA.id);
  });

  it('falls back to the stdio session context set by bootstrap, unchanged', async () => {
    setSessionContext({ userId: BETA.id, email: BETA.email });
    const result = await resolveUser({}, dc);
    expect(result?.user.id).toBe(BETA.id);
  });
});
