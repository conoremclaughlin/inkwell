import { z } from 'zod';

export const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NOTIFICATION_BODY_LIMIT = 48 * 1024;
export const notificationDeviceTimeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000_000);

// PostgreSQL text/jsonb cannot represent NUL or an unpaired surrogate.
// Unicode-mode matching leaves valid surrogate pairs (such as emoji) intact.
// Refuse, never rewrite, so the stored preview stays exactly what was sent.
const databaseText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value));

// App identifiers are exact, case-sensitive values, never globs or expressions.
export const notificationPackageSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/);

export const notificationPackagesSchema = z
  .array(notificationPackageSchema)
  .min(1)
  .max(50)
  .refine((packages) => new Set(packages).size === packages.length);

/** No owner, watcher, destination, or action can be asserted by an event. */
export const notificationEventSchema = z
  .object({
    eventId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    packageName: notificationPackageSchema,
    appLabel: databaseText(255).optional(),
    title: databaseText(512),
    text: databaseText(8192),
    postedAt: notificationDeviceTimeSchema,
  })
  .strict();

export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/**
 * The send-time sample is transport metadata, never part of an event's
 * identity. Sample it again on every retry, from the same epoch-ms wall clock
 * as postedAt and consent's deviceTime (never a monotonic clock).
 */
export const notificationIntakeSchema = notificationEventSchema.extend({
  deviceTime: notificationDeviceTimeSchema,
});

/** Literal matching only. Arbitrary scripts belong to a separately approved runner. */
export const notificationRuleSchema = z
  .object({
    packageName: notificationPackageSchema,
    match: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z
        .object({
          kind: z.literal('contains'),
          field: z.enum(['title', 'text']),
          value: databaseText(512).refine((value) => value.trim().length > 0),
          caseSensitive: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();

export type NotificationRule = z.infer<typeof notificationRuleSchema>;
export const notificationRulesSchema = z.array(notificationRuleSchema).max(20);
export const updateNotificationRulesSchema = z.object({ rules: notificationRulesSchema }).strict();

/** The person consents through the existing signed-in transport, not a device token. */
export const createNotificationWatcherSchema = z
  .object({
    installationId: z.string().uuid(),
    recipientId: z.string().uuid(),
    // The mobile conversation identifier is a thread key, resolved in owner/workspace scope.
    conversationId: databaseText(255).min(1),
    deviceTime: notificationDeviceTimeSchema,
    refreshToken: z.string().min(1).max(2048),
    selectedPackages: notificationPackagesSchema,
    // No automatic matching at consent. Rules are a separate owner-managed resource.
    rules: notificationRulesSchema.length(0),
    disclosureAccepted: z.literal(true),
    // A report by the phone, not server attestation of an OS permission.
    permissionReported: z.literal('granted'),
  })
  .strict();

export type CreateNotificationWatcher = z.infer<typeof createNotificationWatcherSchema>;

export type NotificationRefusal =
  | 'invalid_event'
  | 'access_inactive'
  | 'app_not_selected'
  | 'event_before_consent'
  | 'event_expired'
  | 'event_from_future'
  | 'clock_resync_required';

export type NotificationAdmission =
  | { ok: true; event: NotificationEvent; expiresAt: number }
  | { ok: false; reason: NotificationRefusal };
