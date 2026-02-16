/**
 * Identity Enforcement Utility
 *
 * Returns the effective agentId for WRITE operations, enforcing identity
 * pinning when enabled. Read/query operations should NOT use this — they
 * need to freely specify agentId as a filter parameter.
 *
 * Feature flag: ENFORCE_IDENTITY_PINNING (env var, default: 'true')
 *   'true'  — pinned identity overrides explicit agentId on writes
 *   'false' — logs warnings but allows explicit agentId (warn-only mode)
 */

import { getPinnedAgentId } from '../utils/request-context';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Returns the effective agentId for a write operation.
 *
 * - If identity is pinned (via bootstrap or token), returns the pinned value
 *   (or the explicit value if enforcement is disabled via feature flag).
 * - If no identity is pinned (human user, pre-bootstrap), returns the explicit value.
 */
export function getEffectiveAgentId(explicitAgentId?: string): string | undefined {
  const pinned = getPinnedAgentId();
  if (!pinned) return explicitAgentId;

  if (explicitAgentId && explicitAgentId !== pinned) {
    const enforced = env.ENFORCE_IDENTITY_PINNING !== 'false';
    logger.warn('Agent identity mismatch detected', {
      claimed: explicitAgentId,
      authenticated: pinned,
      enforced,
    });

    if (!enforced) {
      return explicitAgentId; // Feature flag off: warn but allow
    }
  }

  return pinned;
}
