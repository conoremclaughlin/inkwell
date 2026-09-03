/**
 * Clone Capability Envelope
 *
 * What a shadow clone is allowed to do.
 *
 *     clone authority = parent ceiling ∩ read-oriented baseline
 *
 * Identity is not authority. A clone carries the parent's identity — that settles
 * *attribution* — but it raises concurrency, reads potentially untrusted files,
 * and returns only a summary. Handing it the parent's full ambient authority
 * would multiply blast radius while *reducing* the parent's visibility into what
 * happened. So the clone gets a read-oriented baseline, further narrowed by
 * whatever the parent itself may do.
 *
 * The other half of the design is that a clone never shares the parent's
 * `ToolPolicyState`. That object mutates on read — `canCallPcpTool` consumes
 * one-use grants — so concurrent clones sharing one would consume the parent's
 * grants nondeterministically, and a clone's session/always/deny answer would
 * rewrite policy for its siblings mid-run. Authorization would depend on promise
 * interleaving. Instead each clone gets its own non-persisting state, derived
 * once from an immutable read of the parent.
 *
 * See `ink://specs/ink-runtime-shadow-clones`, Q2.
 */

import { ToolPolicyState, type ToolMode } from './tool-policy.js';

/**
 * What a clone may do without asking.
 *
 * Read-oriented, matching the actual use case: go look at things and report
 * back. Anything absent from this list is not silently permitted — it is blocked
 * by the allowlist and escalates to the parent's approval coordinator, labelled
 * with the clone that asked.
 *
 * `DEFAULT_SAFE_PCP_TOOLS` bypass allowlist narrowing inside `ToolPolicyState`,
 * so the clone's effective read surface is this list UNION that one. Every
 * member of both is read-only, and a parent denial still overrides either.
 */
export const CLONE_BASELINE_TOOLS: readonly string[] = [
  // Pi coding tools — the read half only.
  'read',
  'grep',
  'find',
  'ls',
  // Asking what it can call. A clone that must escalate for this learns its
  // surface by being refused, which is the failure mode this whole area exists
  // to remove — and unattended, a promptable tool is denied outright.
  'describe_tool',
  // PCP introspection. Reading the workspace is the point of a clone.
  'bootstrap',
  'recall',
  'get_context',
  'get_artifact',
  'list_artifacts',
  'search_artifacts',
  'get_artifact_history',
  'list_artifact_comments',
  'list_tasks',
  'get_task_stats',
  'list_task_groups',
  'list_task_group_comments',
  'list_projects',
  'get_project',
  'get_session',
  'list_sessions',
  'get_session_context',
  'get_activity',
  'get_activity_summary',
  'get_conversation_history',
  'search_links',
  'list_skills',
  'get_skill',
  'list_studios',
  'get_studio',
  'list_identities',
  'get_identity',
  'get_team_constitution',
  'get_user_identity',
  'get_memory_history',
  'get_timezone',
  'get_agent_status',
  'get_agent_summaries',
  'list_workspaces',
  'get_workspace',
];

/**
 * What a clone may NOT do, whatever the parent's policy says.
 *
 * Redundant against the allowlist by construction, and deliberately so: deny
 * beats allow at every scope, so these stay refused even if the baseline is
 * later widened by accident. Each group answers a specific way a clone could do
 * damage the parent would never see.
 */
export const CLONE_DENIED_TOOLS: readonly string[] = [
  // A clone's ledger is a throwaway; there is no provider session of its own
  // to re-seed from a summary. The handler refuses it too — the prompt just
  // does not offer it.
  'compact_context',
  // Memory belongs to the original. Clones hand work back; the parent decides
  // what was worth remembering. Spec decision #5 — enforced, not conventional.
  'remember',
  'forget',
  'update_memory',
  'restore_memory',
  'save_context',
  'save_project',
  'save_identity',
  'save_user_identity',
  'save_team_constitution',
  // Speaking to third parties as the parent, from a context the user never saw.
  'send_to_inbox',
  'send_response',
  'send_email',
  'draft_email',
  'reply_to_email',
  'modify_emails',
  'trigger_agent',
  'log_message',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  // Session and studio lifecycle — the parent owns its own runtime.
  'start_session',
  'end_session',
  'update_session_state',
  'compact_session',
  'clear_chat_context',
  'create_studio',
  'update_studio',
  'close_studio',
  'adopt_studio',
  'register_studio',
  // Filesystem and shell writes.
  'write',
  'edit',
  'bash',
  // Authority over authority.
  'set_permission',
  'reset_permission',
  // No nesting. Also enforced at the executor, because a text-protocol model can
  // emit any tool name it likes regardless of what its prompt listed.
  'spawn_agent',
];

