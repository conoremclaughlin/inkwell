import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CLOCK_SKEW_MS,
  NOTIFICATION_RETENTION_MS,
  notificationEventSchema,
  notificationPackagesSchema,
  notificationRuleSchema,
} from './contract';
import {
  admitNotification,
  admitNotificationIntake,
  issueNotificationDeviceToken,
  notificationDeviceTokenDigest,
  notificationDeviceTokenMatches,
  notificationFingerprint,
  notificationMatches,
  type NotificationAccessState,
} from './policy';

const NOW = Date.parse('2026-01-10T12:00:00Z');
const event = {
  eventId: '00000000-0000-4000-8000-000000000001',
  packageName: 'com.example.messages',
  title: 'Demo sender',
  text: 'The demo parcel is ready.',
  postedAt: NOW,
};
const access: NotificationAccessState = {
  status: 'active',
  selectedPackages: ['com.example.messages'],
  activeSince: NOW - 14 * 24 * 60 * 60 * 1000,
  expiresAt: NOW + NOTIFICATION_RETENTION_MS,
  clockOffsetMs: 0,
};
const rule = {
  packageName: event.packageName,
  match: { kind: 'contains', field: 'text', value: 'parcel', caseSensitive: false },
};

describe('request clock recovery', () => {
  it.each([
    -600_000,
    600_000,
    -8 * 86_400_000,
    8 * 86_400_000,
    -NOW - 1,
    NOW - 8_640_000_000_000_000,
  ])(
    'detects a corrected clock after offset %s while accepting the unchanged clock',
    (clockOffsetMs) => {
      const calibrated = { ...access, clockOffsetMs };
      const unchanged = {
        ...event,
        postedAt: NOW - clockOffsetMs,
        deviceTime: NOW - clockOffsetMs,
      };
      expect(admitNotificationIntake(unchanged, calibrated, NOW)).toMatchObject({ ok: true });
      expect(admitNotificationIntake({ ...event, deviceTime: NOW }, calibrated, NOW)).toEqual({
        ok: false,
        reason: 'clock_resync_required',
      });
      expect(calibrated.clockOffsetMs).toBe(clockOffsetMs);
    }
  );
  it('uses the event time for consent and expiry, not the current send sample', () => {
    const queued = { ...event, postedAt: NOW - 3_600_000 };
    const first = admitNotificationIntake({ ...queued, deviceTime: NOW }, access, NOW);
    const retry = admitNotificationIntake(
      { ...queued, deviceTime: NOW + 1000 },
      access,
      NOW + 1000
    );
    expect(first).toEqual(retry);
    expect(first).toEqual({
      ok: true,
      event: queued,
      expiresAt: queued.postedAt + NOTIFICATION_RETENTION_MS,
    });
    if (!first.ok || !retry.ok) throw new Error('Expected admitted fixture');
    expect(notificationFingerprint(first.event)).toBe(notificationFingerprint(retry.event));
    expect(notificationMatches(first.event, rule, access, NOW + 1000, first.expiresAt)).toBe(true);
    expect(
      admitNotificationIntake(
        { ...queued, postedAt: access.activeSince - 1, deviceTime: NOW },
        access,
        NOW
      )
    ).toEqual({ ok: false, reason: 'event_before_consent' });
    expect(
      admitNotificationIntake(
        { ...queued, postedAt: NOW - NOTIFICATION_RETENTION_MS, deviceTime: NOW },
        access,
        NOW
      )
    ).toEqual({ ok: false, reason: 'event_expired' });
  });
  it('does not let clock recovery mask inactive consent or an unselected package', () => {
    const changed = { ...event, deviceTime: NOW + 600_000 };
    expect(admitNotificationIntake(changed, { ...access, status: 'revoked' }, NOW)).toEqual({
      ok: false,
      reason: 'access_inactive',
    });
    expect(
      admitNotificationIntake(changed, { ...access, selectedPackages: ['com.example.other'] }, NOW)
    ).toEqual({
      ok: false,
      reason: 'app_not_selected',
    });
  });
  it('keeps the intake envelope strict instead of accepting event authority', () => {
    expect(
      admitNotificationIntake(
        { ...event, deviceTime: NOW, ownerId: 'synthetic-owner' },
        access,
        NOW
      )
    ).toEqual({
      ok: false,
      reason: 'invalid_event',
    });
    expect(notificationEventSchema.safeParse({ ...event, deviceTime: NOW }).success).toBe(false);
  });
});

