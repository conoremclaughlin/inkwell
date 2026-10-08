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
 * `ToolPolicyState`. That object mutates on read — `canCallInkTool` consumes
 * one-use grants — so concurrent clones sharing one would consume the parent's
 * grants nondeterministically, and a clone's session/always/deny answer would
 * rewrite policy for its siblings mid-run. Authorization would depend on promise
 * interleaving. Instead each clone gets its own non-persisting state, derived
 * once from an immutable read of the parent.
 *
 * See `ink://specs/ink-runtime-shadow-clones`, Q2.
 */

import { ToolPolicyState, type ToolMode } from './tool-policy.js';

import { CLONE_BASELINE_TOOLS, CLONE_DENIED_TOOLS } from '@inklabs/shared/runtime';
export {
  CLONE_BASELINE_TOOLS,
  CLONE_DENIED_TOOLS,
  isForbiddenInClone,
} from '@inklabs/shared/runtime';

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
 * "Immutable read" is load-bearing and is why this uses `inspectInkTool`:
 * `canCallInkTool` would consume the parent's one-use grants merely by being
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
    const decision = parent.inspectInkTool(tool, options.sessionId);
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
