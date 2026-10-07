import { describe, expect, it } from 'vitest';
import { inklingTurnRefusal, type InklingIdentity } from './inkling-turn-gate';

const OWNER = '11111111-1111-4111-8111-111111111111';

describe('inklingTurnRefusal, with more than one account in the owner test', () => {
  const TESTER = '22222222-2222-4222-8222-222222222222';
  const both = new Set([OWNER, TESTER]);
  const inklingOf = (userId: string): InklingIdentity => ({
    kind: 'inkling',
    id: 'sb-inkling',
    userId,
    metadata: { client: 'inkling-mobile', ownerTest: true },
  });

  it("starts each listed account's own inkling, on its own account, for its own message", () => {
    for (const owner of [OWNER, TESTER]) {
      const input = { identity: inklingOf(owner), userId: owner, ownerMessage: 'yes' as const };
      expect(inklingTurnRefusal(input, both), owner).toBeNull();
    }
  });

  it("never runs one listed account's inkling on another listed account", () => {
    const input = { identity: inklingOf(TESTER), userId: OWNER, ownerMessage: 'yes' as const };
    expect(inklingTurnRefusal(input, both)).toMatchObject({ retryable: false });
  });

  it('refuses an inkling whose owner is off the list, and every inkling while the list is empty', () => {
    const input = { identity: inklingOf(TESTER), userId: TESTER, ownerMessage: 'yes' as const };
    expect(inklingTurnRefusal(input, new Set([OWNER]))).toMatchObject({ retryable: false });
    expect(inklingTurnRefusal(input, new Set())).toEqual({
      reason: 'inklings are not open on this server',
      retryable: false,
    });
  });
});
