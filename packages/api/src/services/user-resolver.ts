import { z } from 'zod';
import type { DataComposer } from '../data/composer';
import type { User } from '../data/models/user.model';
import { logger } from '../utils/logger';
import { getAuthenticatedPrincipal, getUserFromContext } from '../utils/request-context';
import { withSupabaseRetry } from '../utils/supabase-retry';

/**
 * Base schema for user identification fields.
 * Use this for extending with additional fields (it's a plain ZodObject).
 */
export const userIdentifierFields = {
  // Direct UUID lookup
  userId: z
    .string()
    .guid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),

  // Email lookup
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),

  // Phone lookup
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),

  // Platform-based lookup
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
};

/**
 * Base schema object (without refinement) - use this for extending
 */
export const userIdentifierBaseSchema = z.object(userIdentifierFields);

/**
 * Schema for flexible user identification with validation.
 * Supports multiple ways to identify a user:
 * 1. userId - direct UUID lookup
 * 2. email - lookup by email address
 * 3. phone - lookup by phone number (E.164 format)
 * 4. platform + platformId - lookup by platform-specific identifier
 */
export const userIdentifierSchema = userIdentifierBaseSchema.refine(
  (data) => {
    // Must have at least one identifier
    const hasUserId = !!data.userId;
    const hasEmail = !!data.email;
    const hasPhone = !!data.phone;
    const hasPlatform = !!data.platform && !!data.platformId;
    return hasUserId || hasEmail || hasPhone || hasPlatform;
  },
  {
    message: 'Must provide at least one identifier: userId, email, phone, or platform+platformId',
  }
);

export type UserIdentifier = z.infer<typeof userIdentifierBaseSchema>;

/**
 * Result of user resolution
 */
export interface ResolvedUser {
  user: User;
  resolvedBy: 'userId' | 'email' | 'phone' | 'platform';
}

/**
 * An explicit identifier named someone other than the authenticated caller.
 *
 * The message is the same whether or not the named account exists, and it
 * never repeats the identifier, so a refusal cannot be used to probe for
 * accounts.
 */
export class PrincipalMismatchError extends Error {
  constructor() {
    super(
      'The user identifier does not match the authenticated user. ' +
        'Omit userId, email, phone and platform to act as yourself.'
    );
    this.name = 'PrincipalMismatchError';
  }
}

type IdentifierKind = ResolvedUser['resolvedBy'];

/** The explicit identifiers present, in resolution priority order. */
function explicitIdentifierKinds(identifier: UserIdentifier): IdentifierKind[] {
  const kinds: IdentifierKind[] = [];
  if (identifier.userId) kinds.push('userId');
  if (identifier.email) kinds.push('email');
  if (identifier.platform && identifier.platformId) kinds.push('platform');
  if (identifier.phone) kinds.push('phone');
  return kinds;
}

