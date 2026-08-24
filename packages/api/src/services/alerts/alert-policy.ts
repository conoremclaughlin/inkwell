/**
 * Alert policy — the pure decisions, kept free of I/O so they can be tested
 * without a database, a channel, or a network.
 *
 * Everything here answers one of four questions:
 *   - is this payload well-formed?          parseAlertPayload
 *   - should the human hear about it now?   shouldNotifyUser
 *   - which webhooks want it?               webhookMatches
 *   - has a source gone quiet?              sourceStaleness
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Default re-notify window for an unchanged condition. */
export const DEFAULT_COOLDOWN_SECONDS = 3600;

/**
 * Conor's standing rule, set with Myra on 2026-08-20 after the disk hit 100%
 * overnight: below 4 GB free on any check, wake him regardless of hour.
 * Encoded here so the threshold lives in one place rather than only in a
 * shell script, and so the bypass is a property of severity, not of the
 * particular monitor that happens to be reporting.
 */
export const WAKE_REGARDLESS_SEVERITY: AlertSeverity = 'critical';

const severityRank: Record<AlertSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

export function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  return severityRank[a] - severityRank[b];
}

// ── Payload ───────────────────────────────────────────────────────────────

export const alertPayloadSchema = z.object({
  /** Stable slug identifying the checker, e.g. 'disk-monitor'. */
  source: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'source must be a lowercase slug'),
  severity: z.enum(ALERT_SEVERITIES).default('warning'),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).optional(),
  /**
   * Identifies the condition, not the occurrence. Two posts sharing a
   * dedupeKey are the same ongoing incident. Defaults to source:title, which
   * is right for a monitor that words its title consistently and wrong for
   * one that embeds a changing number — hence the explicit field.
   */
  dedupeKey: z.string().min(1).max(200).optional(),
  metrics: z.record(z.unknown()).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  /**
   * 'ok' resolves an open incident for this dedupeKey and sends a recovery
   * notice; 'alerting' raises or re-raises it.
   */
  status: z.enum(['alerting', 'ok']).default('alerting'),
  /** SB ids to notify. Empty array explicitly means "notify no SBs". */
  notifyAgents: z.array(z.string().min(1).max(64)).max(16).optional(),
  /** Set false to record the condition without notifying the human. */
  notifyUser: z.boolean().optional(),
});

export type AlertPayload = z.infer<typeof alertPayloadSchema>;

export interface ParsedAlert extends AlertPayload {
  dedupeKey: string;
  cooldownSeconds: number;
}

export function parseAlertPayload(input: unknown): ParsedAlert {
  const parsed = alertPayloadSchema.parse(input);
  return {
    ...parsed,
    dedupeKey: parsed.dedupeKey ?? `${parsed.source}:${parsed.title}`,
    cooldownSeconds: parsed.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
  };
}

// ── Quiet hours ───────────────────────────────────────────────────────────

export interface QuietHours {
  /** 'HH:MM' local to `timezone`. */
  start: string;
  end: string;
  timezone: string;
}

/**
 * Minutes since local midnight for `at` in `timezone`. Uses Intl rather than
 * manual offset maths so DST is handled by the platform.
 */
export function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl can render midnight as 24 in some locales/options combinations.
  return (hour % 24) * 60 + minute;
}

