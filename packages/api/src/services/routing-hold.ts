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
  /**
   * Why routing refused. `occupied` means a studio WAS resolved but was leased
   * and overflow provisioning failed — a different problem with a different
   * recovery, so the hold must not describe it as "no route".
   *
   * `ambiguous-identity` refuses before any tier runs, so its recovery is not
   * routing configuration at all: no route pattern would have helped, because
   * none was consulted.
   */
  reason?: 'no-route' | 'occupied' | 'ambiguous-identity' | 'project-without-repo';
  occupied?: { studioId: string; holderThreadKey: string } | null;
  /**
   * The thread's pinned project, when the decision was made by it (task
   * b5c71bc3): `project-without-repo` holds carry the slug and why it names
   * no repo; a `no-route` hold on a project repo carries the repo too.
   */
  project?: { slug: string; cause?: string; repoRoot?: string } | null;
}

export interface StampHoldArgs {
  threadId: string;
  /** The thread's workspace — the row is (id, workspace_id) now (spec inkmail-thread-scope §1). */
  workspaceId: string;
  sbSlug: string;
  /** When this delivery attempt began — its generation. */
  attemptStartedAt: string;
  detail: RoutingHoldDetail;
  now?: string;
}

export interface ClearHoldArgs {
  threadId: string;
  workspaceId: string;
  sbSlug: string;
  /** When the successful route began; older holds only. */
  routedSince: string;
}

/**
 * Record a hold. Refused server-side when a newer successful route for this
 * agent already happened — the reverse of the clear's condition, so a stalled
 * attempt cannot resurrect a hold a later success already disproved.
 */
export async function stampRoutingHold(client: any, args: StampHoldArgs): Promise<boolean> {
  const { threadId, workspaceId, sbSlug, attemptStartedAt, detail } = args;
  try {
    const { data, error } = await client.rpc('stamp_routing_hold', {
      p_thread_id: threadId,
      p_workspace_id: workspaceId,
      p_agent_id: sbSlug,
      p_attempt_started: attemptStartedAt,
      p_hold: {
        // PERSISTED KEY on inbox_threads.metadata — five SQL functions read
        // metadata -> 'routingHold' ->>
        // 'agentId' (migrations 20260819022604, 20260819024343, 20260819025449,
        // 20260819030642, 20260819030723). Renaming it to sbSlug makes routing
        // holds never clear, silently, with nothing to notice. It stays until a
        // migration moves the SQL too. Do not "tidy" this.
        agentId: sbSlug,
        reason: detail.reason ?? 'no-route',
        // The hold's GENERATION. `heldAt` is when it was written, which can be
        // long after the attempt began; comparing that against a successful
        // route's start let an older failure's hold survive a newer success
        // (Lumen, PR #514 round 5). The clear compares generations.
        attemptStartedAt,
        triedCallerRepo: detail.triedCallerRepo,
        callerRepoRoot: detail.callerRepoRoot ?? null,
        project: detail.project ?? null,
        heldAt: args.now ?? new Date().toISOString(),
        recovery:
          detail.reason === 'occupied'
            ? 'wait for the lease holder to finish, or fix the overflow provisioning failure'
            : detail.reason === 'ambiguous-identity'
              ? 'de-duplicate the agent slug in agent_identities — routing config is not the cause'
              : detail.reason === 'project-without-repo'
                ? "set the project's repo_root (save_project with repoRoot), then re-send"
                : 'route pattern, studioHint, or project affinity',
        occupied: detail.occupied ?? null,
      },
    });

    if (error) {
      // An unstamped hold is invisible on the thread, so it has to be loud
      // somewhere. Never assumed successful.
      logger.error('[RoutingHold] Stamp failed', { threadId, sbSlug, error: error.message });
      return false;
    }
    if (!data) {
      logger.info('[RoutingHold] Stamp skipped — a newer route already recovered this thread', {
        threadId,
        sbSlug,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[RoutingHold] Stamp threw', {
      threadId,
      sbSlug,
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
  const { threadId, workspaceId, sbSlug, routedSince } = args;
  try {
    const { data, error } = await client.rpc('clear_routing_hold', {
      p_thread_id: threadId,
      p_workspace_id: workspaceId,
      p_agent_id: sbSlug,
      p_routed_since: routedSince,
    });

    if (error) {
      logger.warn('[RoutingHold] Clear failed', { threadId, sbSlug, error: error.message });
      return false;
    }
    if (data) {
      logger.info('[RoutingHold] Cleared hold after successful route', { threadId, sbSlug });
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
