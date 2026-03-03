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
    description:
      'Read-only. Only safe tools (bootstrap, recall, list_*, get_*). No writes, no comms.',
    mode: 'backend',
    safeSpecs: ['group:pcp-safe'],
    allowSpecs: [],
    promptSpecs: [],
    denySpecs: ['group:pcp-comms'],
  },
  safe: {
    label: 'Safe',
    description: 'Memory and session tools allowed. Comms require per-call approval.',
    mode: 'backend',
    safeSpecs: ['group:pcp-safe'],
    allowSpecs: ['group:pcp-memory', 'group:pcp-session'],
    promptSpecs: ['group:pcp-comms'],
    denySpecs: [],
  },
  collaborative: {
    label: 'Collaborative',
    description: 'Memory, sessions, and comms all allowed. Full collaboration without prompts.',
    mode: 'backend',
    safeSpecs: ['group:pcp-safe'],
    allowSpecs: ['group:pcp-memory', 'group:pcp-session', 'group:pcp-comms'],
    promptSpecs: [],
    denySpecs: [],
  },
  full: {
    label: 'Full',
    description: 'Privileged mode. All tools allowed, no restrictions.',
    mode: 'privileged',
    safeSpecs: ['group:pcp-safe'],
    allowSpecs: ['group:pcp-memory', 'group:pcp-session', 'group:pcp-comms'],
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

  // Apply tool specs
  for (const spec of profile.safeSpecs) {
    // Safe tools go through allowTool — they're already in DEFAULT_SAFE_PCP_TOOLS
    // which clearScopeRules re-populates for global scope
  }

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
