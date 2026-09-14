/**
 * Identity Enforcement Utility
 *
 * Returns the effective sbSlug for WRITE operations, enforcing identity
 * pinning when enabled. Read/query operations should NOT use this — they
 * need to freely specify sbSlug as a filter parameter.
 *
 * Feature flag: ENFORCE_IDENTITY_PINNING (env var, default: 'true')
 *   'true'  — pinned identity overrides explicit sbSlug on writes
 *   'false' — logs warnings but allows explicit sbSlug (warn-only mode)
 */

import { getPinnedSlug } from '../utils/request-context';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Returns the effective sbSlug for a write operation.
 *
 * - If identity is pinned (via bootstrap or token), returns the pinned value
 *   (or the explicit value if enforcement is disabled via feature flag).
 * - If no identity is pinned (human user, pre-bootstrap), returns the explicit value.
 */
export function getEffectiveSlug(explicitSlug?: string): string | undefined {
  const pinned = getPinnedSlug();
  if (!pinned) return explicitSlug;

  if (explicitSlug && explicitSlug !== pinned) {
    const enforced = env.ENFORCE_IDENTITY_PINNING !== 'false';
    logger.warn('Agent identity mismatch detected', {
      claimed: explicitSlug,
      authenticated: pinned,
      enforced,
    });

    if (!enforced) {
      return explicitSlug; // Feature flag off: warn but allow
    }
  }

  return pinned;
}
