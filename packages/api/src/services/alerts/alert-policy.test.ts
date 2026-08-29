/**
 * Alert policy unit tests.
 *
 * These cover the decisions an alarm gets wrong in ways nobody notices: a
 * quiet-hours window that swallows a critical alert, a signature that still
 * verifies after the body is edited, a monitor whose silence reads as health.
 * Each of those failures is invisible from the inside — the system reports
 * nothing and looks calm — so they are asserted directly rather than inferred
 * from a happy path.
 */

import { describe, expect, it } from 'vitest';
import {
  compareSeverity,
  isWithinQuietHours,
  localMinutes,
  parseAlertPayload,
  secretsMatch,
  shouldNotifyUser,
  signWebhookPayload,
  sourceStaleness,
  verifyWebhookSignature,
  webhookMatches,
} from './alert-policy';

describe('parseAlertPayload', () => {
  it('derives a dedupe key from source and title when none is given', () => {
    const alert = parseAlertPayload({ source: 'disk-monitor', title: 'Disk low' });
    expect(alert.dedupeKey).toBe('disk-monitor:Disk low');
  });

  it('keeps an explicit dedupe key so a title carrying a changing number still collapses', () => {
    const a = parseAlertPayload({
      source: 'disk-monitor',
      title: 'Disk low: 9GB free',
      dedupeKey: 'disk-free-low',
    });
    const b = parseAlertPayload({
      source: 'disk-monitor',
      title: 'Disk low: 8GB free',
      dedupeKey: 'disk-free-low',
    });
    // Without this, every GB lost would open a brand-new incident.
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('defaults to warning severity and alerting status', () => {
    const alert = parseAlertPayload({ source: 'x', title: 'y' });
    expect(alert.severity).toBe('warning');
    expect(alert.status).toBe('alerting');
    expect(alert.cooldownSeconds).toBe(3600);
  });

  it('rejects a source that is not a lowercase slug', () => {
    expect(() => parseAlertPayload({ source: 'Disk Monitor', title: 'y' })).toThrow();
    expect(() => parseAlertPayload({ source: '', title: 'y' })).toThrow();
  });

  it('rejects a missing title', () => {
    expect(() => parseAlertPayload({ source: 'disk-monitor' })).toThrow();
  });

  it('distinguishes an empty notifyAgents list from an absent one', () => {
    expect(parseAlertPayload({ source: 'x', title: 'y', notifyAgents: [] }).notifyAgents).toEqual(
      []
    );
    expect(parseAlertPayload({ source: 'x', title: 'y' }).notifyAgents).toBeUndefined();
  });
});

describe('localMinutes', () => {
  it('converts UTC to minutes past local midnight in the target zone', () => {
    // 2026-08-24T22:40Z is 15:40 in Los Angeles (PDT, UTC-7).
    const at = new Date('2026-08-24T22:40:00Z');
    expect(localMinutes(at, 'America/Los_Angeles')).toBe(15 * 60 + 40);
    expect(localMinutes(at, 'UTC')).toBe(22 * 60 + 40);
  });

  it('renders local midnight as 0, not 1440', () => {
    // 07:00Z is midnight in Los Angeles during PDT.
    expect(localMinutes(new Date('2026-08-24T07:00:00Z'), 'America/Los_Angeles')).toBe(0);
  });
});

describe('isWithinQuietHours', () => {
  const quiet = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' };

  it('is inside a midnight-crossing window at 02:00 local', () => {
    // 09:00Z = 02:00 PDT.
    expect(isWithinQuietHours(new Date('2026-08-24T09:00:00Z'), quiet)).toBe(true);
  });

  it('is inside just after the start boundary', () => {
    // 05:30Z = 22:30 PDT the previous day.
    expect(isWithinQuietHours(new Date('2026-08-25T05:30:00Z'), quiet)).toBe(true);
  });

  it('is outside at the end boundary itself', () => {
    // 14:00Z = 07:00 PDT — the window is half-open, so 07:00 is awake.
    expect(isWithinQuietHours(new Date('2026-08-24T14:00:00Z'), quiet)).toBe(false);
  });

  it('is outside in the afternoon', () => {
    expect(isWithinQuietHours(new Date('2026-08-24T22:40:00Z'), quiet)).toBe(false);
  });

  it('handles a same-day window that does not cross midnight', () => {
    const day = { start: '09:00', end: '17:00', timezone: 'UTC' };
    expect(isWithinQuietHours(new Date('2026-08-24T12:00:00Z'), day)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-08-24T18:00:00Z'), day)).toBe(false);
  });

  it('fails open on an unparseable window rather than silencing everything', () => {
    // A malformed config must never become a mute button.
    expect(isWithinQuietHours(new Date(), { start: 'nope', end: '07:00', timezone: 'UTC' })).toBe(
      false
    );
    expect(isWithinQuietHours(new Date(), { start: '25:00', end: '07:00', timezone: 'UTC' })).toBe(
      false
    );
  });

  it('fails open on an unknown timezone', () => {
    expect(
      isWithinQuietHours(new Date(), { start: '22:00', end: '07:00', timezone: 'Mars/Olympus' })
    ).toBe(false);
  });

  it('treats a zero-length window as no window', () => {
    expect(isWithinQuietHours(new Date(), { start: '07:00', end: '07:00', timezone: 'UTC' })).toBe(
      false
    );
  });
});

describe('shouldNotifyUser', () => {
  const quietHours = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' };
  const at3amLocal = new Date('2026-08-24T10:00:00Z'); // 03:00 PDT

  it('wakes him at 3am for critical — the standing agreement', () => {
    const decision = shouldNotifyUser({ severity: 'critical', at: at3amLocal, quietHours });
    expect(decision.notify).toBe(true);
    expect(decision.reason).toBe('severity-override');
  });

  it('holds a warning during quiet hours', () => {
    const decision = shouldNotifyUser({ severity: 'warning', at: at3amLocal, quietHours });
    expect(decision.notify).toBe(false);
    expect(decision.reason).toBe('quiet-hours');
  });

  it('sends a warning outside quiet hours', () => {
    const decision = shouldNotifyUser({
      severity: 'warning',
      at: new Date('2026-08-24T22:40:00Z'),
      quietHours,
    });
    expect(decision.notify).toBe(true);
  });

  it('notifies when no quiet hours are configured', () => {
    expect(shouldNotifyUser({ severity: 'info', at: at3amLocal }).notify).toBe(true);
  });

  it('respects an explicit caller suppression even for critical', () => {
    const decision = shouldNotifyUser({
      severity: 'critical',
      at: at3amLocal,
      quietHours,
      notifyUser: false,
    });
    expect(decision.notify).toBe(false);
    expect(decision.reason).toBe('suppressed-by-caller');
  });
});

describe('compareSeverity', () => {
  it('orders info < warning < critical', () => {
    expect(compareSeverity('info', 'warning')).toBeLessThan(0);
    expect(compareSeverity('critical', 'warning')).toBeGreaterThan(0);
    expect(compareSeverity('warning', 'warning')).toBe(0);
  });
});

describe('webhookMatches', () => {
  const event = { severity: 'warning' as const, source: 'disk-monitor' };

  it('matches when no filters are set', () => {
    expect(webhookMatches({ enabled: true, severities: [], sources: [] }, event)).toBe(true);
  });

  it('never matches when disabled', () => {
    expect(webhookMatches({ enabled: false, severities: [], sources: [] }, event)).toBe(false);
  });

  it('filters by severity', () => {
    expect(webhookMatches({ enabled: true, severities: ['critical'], sources: [] }, event)).toBe(
      false
    );
    expect(
      webhookMatches({ enabled: true, severities: ['warning', 'critical'], sources: [] }, event)
    ).toBe(true);
  });

  it('filters by source', () => {
    expect(webhookMatches({ enabled: true, severities: [], sources: ['other'] }, event)).toBe(
      false
    );
    expect(
      webhookMatches({ enabled: true, severities: [], sources: ['disk-monitor'] }, event)
    ).toBe(true);
  });

  it('requires both filters to pass when both are set', () => {
    expect(
      webhookMatches({ enabled: true, severities: ['critical'], sources: ['disk-monitor'] }, event)
    ).toBe(false);
  });
});

describe('webhook signing', () => {
  const secret = 'shhh-a-secret';
  const body = JSON.stringify({ title: 'Disk low', severity: 'warning' });
  const now = 1_787_610_000_000;

  it('verifies a signature it just produced', () => {
    const signature = signWebhookPayload(secret, body, now);
    expect(verifyWebhookSignature({ secret, body, timestampMs: now, signature, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhookPayload(secret, body, now);
    const tampered = JSON.stringify({ title: 'Everything fine', severity: 'info' });
    expect(
      verifyWebhookSignature({ secret, body: tampered, timestampMs: now, signature, now })
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const signature = signWebhookPayload('other-secret', body, now);
    expect(verifyWebhookSignature({ secret, body, timestampMs: now, signature, now })).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const signature = signWebhookPayload(secret, body, now);
    // Same valid signature, presented an hour later.
    expect(
      verifyWebhookSignature({
        secret,
        body,
        timestampMs: now,
        signature,
        now: now + 60 * 60 * 1000,
      })
    ).toBe(false);
  });

  it('binds the timestamp into the signed material', () => {
    // A signature must not transfer to a different timestamp.
    const signature = signWebhookPayload(secret, body, now);
    expect(verifyWebhookSignature({ secret, body, timestampMs: now + 1000, signature, now })).toBe(
      false
    );
  });
});

describe('secretsMatch', () => {
  it('accepts an exact match', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects mismatches, including length differences', () => {
    expect(secretsMatch('abc123', 'abc124')).toBe(false);
    expect(secretsMatch('abc', 'abc123')).toBe(false);
  });

  it('rejects when either side is missing — an unset secret must not authenticate', () => {
    expect(secretsMatch(undefined, 'abc123')).toBe(false);
    expect(secretsMatch('abc123', undefined)).toBe(false);
    expect(secretsMatch(undefined, undefined)).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });
});

describe('sourceStaleness', () => {
  const now = new Date('2026-08-24T22:00:00Z');
  const base = {
    source: 'disk-monitor',
    expectedIntervalSeconds: 300,
    stalenessGraceFactor: 2,
    staleAlertedAt: null,
  };

  it('is not stale when the source made no cadence promise', () => {
    const verdict = sourceStaleness(
      { ...base, expectedIntervalSeconds: null, lastSeenAt: '2020-01-01T00:00:00Z' },
      now
    );
    expect(verdict).toEqual({ stale: false, reason: 'no-promise' });
  });

  it('is not stale before it has ever checked in', () => {
    // Alarming at registration would train everyone to ignore the alarm.
    const verdict = sourceStaleness({ ...base, lastSeenAt: null }, now);
    expect(verdict).toEqual({ stale: false, reason: 'never-seen' });
  });

  it('tolerates one missed run inside the grace factor', () => {
    // 400s of silence against a 300s promise and a 2x grace = 600s budget.
    const verdict = sourceStaleness({ ...base, lastSeenAt: '2026-08-24T21:53:20Z' }, now);
    expect(verdict.stale).toBe(false);
  });

  it('is stale once silence exceeds interval * grace', () => {
    // 700s of silence against a 600s budget.
    const verdict = sourceStaleness({ ...base, lastSeenAt: '2026-08-24T21:48:20Z' }, now);
    expect(verdict.stale).toBe(true);
    if (verdict.stale) {
      expect(verdict.alreadyAlerted).toBe(false);
      expect(verdict.silentForSeconds).toBe(700);
    }
  });

  it('reports alreadyAlerted when the alarm fired after the last sighting', () => {
    const verdict = sourceStaleness(
      {
        ...base,
        lastSeenAt: '2026-08-24T21:00:00Z',
        staleAlertedAt: '2026-08-24T21:30:00Z',
      },
      now
    );
    expect(verdict.stale).toBe(true);
    if (verdict.stale) expect(verdict.alreadyAlerted).toBe(true);
  });

  it('re-arms after the source is seen again', () => {
    // A stale mark older than the last sighting belongs to a previous
    // silence; the next disappearance must be allowed to alarm afresh.
    const verdict = sourceStaleness(
      {
        ...base,
        lastSeenAt: '2026-08-24T21:30:00Z',
        staleAlertedAt: '2026-08-24T21:00:00Z',
      },
      now
    );
    expect(verdict.stale).toBe(true);
    if (verdict.stale) expect(verdict.alreadyAlerted).toBe(false);
  });

  it('treats an unparseable last-seen as never seen rather than crashing', () => {
    const verdict = sourceStaleness({ ...base, lastSeenAt: 'not-a-date' }, now);
    expect(verdict).toEqual({ stale: false, reason: 'never-seen' });
  });

  it('clamps a grace factor below 1 so it cannot shorten the promised interval', () => {
    // The window that distinguishes clamped from unclamped: 200s of silence
    // against a 300s promise with a bogus 0.5 grace.
    //   clamped   -> budget 300s -> 200 < 300 -> fresh   (correct)
    //   unclamped -> budget 150s -> 200 >= 150 -> stale  (false alarm)
    // An assertion of `stale: true` here would hold either way and prove
    // nothing, which is what the first version of this test did.
    const verdict = sourceStaleness(
      { ...base, stalenessGraceFactor: 0.5, lastSeenAt: '2026-08-24T21:56:40Z' },
      now
    );
    expect(verdict).toEqual({ stale: false, reason: 'fresh' });
  });
});
