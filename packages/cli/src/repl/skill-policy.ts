import { ToolPolicyState } from './tool-policy.js';
import { DiscoveredSkill } from './skills.js';

export interface SkillPolicyView {
  visible: DiscoveredSkill[];
  blockedBySkill: DiscoveredSkill[];
  blockedByPath: DiscoveredSkill[];
  blockedByTrust: DiscoveredSkill[];
}

export function filterSkillsByPolicy(
  skills: DiscoveredSkill[],
  policy: ToolPolicyState
): SkillPolicyView {
  const visible: DiscoveredSkill[] = [];
  const blockedBySkill: DiscoveredSkill[] = [];
  const blockedByPath: DiscoveredSkill[] = [];
  const blockedByTrust: DiscoveredSkill[] = [];

  for (const skill of skills) {
    if (!policy.isSkillTrustAllowed(skill.trustLevel)) {
      blockedByTrust.push(skill);
      continue;
    }
    if (!policy.isSkillAllowed(skill.name)) {
      blockedBySkill.push(skill);
      continue;
    }
    if (!policy.isReadPathAllowed(skill.path)) {
      blockedByPath.push(skill);
      continue;
    }
    visible.push(skill);
  }

  return { visible, blockedBySkill, blockedByPath, blockedByTrust };
}

export function canActivateSkill(skill: DiscoveredSkill, policy: ToolPolicyState): {
  allowed: boolean;
  reason?: string;
} {
  if (!policy.isSkillTrustAllowed(skill.trustLevel)) {
    return {
      allowed: false,
      reason: `Skill blocked by trust policy (${skill.trustLevel}); set /skill-trust all to allow.`,
    };
  }
  if (!policy.isSkillAllowed(skill.name)) {
    return { allowed: false, reason: `Skill blocked by allowlist policy: ${skill.name}` };
  }
  if (!policy.isReadPathAllowed(skill.path)) {
    return { allowed: false, reason: `Skill path blocked by read allowlist policy: ${skill.path}` };
  }
  return { allowed: true };
}