function normalizeEmail(email: string | null | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Does this identifier name `user`? Each comparison mirrors the repository
 * lookup it replaces, so a caller's own identifier matches exactly when it
 * would have found their row. Email is compared case-insensitively, and also
 * against the email in the verified token, so a renamed account still matches
 * the identifier mergeWithContext fills in from that token.
 */
function identifierNamesUser(
  kind: IdentifierKind,
  identifier: UserIdentifier,
  user: User,
  principal: { userId: string; email?: string }
): boolean {
  switch (kind) {
    case 'userId':
      return identifier.userId === user.id;
    case 'email': {
      const email = normalizeEmail(identifier.email);
      return email === normalizeEmail(user.email) || email === normalizeEmail(principal.email);
    }
    case 'phone':
      return !!user.phone_number && identifier.phone === user.phone_number;
    case 'platform': {
      const platformId = identifier.platformId!;
      switch (identifier.platform) {
        case 'telegram':
          return user.telegram_id !== null && user.telegram_id === parseInt(platformId, 10);
        case 'whatsapp':
          return !!user.whatsapp_id && user.whatsapp_id === platformId;
        case 'discord':
          return !!user.discord_id && user.discord_id === platformId;
        default:
          return false;
      }
    }
  }
}

function refuseIdentifier(
  principal: { userId: string },
  identifier: UserIdentifier,
  mismatched: IdentifierKind[]
): never {
  logger.warn('Refused a user identifier that does not name the authenticated principal', {
    principalUserId: principal.userId,
    mismatched,
    ...(mismatched.includes('userId') ? { requestedUserId: identifier.userId } : {}),
  });
  throw new PrincipalMismatchError();
}

/**
 * Resolve the caller when the request carries an authenticated principal.
 *
 * The principal is who the call acts as. Explicit identifiers are still
 * accepted, because many callers pass their own, but every one of them must
 * name the principal or the call is refused. Only the principal's own row is
 * read: another account is never looked up.
 */
async function resolveAuthenticatedUser(
  identifier: UserIdentifier,
  principal: { userId: string; email?: string },
  dataComposer: DataComposer
): Promise<ResolvedUser | null> {
  const kinds = explicitIdentifierKinds(identifier);

  // Settled without a read, so a foreign userId costs no lookup at all.
  if (identifier.userId && identifier.userId !== principal.userId) {
    refuseIdentifier(principal, identifier, ['userId']);
  }

  const user = await withSupabaseRetry(
    () => dataComposer.repositories.users.findById(principal.userId),
    { label: 'resolveUser.findById' }
  );
  if (!user) {
    // A verified token for a user row that no longer exists. Falling back to
    // the token's email could land on a different row provisioned since.
    logger.warn('Authenticated principal has no user row', { principalUserId: principal.userId });
    return null;
  }

  const mismatched = kinds.filter(
    (kind) => !identifierNamesUser(kind, identifier, user, principal)
  );
  if (mismatched.length > 0) refuseIdentifier(principal, identifier, mismatched);

  return { user, resolvedBy: kinds[0] ?? 'userId' };
}

/**
 * Resolves a user from various identifiers.
 * Tries identifiers in priority order: userId > email > platform > phone
 *
 * With an authenticated principal in the request context, resolves that
 * principal and refuses any explicit identifier that names someone else
 * (PrincipalMismatchError).
 *
 * Without one, explicit identifiers resolve directly, and if none are given
 * it falls back to:
 * - Request context (from web dashboard JWT auth)
 * - Session context (from bootstrap() call), outside a request only
 */
export async function resolveUser(
  identifier: UserIdentifier,
  dataComposer: DataComposer
): Promise<ResolvedUser | null> {
  const principal = getAuthenticatedPrincipal();
  if (principal) return resolveAuthenticatedUser(identifier, principal, dataComposer);

  const usersRepo = dataComposer.repositories.users;

  // Merge with context if no explicit identifiers provided
  const hasExplicitIdentifier = !!(
    identifier.userId ||
    identifier.email ||
    identifier.phone ||
    (identifier.platform && identifier.platformId)
  );

  let effectiveIdentifier = identifier;

  if (!hasExplicitIdentifier) {
    // Try to get user from request/session context
    const contextUser = getUserFromContext();
    if (contextUser) {
      logger.debug('Using user identifier from context', {
        hasUserId: !!contextUser.userId,
        hasEmail: !!contextUser.email,
      });
      effectiveIdentifier = {
        ...identifier,
        userId: identifier.userId || contextUser.userId,
        email: identifier.email || contextUser.email,
        platform: identifier.platform || (contextUser.platform as typeof identifier.platform),
        platformId: identifier.platformId || contextUser.platformId,
      };
    }
  }

  // Each lookup is wrapped in withSupabaseRetry so a transient PostgREST
  // 503 / DB connection blip doesn't immediately fail the request and
  // doesn't get instantly retried by upstream callers (which on 2026-04-19
  // amplified a brownout into a 47GB Kong log spiral). The shared circuit
  // breaker also short-circuits the rest of the pipeline once the DB
  // really is down.

  // 1. Try userId first (most specific)
  if (effectiveIdentifier.userId) {
    const user = await withSupabaseRetry(() => usersRepo.findById(effectiveIdentifier.userId!), {
      label: 'resolveUser.findById',
    });
    if (user) {
      logger.debug(`User resolved by userId: ${effectiveIdentifier.userId}`);
      return { user, resolvedBy: 'userId' };
    }
  }

  // 2. Try email
  if (effectiveIdentifier.email) {
    const user = await withSupabaseRetry(() => usersRepo.findByEmail(effectiveIdentifier.email!), {
      label: 'resolveUser.findByEmail',
    });
    if (user) {
      logger.debug(`User resolved by email: ${effectiveIdentifier.email}`);
      return { user, resolvedBy: 'email' };
    }
  }

  // 3. Try platform + platformId
  if (effectiveIdentifier.platform && effectiveIdentifier.platformId) {
    const user = await withSupabaseRetry(
      () =>
        usersRepo.findByPlatformId(effectiveIdentifier.platform!, effectiveIdentifier.platformId!),
      { label: 'resolveUser.findByPlatformId' }
    );
    if (user) {
      logger.debug(
        `User resolved by ${effectiveIdentifier.platform}: ${effectiveIdentifier.platformId}`
      );
      return { user, resolvedBy: 'platform' };
    }
  }

  // 4. Try phone number
  if (effectiveIdentifier.phone) {
    const user = await withSupabaseRetry(
      () => usersRepo.findByPhoneNumber(effectiveIdentifier.phone!),
      { label: 'resolveUser.findByPhoneNumber' }
    );
    if (user) {
      logger.debug(`User resolved by phone: ${effectiveIdentifier.phone}`);
      return { user, resolvedBy: 'phone' };
    }
  }

  logger.warn('User not found with provided identifiers', { identifier: effectiveIdentifier });
  return null;
}

/**
 * Resolves a user or throws an error if not found.
 */
export async function resolveUserOrThrow(
  identifier: UserIdentifier,
  dataComposer: DataComposer
): Promise<ResolvedUser> {
  const result = await resolveUser(identifier, dataComposer);

  if (!result) {
    const identifierDescription = describeIdentifier(identifier);
    throw new Error(`User not found: ${identifierDescription}`);
  }

  return result;
}

/**
 * Creates a human-readable description of the identifier used.
 */
function describeIdentifier(identifier: UserIdentifier): string {
  const parts: string[] = [];

  if (identifier.userId) parts.push(`userId=${identifier.userId}`);
  if (identifier.email) parts.push(`email=${identifier.email}`);
  if (identifier.phone) parts.push(`phone=${identifier.phone}`);
  if (identifier.platform && identifier.platformId) {
    parts.push(`${identifier.platform}=${identifier.platformId}`);
  }

  return parts.join(', ') || 'no identifiers provided';
}
