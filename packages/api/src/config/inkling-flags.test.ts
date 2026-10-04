import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AWAKEN_CAP,
  DEFAULT_TURN_CAP,
  inklingAwakenCap,
  inklingOwnerTestAllowlist,
  inklingOwnerTestUserIds,
  inklingTurnCap,
  inklingTurnTimeoutMs,
  isInklingOwnerTestUser,
} from './inkling-flags';

describe('inklingTurnTimeoutMs', () => {
  it('is no ceiling unless INKLING_TURN_TIMEOUT_MS is a positive whole number', () => {
    expect(inklingTurnTimeoutMs({})).toBeUndefined();
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: '' })).toBeUndefined();
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: 'soon' })).toBeUndefined();
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: '-5' })).toBeUndefined();
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: '90000' })).toBe(90_000);
  });
});

describe('inklingTurnCap', () => {
  it('is 20 unless INKLING_TURN_CAP is a positive whole number', () => {
    expect(DEFAULT_TURN_CAP).toBe(20);
    expect(inklingTurnCap({})).toBe(20);
    expect(inklingTurnCap({ INKLING_TURN_CAP: '3' })).toBe(3);
    for (const raw of ['0', '-1', 'lots', '1.5']) {
      expect(inklingTurnCap({ INKLING_TURN_CAP: raw })).toBe(20);
    }
  });
});

describe('inklingOwnerTestAllowlist', () => {
  // Letters in the ids, so that their case can differ at all.
  const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const TESTER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const ids = (source: Record<string, string | undefined>) => [...inklingOwnerTestUserIds(source)];

  it('is off unless it names a user: unset, blank, 1, true and junk are all off', () => {
    for (const raw of [undefined, '', '  ', '1', 'true', 'on', 'owner', '*', `${OWNER}x`]) {
      expect(ids({ INKLING_OWNER_TEST_USER_ID: raw }), String(raw)).toEqual([]);
      expect(ids({ INKLING_OWNER_TEST_USER_IDS: raw }), String(raw)).toEqual([]);
    }
  });

  it('still honours the single account the test began with, in lowercase', () => {
    expect(ids({ INKLING_OWNER_TEST_USER_ID: ` ${OWNER.toUpperCase()} ` })).toEqual([OWNER]);
  });

  it('lists accounts, comma-separated, joined with the single one, each once', () => {
    expect(ids({ INKLING_OWNER_TEST_USER_IDS: ` ${TESTER.toUpperCase()} , ${OWNER}` })).toEqual([
      TESTER,
      OWNER,
    ]);
    expect(
      ids({ INKLING_OWNER_TEST_USER_IDS: `${TESTER},${OWNER}`, INKLING_OWNER_TEST_USER_ID: OWNER })
    ).toEqual([TESTER, OWNER]);
    expect(ids({ INKLING_OWNER_TEST_USER_IDS: TESTER, INKLING_OWNER_TEST_USER_ID: OWNER })).toEqual(
      [TESTER, OWNER]
    );
  });

  it('leaves out an entry that is not a whole UUID, and says where without saying what', () => {
    const allowlist = inklingOwnerTestAllowlist({
      INKLING_OWNER_TEST_USER_IDS: `${OWNER}, *,${TESTER.slice(0, -1)}, ,${TESTER}`,
      INKLING_OWNER_TEST_USER_ID: 'everyone',
    });
    expect([...allowlist.userIds]).toEqual([OWNER, TESTER]);
    // Entry 4 is blank: a stray comma, not a mistake.
    expect(allowlist.malformed).toEqual([
      'INKLING_OWNER_TEST_USER_IDS entry 2',
      'INKLING_OWNER_TEST_USER_IDS entry 3',
      'INKLING_OWNER_TEST_USER_ID',
    ]);
    expect(allowlist.malformed.join(' ')).not.toContain(TESTER.slice(0, 8));
  });
});

describe('isInklingOwnerTestUser', () => {
  const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const TESTER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const SOMEONE = '22222222-2222-4222-8222-222222222222';

  it('is true for every listed account in any letter case, and for nobody else', () => {
    const allowlist = inklingOwnerTestUserIds({
      INKLING_OWNER_TEST_USER_IDS: `${OWNER},${TESTER}`,
    });
    expect(isInklingOwnerTestUser(OWNER, allowlist)).toBe(true);
    expect(isInklingOwnerTestUser(OWNER.toUpperCase(), allowlist)).toBe(true);
    expect(isInklingOwnerTestUser(TESTER, allowlist)).toBe(true);
    expect(isInklingOwnerTestUser(SOMEONE, allowlist)).toBe(false);
  });

  it('is false for everyone while the test is off', () => {
    for (const userId of [OWNER, SOMEONE, '']) {
      expect(isInklingOwnerTestUser(userId, new Set()), userId).toBe(false);
    }
  });
});

describe('inklingAwakenCap', () => {
  it('is 2 when unset or blank', () => {
    expect(DEFAULT_AWAKEN_CAP).toBe(2);
    expect(inklingAwakenCap({})).toBe(2);
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: '  ' })).toBe(2);
  });

  it('takes a positive whole number', () => {
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: '5' })).toBe(5);
    expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: ' 1 ' })).toBe(1);
  });

  it('falls back to 2 for anything else, never to no cap', () => {
    for (const raw of ['0', '-3', '2.5', 'many', 'Infinity']) {
      expect(inklingAwakenCap({ INKLING_AWAKEN_CAP: raw })).toBe(2);
    }
  });
});