function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function isWithinQuietHours(at: Date, quiet: QuietHours): boolean {
  const start = parseHhMm(quiet.start);
  const end = parseHhMm(quiet.end);
  // An unparseable window must not silence anything. Failing open is the
  // correct direction for an alarm: a spurious ping is recoverable, a
  // swallowed outage is not.
  if (start === null || end === null || start === end) return false;

  let now: number;
  try {
    now = localMinutes(at, quiet.timezone);
  } catch {
    return false;
  }

  // Windows that cross midnight (22:00 → 07:00) are the normal case.
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export interface NotifyUserDecision {
  notify: boolean;
  reason: 'suppressed-by-caller' | 'quiet-hours' | 'severity-override' | 'normal';
}

/**
 * Whether to wake the human. Critical bypasses quiet hours by design: the
 * standing agreement is that a near-full disk wakes him regardless of hour,
 * and an alarm that politely waits until morning is not an alarm.
 */
export function shouldNotifyUser(params: {
  severity: AlertSeverity;
  at: Date;
  quietHours?: QuietHours | null;
  notifyUser?: boolean;
}): NotifyUserDecision {
  if (params.notifyUser === false) {
    return { notify: false, reason: 'suppressed-by-caller' };
  }
  if (!params.quietHours) {
    return { notify: true, reason: 'normal' };
  }
  if (!isWithinQuietHours(params.at, params.quietHours)) {
    return { notify: true, reason: 'normal' };
  }
  if (compareSeverity(params.severity, WAKE_REGARDLESS_SEVERITY) >= 0) {
    return { notify: true, reason: 'severity-override' };
  }
  return { notify: false, reason: 'quiet-hours' };
}

// ── Outbound webhook matching ─────────────────────────────────────────────

export interface WebhookFilter {
  enabled: boolean;
  /** Empty means no filter — all severities. */
  severities: string[];
  /** Empty means no filter — all sources. */
  sources: string[];
}

export function webhookMatches(
  webhook: WebhookFilter,
  event: { severity: AlertSeverity; source: string }
): boolean {
  if (!webhook.enabled) return false;
  if (webhook.severities.length > 0 && !webhook.severities.includes(event.severity)) {
    return false;
  }
  if (webhook.sources.length > 0 && !webhook.sources.includes(event.source)) {
    return false;
  }
  return true;
}

// ── Signing ───────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 over `${timestamp}.${body}`. The timestamp is inside the signed
 * material so a captured request cannot be replayed later with a fresh
 * header — receivers reject signatures whose timestamp is outside a tolerance
 * window.
 */
export function signWebhookPayload(secret: string, body: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
}

export function verifyWebhookSignature(params: {
  secret: string;
  body: string;
  timestampMs: number;
  signature: string;
  toleranceMs?: number;
  now?: number;
}): boolean {
  const tolerance = params.toleranceMs ?? 5 * 60 * 1000;
  const now = params.now ?? Date.now();
  if (Math.abs(now - params.timestampMs) > tolerance) return false;

  const expected = signWebhookPayload(params.secret, params.body, params.timestampMs);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(params.signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time compare for the ingest shared secret. */
export function secretsMatch(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Staleness ─────────────────────────────────────────────────────────────

export interface SourceLiveness {
  source: string;
  lastSeenAt: string | Date | null;
  expectedIntervalSeconds: number | null;
  stalenessGraceFactor: number;
  staleAlertedAt: string | Date | null;
}

export type StalenessVerdict =
  | { stale: false; reason: 'no-promise' | 'fresh' | 'never-seen' }
  | { stale: true; alreadyAlerted: boolean; silentForSeconds: number };

/**
 * A source that stops reporting is the failure this whole system exists to
 * catch: an empty result and a broken pipe are indistinguishable from the
 * inside. Silence only becomes a signal once the source has promised a
 * cadence — which is why expectedIntervalSeconds is a deliberate opt-in.
 *
 * A source that has never checked in is NOT stale. It has made a promise it
 * has not yet had the chance to keep, and alarming on registration would
 * train everyone to ignore the alarm.
 */
export function sourceStaleness(source: SourceLiveness, now: Date): StalenessVerdict {
  if (!source.expectedIntervalSeconds) return { stale: false, reason: 'no-promise' };
  if (!source.lastSeenAt) return { stale: false, reason: 'never-seen' };

  const lastSeen = new Date(source.lastSeenAt).getTime();
  if (Number.isNaN(lastSeen)) return { stale: false, reason: 'never-seen' };

  const silentForSeconds = Math.floor((now.getTime() - lastSeen) / 1000);
  const budget = source.expectedIntervalSeconds * Math.max(source.stalenessGraceFactor, 1);
  if (silentForSeconds < budget) return { stale: false, reason: 'fresh' };

  // Re-alarm only after the source has been seen again; one incident per
  // silence, not one per sweep.
  const alreadyAlerted =
    source.staleAlertedAt != null && new Date(source.staleAlertedAt).getTime() >= lastSeen;

  return { stale: true, alreadyAlerted, silentForSeconds };
}
