import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AWAKEN_CAP,
  DEFAULT_TURN_CAP,
  DEFAULT_TURN_TIMEOUT_MS,
  inklingAwakenCap,
  inklingOwnerTestUserId,
  inklingTurnCap,
  inklingTurnTimeoutMs,
  isInklingOwnerTestUser,
} from './inkling-flags';

describe('inklingTurnTimeoutMs', () => {
  it('is five minutes unless INKLING_TURN_TIMEOUT_MS is a positive whole number', () => {
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(300_000);
    expect(inklingTurnTimeoutMs({})).toBe(300_000);
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(inklingTurnTimeoutMs({ INKLING_TURN_TIMEOUT_MS: 'soon' })).toBe(300_000);
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

describe('inklingOwnerTestUserId', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';

  it('is off unless it names a user: unset, blank, 1, true and junk are all off', () => {
    for (const raw of [undefined, '', '  ', '1', 'true', 'on', 'owner', `${OWNER}x`]) {
      expect(inklingOwnerTestUserId({ INKLING_OWNER_TEST_USER_ID: raw })).toBeNull();
    }
  });

  it('names one user, in lowercase', () => {
    expect(inklingOwnerTestUserId({ INKLING_OWNER_TEST_USER_ID: ` ${OWNER} ` })).toBe(OWNER);
    expect(inklingOwnerTestUserId({ INKLING_OWNER_TEST_USER_ID: OWNER.toUpperCase() })).toBe(OWNER);
  });
});

describe('isInklingOwnerTestUser', () => {
  // Letters in the id, so that its case can differ at all.
  const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const SOMEONE = '22222222-2222-4222-8222-222222222222';

  it("is true for the test's account in any letter case, and for nobody else", () => {
    expect(isInklingOwnerTestUser(OWNER, OWNER)).toBe(true);
    expect(isInklingOwnerTestUser(OWNER.toUpperCase(), OWNER)).toBe(true);
    expect(isInklingOwnerTestUser(OWNER, OWNER.toUpperCase())).toBe(true);
    expect(isInklingOwnerTestUser(SOMEONE, OWNER)).toBe(false);
  });

  it('is false for everyone while the test is off', () => {
    for (const userId of [OWNER, SOMEONE, '']) {
      expect(isInklingOwnerTestUser(userId, null), userId).toBe(false);
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
