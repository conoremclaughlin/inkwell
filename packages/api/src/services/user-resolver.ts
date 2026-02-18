import { z } from 'zod';
import type { DataComposer } from '../data/composer';
import type { User } from '../data/models/user.model';
import { logger } from '../utils/logger';
import { getUserFromContext } from '../utils/request-context';

/**
 * Base schema for user identification fields.
 * Use this for extending with additional fields (it's a plain ZodObject).
 */
export const userIdentifierFields = {
  // Direct UUID lookup
  userId: z
    .string()
    .uuid()
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
 * Resolves a user from various identifiers.
 * Tries identifiers in priority order: userId > email > platform > phone
 *
 * If no explicit identifiers are provided, falls back to:
 * - Request context (from web dashboard JWT auth)
 * - Session context (from bootstrap() call)
 */
export async function resolveUser(
  identifier: UserIdentifier,
  dataComposer: DataComposer
): Promise<ResolvedUser | null> {
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

  // 1. Try userId first (most specific)
  if (effectiveIdentifier.userId) {
    const user = await usersRepo.findById(effectiveIdentifier.userId);
    if (user) {
      logger.debug(`User resolved by userId: ${effectiveIdentifier.userId}`);
      return { user, resolvedBy: 'userId' };
    }
  }

  // 2. Try email
  if (effectiveIdentifier.email) {
    const user = await usersRepo.findByEmail(effectiveIdentifier.email);
    if (user) {
      logger.debug(`User resolved by email: ${effectiveIdentifier.email}`);
      return { user, resolvedBy: 'email' };
    }
  }

  // 3. Try platform + platformId
  if (effectiveIdentifier.platform && effectiveIdentifier.platformId) {
    const user = await usersRepo.findByPlatformId(
      effectiveIdentifier.platform,
      effectiveIdentifier.platformId
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
    const user = await usersRepo.findByPhoneNumber(effectiveIdentifier.phone);
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
