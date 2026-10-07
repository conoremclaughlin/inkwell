/**
 * get_thread_messages with no sbSlug reads as the caller (debug:inkling-first-reply),
 * through the REAL identity chain: request context, getEffectiveSlug and
 * resolveCallerIdentity. Only the data layer is faked. The handler suite mocks
 * getEffectiveSlug as a pass-through, which hid that the real one, given no
 * slug, returns the context's routing hint ahead of the token (Lumen, #763 r1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn(async () => ({ user: { id: 'user-123' }, resolvedBy: 'userId' })),
  };
});
// The handler's first lookup is the caller's identity. Stopping there with the
// slug it was given is all these cases need to observe.
vi.mock('./caller-principal', () => ({
  assertWriteRole: () => undefined,
  resolveCallerWorkspace: vi.fn(),
  resolveCallerSb: vi.fn(async (_c: unknown, _userId: string, sbSlug: string) => {
    throw new Error(`READ_AS:${sbSlug}`);
  }),
}));

import { runWithRequestContext } from '../../utils/request-context';
import { handleGetThreadMessages } from './thread-handlers';

const composer = { getClient: () => ({}) } as never;

async function readAs(context: Record<string, unknown>, args: Record<string, unknown> = {}) {
  return runWithRequestContext(context as never, async () => {
    try {
      const result = await handleGetThreadMessages(
        { email: 'test@example.com', threadKey: 'chat:conversation-1', ...args },
        composer
      );
      return { refused: JSON.parse(result.content[0].text) as { success: boolean; error: string } };
    } catch (error) {
      const match = /^READ_AS:(.*)$/.exec((error as Error).message);
      if (!match) throw error;
      return { readAs: match[1] };
    }
  });
}

describe('get_thread_messages with no sbSlug, through the real identity chain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a bound token reads as its own identity, not the context’s routing hint', async () => {
    expect(
      await readAs({ agentTokenBound: true, tokenSlug: 'kindle-a1', sbSlug: 'an-enriched-hint' })
    ).toEqual({ readAs: 'kindle-a1' });
  });

  it('a user token reads as the identity its session context names', async () => {
    expect(await readAs({ sbSlug: 'kindle-b2', sessionId: 's-1' })).toEqual({
      readAs: 'kindle-b2',
    });
  });

  it('refuses, and says what to pass, when the request carries no identity at all', async () => {
    const result = await readAs({ sessionId: 's-1' });
    expect(result.refused?.success).toBe(false);
    expect(result.refused?.error).toMatch(/Pass sbSlug/);
  });

  it('an explicit slug keeps the existing pinning rule', async () => {
    // Unchanged behaviour: over HTTP the pin is the context's slug, which wins
    // over the explicit one when identity pinning is enforced.
    expect(
      await readAs({ sbSlug: 'kindle-c3', sessionId: 's-1' }, { sbSlug: 'kindle-c3' })
    ).toEqual({ readAs: 'kindle-c3' });
  });
});