export interface CloneEnvelope {
  /** The clone's own policy. Never persists, never shared with a sibling. */
  policy: ToolPolicyState;
  /** Baseline tools the parent itself may not use, so the clone does not get them. */
  narrowedByParent: string[];
  /**
   * Baseline tools the parent could only use by spending a one-use grant.
   * Excluded: a clone must not spend the parent's grants.
   */
  excludedGrantBackedTools: string[];
}

export interface DeriveClonePolicyOptions {
  /** Extra tools to add to the baseline, still intersected with the parent. */
  additionalTools?: readonly string[];
  /** Session id used when asking what the parent may do. */
  sessionId?: string;
}

/**
 * Build a clone's policy from an immutable read of the parent's.
 *
 * "Immutable read" is load-bearing and is why this uses `inspectPcpTool`:
 * `canCallPcpTool` would consume the parent's one-use grants merely by being
 * asked what a clone is allowed to do, billing the parent for calls that may
 * never happen.
 */
export function deriveClonePolicy(
  parent: ToolPolicyState,
  options: DeriveClonePolicyOptions = {}
): CloneEnvelope {
  const candidates = [...CLONE_BASELINE_TOOLS, ...(options.additionalTools ?? [])];

  const allowed: string[] = [];
  const narrowedByParent: string[] = [];
  const excludedGrantBackedTools: string[] = [];

  for (const tool of candidates) {
    if (CLONE_DENIED_TOOLS.includes(tool)) continue;
    const decision = parent.inspectPcpTool(tool, options.sessionId);
    if (!decision.allowed) {
      narrowedByParent.push(tool);
      continue;
    }
    if (decision.wouldConsumeGrant) {
      // The parent can do this, but only by spending a finite grant. Inheriting
      // it would let a clone burn the user's grant on work the user never saw.
      excludedGrantBackedTools.push(tool);
      continue;
    }
    allowed.push(tool);
  }

  // persist:false is not an optimisation — it is the guarantee that a clone
  // cannot write durable policy to disk. Session and permanent grants stay the
  // parent's to make.
  const policy = new ToolPolicyState(clampMode(parent.getMode()), { persist: false });
  policy.setContext(parent.getContext());

  // A privileged parent must not produce a privileged clone: privileged mode
  // short-circuits every check below, including the deny list.
  policy.setMode(clampMode(parent.getMode()));
  policy.setSkillTrustMode(parent.getSkillTrustMode());
  policy.setSessionVisibility(parent.getSessionVisibility());

  for (const tool of allowed) policy.allowTool(tool);
  // Parent denials are inherited, then the clone's own denials on top.
  for (const tool of parent.listDenyTools()) policy.denyTool(tool);
  for (const tool of CLONE_DENIED_TOOLS) policy.denyTool(tool);

  // Reads follow the parent's path allowlist; writes have none, because the
  // clone has no write tools to use them with.
  for (const pattern of parent.listReadPathAllow()) policy.addReadPathAllow(pattern);

  const parentSkills = parent.listAllowedSkills();
  if (parentSkills.length > 0) policy.setAllowedSkills(parentSkills);

  return { policy, narrowedByParent, excludedGrantBackedTools };
}

/**
 * A clone is never privileged, and never more permissive than its parent.
 *
 * `privileged` returns allowed for everything before the deny list is consulted,
 * so a privileged clone would have no envelope at all.
 */
function clampMode(parentMode: ToolMode): ToolMode {
  return parentMode === 'off' ? 'off' : 'backend';
}

/**
 * True when this tool must never run inside a clone, whatever policy says.
 *
 * The executor consults this directly rather than trusting the clone's policy
 * alone: `spawn_agent` fans out authority and costs backend time, and omitting
 * it from the clone's prompt is not enforcement — the model emits tool calls as
 * text and can name anything.
 */
export function isForbiddenInClone(tool: string): boolean {
  return CLONE_DENIED_TOOLS.includes(tool.replace(/^mcp__inkwell__/, ''));
}
