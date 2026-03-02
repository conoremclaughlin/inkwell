import { describe, expect, it } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import { canActivateSkill, filterSkillsByPolicy } from './skill-policy.js';

describe('skill policy integration', () => {
  const skills = [
    {
      name: 'playwright',
      path: '/Users/conor/.codex/skills/playwright',
      source: 'home:~/.codex/skills',
      trustLevel: 'local' as const,
    },
    {
      name: 'screenshot',
      path: '/Users/conor/.codex/skills/screenshot',
      source: 'home:~/.codex/skills',
      trustLevel: 'local' as const,
    },
    { name: 'secret', path: '/etc/pcp/skills/secret', source: 'system', trustLevel: 'untrusted' as const },
  ];

  it('filters by both skill allowlist and read-path allowlist', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.setAllowedSkills(['play*', 'secret']);
    policy.addReadPathAllow('/Users/conor/**');

    const result = filterSkillsByPolicy(skills, policy);
    expect(result.visible.map((skill) => skill.name)).toEqual(['playwright']);
    expect(result.blockedBySkill.map((skill) => skill.name)).toEqual(['screenshot']);
    expect(result.blockedByPath.map((skill) => skill.name)).toEqual(['secret']);
    expect(result.blockedByTrust).toHaveLength(0);
  });

  it('returns activation reason when blocked', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.setAllowedSkills(['play*']);
    policy.addReadPathAllow('/Users/conor/**');

    expect(canActivateSkill(skills[1], policy)).toEqual({
      allowed: false,
      reason: 'Skill blocked by allowlist policy: screenshot',
    });

    policy.allowSkill('secret');
    expect(canActivateSkill(skills[2], policy)).toEqual({
      allowed: false,
      reason: 'Skill path blocked by read allowlist policy: /etc/pcp/skills/secret',
    });
  });

  it('blocks untrusted skills when trust mode is trusted-only', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.setSkillTrustMode('trusted-only');
    policy.setAllowedSkills(['*']);

    const result = filterSkillsByPolicy(skills, policy);
    expect(result.visible).toHaveLength(0);
    expect(result.blockedByTrust.map((skill) => skill.name).sort()).toEqual([
      'playwright',
      'screenshot',
      'secret',
    ]);
    expect(canActivateSkill(skills[0], policy)).toEqual({
      allowed: false,
      reason: 'Skill blocked by trust policy (local); set /skill-trust all to allow.',
    });
  });

  it('applies scoped trust mode from active context', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.setSkillTrustMode('trusted-only', { scope: 'workspace', id: 'ws-1' });
    policy.setContext({ workspaceId: 'ws-1' });
    expect(policy.isSkillTrustAllowed('local')).toBe(false);

    policy.setContext({ workspaceId: 'ws-2' });
    expect(policy.isSkillTrustAllowed('local')).toBe(true);
  });
});