describe('notification intake', () => {
  it.each([-90_000, 90_000])('calibrates a device clock offset of %s at consent', (offset) => {
    const calibrated = { ...access, activeSince: NOW, clockOffsetMs: offset };
    expect(admitNotification({ ...event, postedAt: NOW - offset }, calibrated, NOW)).toMatchObject({
      ok: true,
      expiresAt: NOW + NOTIFICATION_RETENTION_MS,
    });
    expect(admitNotification({ ...event, postedAt: NOW - offset - 1 }, calibrated, NOW)).toEqual({
      ok: false,
      reason: 'event_before_consent',
    });
    expect(
      admitNotification(
        { ...event, postedAt: NOW - offset + NOTIFICATION_CLOCK_SKEW_MS + 1 },
        calibrated,
        NOW
      )
    ).toEqual({ ok: false, reason: 'event_from_future' });
    expect(
      admitNotification(
        { ...event, postedAt: NOW - offset - NOTIFICATION_RETENTION_MS },
        { ...calibrated, activeSince: 0 },
        NOW
      )
    ).toEqual({ ok: false, reason: 'event_expired' });
  });

  it('treats app labels as bounded display text, not matching or package authority', () => {
    const labeled = { ...event, appLabel: 'A different app' };
    expect(admitNotification(labeled, access, NOW).ok).toBe(true);
    expect(notificationMatches(labeled, rule, access, NOW, NOW + 1)).toBe(true);
    expect(notificationFingerprint(labeled)).not.toBe(notificationFingerprint(event));
    for (const appLabel of ['x'.repeat(256), 'a\u0000b', '\ud83d'])
      expect(notificationEventSchema.safeParse({ ...event, appLabel }).success).toBe(false);
  });

  it('refuses corrupt calibration and out-of-range calibrated dates', () => {
    for (const clockOffsetMs of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
      expect(admitNotification(event, { ...access, clockOffsetMs }, NOW).ok).toBe(false);
    expect(
      admitNotification({ ...event, postedAt: 0 }, { ...access, clockOffsetMs: -1 }, NOW).ok
    ).toBe(false);
  });
  it('accepts only the selected app under active consent', () => {
    expect(admitNotification(event, access, NOW)).toEqual({
      ok: true,
      event,
      expiresAt: NOW + NOTIFICATION_RETENTION_MS,
    });
    expect(admitNotification({ ...event, packageName: 'com.example.other' }, access, NOW)).toEqual({
      ok: false,
      reason: 'app_not_selected',
    });
  });

  it.each([
    null,
    { ...access, status: 'paused' },
    { ...access, status: 'revoked' },
    { ...access, expiresAt: NOW },
    { ...access, expiresAt: NaN },
    { ...access, activeSince: NaN },
    { ...access, activeSince: NOW + 1 },
    { ...access, selectedPackages: [] },
    { ...access, selectedPackages: ['*'] },
  ])('fails closed for inactive or corrupt server state: %j', (state) => {
    expect(admitNotification(event, state as NotificationAccessState | null, NOW)).toEqual({
      ok: false,
      reason: 'access_inactive',
    });
  });

  it.each([NaN, Infinity, -1, NOW + 0.5])('refuses an invalid server clock %s', (now) => {
    expect(admitNotification(event, access, now).ok).toBe(false);
  });

  it('never imports notifications from before this consent epoch', () => {
    expect(
      admitNotification({ ...event, postedAt: NOW - 1 }, { ...access, activeSince: NOW }, NOW)
    ).toEqual({ ok: false, reason: 'event_before_consent' });
  });

  it('expires by posting time, including an exact seven-day boundary', () => {
    const postedAt = NOW - NOTIFICATION_RETENTION_MS;
    expect(admitNotification({ ...event, postedAt }, access, NOW)).toEqual({
      ok: false,
      reason: 'event_expired',
    });
    expect(admitNotification({ ...event, postedAt: postedAt + 1 }, access, NOW)).toMatchObject({
      ok: true,
      expiresAt: NOW + 1,
    });
  });

  it('bounds clock skew without extending retention', () => {
    expect(
      admitNotification({ ...event, postedAt: NOW + NOTIFICATION_CLOCK_SKEW_MS }, access, NOW)
    ).toMatchObject({ ok: true, expiresAt: NOW + NOTIFICATION_RETENTION_MS });
    expect(
      admitNotification({ ...event, postedAt: NOW + NOTIFICATION_CLOCK_SKEW_MS + 1 }, access, NOW)
    ).toEqual({ ok: false, reason: 'event_from_future' });
  });

  it.each(['ownerId', 'workspaceId', 'watcherId', 'destination', 'action'])(
    'refuses injected authority: %s',
    (key) => {
      expect(admitNotification({ ...event, [key]: 'synthetic-foreign' }, access, NOW)).toEqual({
        ok: false,
        reason: 'invalid_event',
      });
    }
  );

  it.each([
    { eventId: 'not-a-uuid' },
    { title: 'x'.repeat(513) },
    { text: 'x'.repeat(8193) },
    { packageName: 'com.example.*' },
    { postedAt: `${NOW}` },
    { postedAt: NaN },
    { postedAt: Infinity },
    { postedAt: -1 },
    { postedAt: NOW + 0.5 },
    { postedAt: 8_640_000_000_000_001 },
  ])('rejects malformed input without reflecting its contents: %j', (patch) => {
    expect(admitNotification({ ...event, ...patch }, access, NOW)).toEqual({
      ok: false,
      reason: 'invalid_event',
    });
  });

  it('accepts empty preview fields and preserves exact text', () => {
    expect(notificationEventSchema.parse({ ...event, title: '', text: '  demo\n' }).text).toBe(
      '  demo\n'
    );
  });

  it.each(['title', 'text'] as const)(
    'refuses NUL and lone surrogates in %s without rewriting content',
    (field) => {
      for (const value of ['a\u0000b', 'a\ud83d', '\ude00b', '\ude00\ud83d']) {
        expect(notificationEventSchema.safeParse({ ...event, [field]: value }).success).toBe(false);
      }
      for (const value of ['', 'a\ud83d\ude00b', '  demo\n\t', '\\u0000']) {
        expect(notificationEventSchema.parse({ ...event, [field]: value })[field]).toBe(value);
      }
    }
  );

  it('refuses unrepresentable literal rules while preserving valid Unicode', () => {
    for (const value of ['a\u0000b', '\ud83d', '\ude00']) {
      expect(
        notificationRuleSchema.safeParse({ ...rule, match: { ...rule.match, value } }).success
      ).toBe(false);
    }
    expect(
      notificationRuleSchema.safeParse({ ...rule, match: { ...rule.match, value: '\ud83d\ude00' } })
        .success
    ).toBe(true);
  });

  it('requires a bounded exact app selection, with no duplicates', () => {
    for (const apps of [
      [],
      ['*'],
      ['com.example.messages', 'com.example.messages'],
      Array.from({ length: 51 }, (_, i) => `com.example.app${i}`),
    ]) {
      expect(notificationPackagesSchema.safeParse(apps).success).toBe(false);
    }
  });
});

describe('plain notification matching', () => {
  const matches = (candidate: unknown) =>
    notificationMatches(event, candidate, access, NOW, NOW + 1);

  it('matches literal text, with explicit field and case sensitivity', () => {
    expect(matches(rule)).toBe(true);
    expect(matches({ ...rule, match: { ...rule.match, value: 'PARCEL' } })).toBe(true);
    expect(
      matches({ ...rule, match: { ...rule.match, value: 'PARCEL', caseSensitive: true } })
    ).toBe(false);
    expect(matches({ ...rule, match: { ...rule.match, field: 'title', value: 'Demo' } })).toBe(
      true
    );
    expect(matches({ ...rule, match: { ...rule.match, value: '.*' } })).toBe(false);
  });

  it('requires an explicit all rule instead of accidental empty-string matching', () => {
    expect(matches({ ...rule, match: { kind: 'all' } })).toBe(true);
    expect(matches({ ...rule, match: { ...rule.match, value: '' } })).toBe(false);
    expect(matches({ ...rule, match: { ...rule.match, value: ' ' } })).toBe(false);
    expect(matches({ ...rule, match: { ...rule.match, caseSensitive: undefined } })).toBe(false);
  });

  it('does not match another app, a revoked selection, or expired stored content', () => {
    expect(matches({ ...rule, packageName: 'com.example.other' })).toBe(false);
    expect(notificationMatches(event, rule, { ...access, status: 'revoked' }, NOW, NOW + 1)).toBe(
      false
    );
    expect(
      notificationMatches(
        event,
        rule,
        { ...access, selectedPackages: ['com.example.other'] },
        NOW,
        NOW + 1
      )
    ).toBe(false);
    expect(notificationMatches(event, rule, access, NOW, NOW)).toBe(false);
    expect(notificationMatches(event, rule, access, NOW, Infinity)).toBe(false);
  });

  it('does not accept code or destinations as a plain rule', () => {
    expect(notificationRuleSchema.safeParse({ ...rule, script: 'synthetic-only' }).success).toBe(
      false
    );
    expect(matches({ ...rule, match: { kind: 'script', source: 'synthetic-only' } })).toBe(false);
    expect(matches({ ...rule, destination: 'synthetic-group' })).toBe(false);
  });
});

describe('retry fingerprint and device credential', () => {
  it('hashes content independently of object key order and the event id', () => {
    expect(notificationFingerprint(event)).toBe(
      notificationFingerprint({
        text: event.text,
        title: event.title,
        postedAt: event.postedAt,
        packageName: event.packageName,
        eventId: '00000000-0000-4000-8000-000000000002',
      })
    );
    for (const patch of [
      { text: 'Changed' },
      { title: 'Changed' },
      { postedAt: NOW + 1 },
      { packageName: 'com.example.other' },
    ]) {
      expect(notificationFingerprint({ ...event, ...patch })).not.toBe(
        notificationFingerprint(event)
      );
    }
  });

  it('issues independent opaque credentials and matches their digests', () => {
    const first = issueNotificationDeviceToken();
    const second = issueNotificationDeviceToken();
    expect(first.token).not.toBe(second.token);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.digest).not.toContain(first.token);
    expect(notificationDeviceTokenMatches(first.token, first.digest)).toBe(true);
    expect(notificationDeviceTokenMatches(second.token, first.digest)).toBe(false);
  });

  it.each([
    null,
    undefined,
    {},
    '',
    'Bearer synthetic-token',
    'synthetic.jwt.token',
    'ink-na-short',
    `ink-na-${'g'.repeat(64)}`,
  ])('refuses foreign or malformed credentials before lookup: %j', (token) => {
    expect(notificationDeviceTokenDigest(token)).toBeNull();
    expect(notificationDeviceTokenMatches(token, '0'.repeat(64))).toBe(false);
  });

  it.each([null, '', 'short', 'g'.repeat(64)])('refuses malformed stored digests: %s', (digest) => {
    expect(notificationDeviceTokenMatches(issueNotificationDeviceToken().token, digest)).toBe(
      false
    );
  });
});
