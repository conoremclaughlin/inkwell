import { logger } from '../utils/logger';

/**
 * The routing-hold boundary (spec: trigger-studio-routing §Refusing to route).
 *
 * Extracted from server.ts deliberately. The stamp call sat inline in the
 * trigger handler and silently drifted out of sync with the RPC signature
 * when the function gained `p_user_id` — PostgREST could not resolve it, so
 * EVERY refusal went unstamped, and the whole test suite stayed green because
 * nothing covered that call site (Lumen, PR #514 round 4).
 *
 * A module with its own tests makes the argument shape a checked contract
 * rather than a comment. If these functions change signature again, the
 * boundary tests fail before production does.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RoutingHoldDetail {
  triedCallerRepo: boolean;
  callerRepoRoot?: string | null;
}

export interface StampHoldArgs {
  threadId: string;
  userId: string;
  agentId: string;
  /** When this delivery attempt began — its generation. */
  attemptStartedAt: string;
  detail: RoutingHoldDetail;
  now?: string;
}

export interface ClearHoldArgs {
  threadId: string;
  userId: string;
  agentId: string;
  /** When the successful route began; older holds only. */
  routedSince: string;
}

/**
 * Record a hold. Refused server-side when a newer successful route for this
 * agent already happened — the reverse of the clear's condition, so a stalled
 * attempt cannot resurrect a hold a later success already disproved.
 */
export async function stampRoutingHold(client: any, args: StampHoldArgs): Promise<boolean> {
  const { threadId, userId, agentId, attemptStartedAt, detail } = args;
  try {
    const { data, error } = await client.rpc('stamp_routing_hold', {
      p_thread_id: threadId,
      p_user_id: userId,
      p_agent_id: agentId,
      p_attempt_started: attemptStartedAt,
      p_hold: {
        agentId,
        reason: 'no-route',
        // The hold's GENERATION. `heldAt` is when it was written, which can be
        // long after the attempt began; comparing that against a successful
        // route's start let an older failure's hold survive a newer success
        // (Lumen, PR #514 round 5). The clear compares generations.
        attemptStartedAt,
        triedCallerRepo: detail.triedCallerRepo,
        callerRepoRoot: detail.callerRepoRoot ?? null,
        heldAt: args.now ?? new Date().toISOString(),
        recovery: 'route pattern, studioHint, or project affinity',
      },
    });

    if (error) {
      // An unstamped hold is invisible on the thread, so it has to be loud
      // somewhere. Never assumed successful.
      logger.error('[RoutingHold] Stamp failed', { threadId, agentId, error: error.message });
      return false;
    }
    if (!data) {
      logger.info('[RoutingHold] Stamp skipped — a newer route already recovered this thread', {
        threadId,
        agentId,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[RoutingHold] Stamp threw', {
      threadId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Clear this agent's hold after a successful route, and record the recovery
 * marker unconditionally — the marker is what blocks a stalled older attempt
 * from stamping afterwards, so it must be written even when no hold existed.
 */
export async function clearRoutingHold(client: any, args: ClearHoldArgs): Promise<boolean> {
  const { threadId, userId, agentId, routedSince } = args;
  try {
    const { data, error } = await client.rpc('clear_routing_hold', {
      p_thread_id: threadId,
      p_user_id: userId,
      p_agent_id: agentId,
      p_routed_since: routedSince,
    });

    if (error) {
      logger.warn('[RoutingHold] Clear failed', { threadId, agentId, error: error.message });
      return false;
    }
    if (data) {
      logger.info('[RoutingHold] Cleared hold after successful route', { threadId, agentId });
      return true;
    }
    return false;
  } catch (err) {
    logger.debug('[RoutingHold] Clear threw', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
