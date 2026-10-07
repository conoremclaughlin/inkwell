/**
 * Tool Profiles
 *
 * Predefined security profiles for quick policy configuration.
 * Each profile maps to a set of tool policy rules (mode, safe/allow/prompt/deny).
 */

import type { ToolMode, ToolPolicyScopeRef, ToolPolicyState } from './tool-policy.js';

export type ToolProfileId = 'minimal' | 'safe' | 'collaborative' | 'full' | 'inkling';

export interface ToolProfile {
  label: string;
  description: string;
  mode: ToolMode;
  /** Tools to add to the safe list (auto-allowed, no policy check) */
  safeSpecs: string[];
  /** Tools to add to the allow list (allowed by policy) */
  allowSpecs: string[];
  /** Tools to add to the prompt list (require per-call approval) */
  promptSpecs: string[];
  /** Tools to deny outright */
  denySpecs: string[];
  /**
   * The provider gets no native tools of its own and no directory grants on
   * any spawn, for as long as the chat runs (backend-runner.ts,
   * withholdProviderToolsForThisProcess). Every tool the turn has is then
   * ink's, under this profile's rules.
   */
  withholdProviderTools?: true;
}

export const TOOL_PROFILES: Record<ToolProfileId, ToolProfile> = {
  minimal: {
    label: 'Minimal',
    description: 'Read-only. Safe tools + file reads. No writes, no comms.',
    mode: 'backend',
    safeSpecs: ['group:ink-safe'],
    allowSpecs: ['group:read'],
    promptSpecs: [],
    denySpecs: ['group:ink-comms', 'group:write'],
  },
  safe: {
    label: 'Safe',
    description: 'All tools allowed except comms and file writes, which require approval.',
    mode: 'backend',
    safeSpecs: ['group:ink-safe'],
    allowSpecs: [],
    promptSpecs: ['group:ink-comms', 'group:write'],
    denySpecs: [],
  },
  collaborative: {
    label: 'Collaborative',
    description: 'All tools allowed including file read/write. Full collaboration without prompts.',
    mode: 'backend',
    safeSpecs: ['group:ink-safe'],
    allowSpecs: [],
    promptSpecs: [],
    denySpecs: [],
  },
  full: {
    label: 'Full',
    description: 'Privileged mode. All tools allowed, no restrictions.',
    mode: 'privileged',
    safeSpecs: ['group:ink-safe'],
    allowSpecs: [],
    promptSpecs: [],
    denySpecs: [],
  },
  /**
   * An inkling's own turn (task 0321ccf1). Denied outright, so no grant in
   * the policy file can open them: the shell, which is not confined to the
   * working directory; view_image, whose roots include the shared
   * ~/.ink/files (Lumen, #773: another account's image was reachable);
   * file edits and writes; waking another agent; and send_response, which
   * an inkling, answering in its conversation thread, never needs. Its
   * reply, send_to_inbox, stays allowed, as do the Pi reads (read, grep,
   * find, ls), which validatePathArgs keeps inside its own folder. Media a
   * person sends reaches the turn through ink chat's own attachment
   * encoding, not through view_image. The server also runs it against a
   * policy file of its own, so the machine's grants are never read at all;
   * these denials hold either way.
   *
   * The provider's own tools are withheld as well. Claude Code's native Read
   * was opened for any attachment it can't show inline, a document among
   * them, on a spawn also granted the shared ~/.ink/files and the studios
   * root, whose checkouts carry .env.local files (lane 2, measured on
   * a0db3e57). Its reach is Claude Code's read policy, not this folder.
   *
   * No allow list: one would narrow every tool to the names on it.
   */
  inkling: {
    label: 'Inkling',
    description:
      "An inkling's turn: no shell, no file edits or writes, no shared-image reads, never wakes another agent; it replies in its own conversation.",
    mode: 'backend',
    safeSpecs: ['group:ink-safe'],
    allowSpecs: [],
    promptSpecs: [],
    denySpecs: ['group:write', 'view_image', 'trigger_agent', 'send_response'],
    withholdProviderTools: true,
  },
};

export const PROFILE_IDS = Object.keys(TOOL_PROFILES) as ToolProfileId[];

export function isValidProfileId(id: string): id is ToolProfileId {
  return PROFILE_IDS.includes(id as ToolProfileId);
}

/**
 * Apply a profile to a ToolPolicyState instance.
 *
 * This clears the target scope's tool rules and applies the profile's
 * mode, safe, allow, prompt, and deny specs.
 */
export function applyProfile(
  policy: ToolPolicyState,
  profileId: ToolProfileId,
  scope?: ToolPolicyScopeRef
): { success: boolean; message: string } {
  const profile = TOOL_PROFILES[profileId];
  if (!profile) {
    return { success: false, message: `Unknown profile: ${profileId}` };
  }

  // Clear existing rules on the target scope
  policy.clearScopeRules(scope);

  // Set mode
  policy.setMode(profile.mode, scope);

  // Safe tools (group:ink-safe) are auto-populated by clearScopeRules above.
  for (const spec of profile.allowSpecs) {
    policy.allowTool(spec, scope);
  }

  for (const spec of profile.promptSpecs) {
    policy.addPromptTool(spec, scope);
  }

  for (const spec of profile.denySpecs) {
    policy.denyTool(spec, scope);
  }

  return {
    success: true,
    message: `Applied "${profile.label}" profile (${profile.description})`,
  };
}

/**
 * The --profile a chat was launched with, applied, or the reason it can't
 * be. The chat stops on a refusal: carrying on would run with whatever the
 * policy file holds, and a server spawn names a profile precisely to bound
 * its turn (task 0321ccf1).
 */
export function applyLaunchProfile(
  policy: ToolPolicyState,
  name: string
): { ok: true; message: string; withholdProviderTools: boolean } | { ok: false; message: string } {
  if (!isValidProfileId(name)) {
    return { ok: false, message: `Unknown profile: ${name}. Valid: ${PROFILE_IDS.join(', ')}` };
  }
  const applied = applyProfile(policy, name);
  return applied.success
    ? {
        ok: true,
        message: applied.message,
        withholdProviderTools: TOOL_PROFILES[name].withholdProviderTools === true,
      }
    : { ok: false, message: applied.message };
}

/**
 * Format profile list for display.
 */
export function formatProfileList(activeProfileId?: ToolProfileId): string {
  const lines: string[] = [];
  for (const [id, profile] of Object.entries(TOOL_PROFILES)) {
    const active = id === activeProfileId ? ' (active)' : '';
    lines.push(`  ${id}${active} — ${profile.description}`);
  }
  return lines.join('\n');
}
