import { z } from 'zod';

export const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NOTIFICATION_BODY_LIMIT = 48 * 1024;

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
    title: databaseText(512),
    text: databaseText(8192),
    postedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  })
  .strict();

export type NotificationEvent = z.infer<typeof notificationEventSchema>;

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

/** The person consents through the existing signed-in transport, not a device token. */
export const createNotificationWatcherSchema = z
  .object({
    installationId: z.string().uuid(),
    recipientId: z.string().uuid(),
    conversationId: z.string().uuid(),
    refreshToken: z.string().min(1).max(2048),
    selectedPackages: notificationPackagesSchema,
    rules: z.array(notificationRuleSchema).min(1).max(20),
    disclosureAccepted: z.literal(true),
    // A report by the phone, not server attestation of an OS permission.
    permissionReported: z.literal('granted'),
  })
  .strict()
  .refine((input) =>
    input.rules.every((rule) => input.selectedPackages.includes(rule.packageName))
  );

export type CreateNotificationWatcher = z.infer<typeof createNotificationWatcherSchema>;

export type NotificationRefusal =
  | 'invalid_event'
  | 'access_inactive'
  | 'app_not_selected'
  | 'event_before_consent'
  | 'event_expired'
  | 'event_from_future';

export type NotificationAdmission =
  | { ok: true; event: NotificationEvent; expiresAt: number }
  | { ok: false; reason: NotificationRefusal };
