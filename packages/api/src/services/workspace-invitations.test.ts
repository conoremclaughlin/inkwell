import { describe, expect, it } from 'vitest';
import {
  emailInvitesHonoured,
  InvitationAttemptLimiter,
  invitationDigest,
  invitationStatus,
  isInviteOnly,
  newInvitationCode,
  normalizeInvitationCode,
  workspaceNameFrom,
} from './workspace-invitations';

describe('invitation codes', () => {
  it('are ten Crockford characters, shown as two groups of five, and different each time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newInvitationCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('read the same however they are typed', () => {
    expect(normalizeInvitationCode('k7qf2-m9xrt')).toBe('K7QF2M9XRT');
    expect(normalizeInvitationCode(' K7QF2 M9XRT ')).toBe('K7QF2M9XRT');
    // The letters people mistake for digits read as the digits.
    expect(normalizeInvitationCode('O7QFI-M9XRL')).toBe('07QF1M9XR1');
  });

  it('refuse anything that cannot be a code', () => {
    for (const input of ['', 'K7QF2', 'K7QF2-M9XRT-1', 'K7QF2-M9XRU', 42, null, undefined]) {
      expect(normalizeInvitationCode(input), String(input)).toBeNull();
    }
  });

  it('are stored only as a digest, which a typed variant matches', () => {
    const code = newInvitationCode();
    const digest = invitationDigest(normalizeInvitationCode(code)!);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(code.replace('-', ''));
    expect(invitationDigest(normalizeInvitationCode(code.toLowerCase())!)).toBe(digest);
  });
});

describe('how an invitation stands', () => {
  const NOW = Date.parse('2026-10-06T21:00:00Z');
  const row = (patch: Record<string, unknown> = {}) => ({
    kind: 'code',
    revoked_at: null,
    expires_at: '2026-11-05T21:00:00Z',
    max_uses: null,
    use_count: 0,
    ...patch,
  });

  it('is pending, revoked, used up or expired, in that order of precedence', () => {
    expect(invitationStatus(row(), NOW)).toBe('pending');
    expect(invitationStatus(row({ use_count: 40 }), NOW)).toBe('pending');
    expect(invitationStatus(row({ max_uses: 3, use_count: 3 }), NOW)).toBe('used');
    expect(invitationStatus(row({ expires_at: '2026-10-06T20:59:59Z' }), NOW)).toBe('expired');
    expect(
      invitationStatus(row({ revoked_at: '2026-10-06T20:00:00Z', max_uses: 1, use_count: 1 }), NOW)
    ).toBe('revoked');
  });
});

describe('attempts per account', () => {
  it('allows twenty in ten minutes, then waits, and counts each account apart', () => {
    const limiter = new InvitationAttemptLimiter();
    const start = 1_000_000;
    for (let i = 0; i < 20; i++) expect(limiter.allow('account-a', start + i)).toBe(true);
    expect(limiter.allow('account-a', start + 21)).toBe(false);
    expect(limiter.allow('account-b', start + 21)).toBe(true);
    // Ten minutes after the first try, room opens again.
    expect(limiter.allow('account-a', start + 10 * 60 * 1000)).toBe(true);
  });
});

describe('group names and modes', () => {
  it('takes a trimmed name of 1–80 characters', () => {
    expect(workspaceNameFrom('  The Smiths  ')).toBe('The Smiths');
    expect(workspaceNameFrom('')).toBeNull();
    expect(workspaceNameFrom('   ')).toBeNull();
    expect(workspaceNameFrom('x'.repeat(81))).toBeNull();
    expect(workspaceNameFrom('🏡'.repeat(80))).toBe('🏡'.repeat(80));
    expect(workspaceNameFrom(7)).toBeNull();
  });

  it('marks a group as invite-only only by its explicit mode', () => {
    expect(isInviteOnly({ membershipMode: 'invite_only' })).toBe(true);
    expect(isInviteOnly({})).toBe(false);
    expect(isInviteOnly(null)).toBe(false);
    expect(isInviteOnly({ membershipMode: 'open' })).toBe(false);
  });
});

describe('email invitations', () => {
  it('are honoured only when the operator says sign-up confirms addresses', () => {
    expect(emailInvitesHonoured({ INVITE_EMAIL_OWNERSHIP_CONFIRMED: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      expect(emailInvitesHonoured({ INVITE_EMAIL_OWNERSHIP_CONFIRMED: value }), String(value)).toBe(
        false
      );
    }
  });
});
