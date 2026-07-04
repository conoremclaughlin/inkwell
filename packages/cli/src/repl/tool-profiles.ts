/**
 * Tool Profiles
 *
 * Predefined security profiles for quick policy configuration.
 * Each profile maps to a set of tool policy rules (mode, safe/allow/prompt/deny).
 */

import type { ToolMode, ToolPolicyScopeRef, ToolPolicyState } from './tool-policy.js';

export type ToolProfileId = 'minimal' | 'safe' | 'collaborative' | 'full';

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
