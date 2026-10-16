import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  NOTIFICATION_CLOCK_SKEW_MS,
  NOTIFICATION_RETENTION_MS,
  notificationEventSchema,
  notificationPackagesSchema,
  notificationRuleSchema,
  type NotificationAdmission,
  type NotificationEvent,
} from './contract';

export interface NotificationAccessState {
  /** Read from current server state, never from the request body. */
  status: 'active' | 'paused' | 'revoked';
  selectedPackages: readonly string[];
  /** A new grant/selection epoch must not drain a queue from older consent. */
  activeSince: number;
  expiresAt: number;
}

/**
 * Pure intake policy. The caller must first resolve an opaque credential to
 * its live grant and authenticated owner. This does not authenticate requests,
 * check account liveness, or authorize a model/chat reader.
 */
export function admitNotification(
  raw: unknown,
  access: NotificationAccessState | null,
  now: number
): NotificationAdmission {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !access ||
    access.status !== 'active' ||
    !Number.isSafeInteger(access.activeSince) ||
    access.activeSince < 0 ||
    access.activeSince > now ||
    !Number.isSafeInteger(access.expiresAt) ||
    access.expiresAt <= now ||
    !notificationPackagesSchema.safeParse(access.selectedPackages).success
  ) {
    return { ok: false, reason: 'access_inactive' };
  }
  const parsed = notificationEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_event' };
  const event = parsed.data;
  if (!access.selectedPackages.includes(event.packageName)) {
    return { ok: false, reason: 'app_not_selected' };
  }
  if (event.postedAt < access.activeSince) {
    return { ok: false, reason: 'event_before_consent' };
  }
  if (event.postedAt > now + NOTIFICATION_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'event_from_future' };
  }
  // Delayed delivery does not buy another seven days. A slightly fast device
  // clock cannot extend retention beyond seven days from the first receipt.
  const expiresAt = Math.min(event.postedAt, now) + NOTIFICATION_RETENTION_MS;
  if (expiresAt <= now) return { ok: false, reason: 'event_expired' };
  return { ok: true, event, expiresAt };
}

/** Re-check current consent/expiry before matching; stored events are not authority. */
export function notificationMatches(
  event: NotificationEvent,
  rule: unknown,
  access: NotificationAccessState | null,
  now: number,
  storedExpiresAt: number
): boolean {
  if (!Number.isSafeInteger(storedExpiresAt) || storedExpiresAt <= now) return false;
  const admitted = admitNotification(event, access, now);
  const parsed = notificationRuleSchema.safeParse(rule);
  if (!admitted.ok || !parsed.success || parsed.data.packageName !== event.packageName) {
    return false;
  }
  const { match } = parsed.data;
  if (match.kind === 'all') return true;
  const text = event[match.field];
  return match.caseSensitive
    ? text.includes(match.value)
    : text.toLowerCase().includes(match.value.toLowerCase());
}

/** Stable content fingerprint for identical retry versus conflicting event-id reuse. */
export function notificationFingerprint(event: NotificationEvent): string {
  return createHash('sha256')
    .update(JSON.stringify([event.packageName, event.title, event.text, event.postedAt]))
    .digest('hex');
}

const DEVICE_TOKEN = /^ink-na-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** An opaque credential, deliberately not an MCP or admin JWT. Return it only at issuance. */
export function issueNotificationDeviceToken(): { token: string; digest: string } {
  const token = `ink-na-${randomBytes(32).toString('hex')}`;
  return { token, digest: notificationDeviceTokenDigest(token)! };
}

/** Return null before a store lookup for every foreign or malformed credential. */
export function notificationDeviceTokenDigest(token: unknown): string | null {
  if (typeof token !== 'string' || !DEVICE_TOKEN.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

export function notificationDeviceTokenMatches(token: unknown, digest: unknown): boolean {
  const actual = notificationDeviceTokenDigest(token);
  if (!actual || typeof digest !== 'string' || !SHA256.test(digest)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex'));
}
