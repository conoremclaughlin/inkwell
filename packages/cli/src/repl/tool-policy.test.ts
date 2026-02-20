import { describe, expect, it } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ToolPolicyState', () => {
  it('allows safe tools in backend mode', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const decision = policy.canCallPcpTool('get_inbox');
    expect(decision.allowed).toBe(true);
  });

  it('blocks unsafe tools by default', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const decision = policy.canCallPcpTool('send_to_inbox');
    expect(decision.allowed).toBe(false);
  });

  it('consumes scoped grants', () => {
    const policy = new ToolPolicyState('off', { persist: false });
    policy.grantTool('send_to_inbox', 2);

    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
  });

  it('allows all tools in privileged mode', () => {
    const policy = new ToolPolicyState('privileged', { persist: false });
    expect(policy.canUseBackendTools()).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);
  });

  it('disables backend tools in off mode', () => {
    const policy = new ToolPolicyState('off', { persist: false });
    expect(policy.canUseBackendTools()).toBe(false);
  });

  it('supports session-scoped grants', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.grantToolForSession('sess-1', 'send_to_inbox');
    expect(policy.canCallPcpTool('send_to_inbox', 'sess-1').allowed).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox', 'sess-2').allowed).toBe(false);
  });

  it('expands group rules for allow', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.allowTool('group:pcp-comms');
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);
    expect(policy.canCallPcpTool('trigger_agent').allowed).toBe(true);
  });

  it('persists allow rules and grants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-test-'));
    const policyPath = join(dir, 'tool-policy.json');

    const initial = new ToolPolicyState('backend', { persist: true, policyPath });
    initial.allowTool('send_to_inbox');
    initial.grantTool('create_task', 3);

    const reloaded = new ToolPolicyState('off', { persist: true, policyPath });
    expect(reloaded.canCallPcpTool('send_to_inbox').allowed).toBe(true);
    expect(reloaded.canCallPcpTool('create_task').allowed).toBe(true);
    expect(reloaded.listGrants().find((entry) => entry.tool === 'create_task')?.uses).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists mode and supports inspection getters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-test-'));
    const policyPath = join(dir, 'tool-policy.json');
    const policy = new ToolPolicyState('backend', { persist: true, policyPath });

    policy.setMode('off');
    policy.setSkillTrustMode('trusted-only');
    policy.allowTool('send_to_inbox');
    policy.denyTool('trigger_agent');
    policy.addPromptTool('remember');
    policy.addReadPathAllow('/Users/conor/**');
    policy.addWritePathAllow('/tmp/**');
    policy.setAllowedSkills(['play*', '']);

    const reloaded = new ToolPolicyState('backend', { persist: true, policyPath });
    expect(reloaded.getMode()).toBe('off');
    expect(reloaded.getSkillTrustMode()).toBe('trusted-only');
    expect(reloaded.getPolicyPath()).toBe(policyPath);
    expect(reloaded.listSafeTools()).toContain('bootstrap');
    expect(reloaded.listAllowTools()).toContain('send_to_inbox');
    expect(reloaded.listDenyTools()).toContain('trigger_agent');
    expect(reloaded.listPromptTools()).toContain('remember');
    expect(reloaded.listReadPathAllow()).toEqual(['/Users/conor/**']);
    expect(reloaded.listWritePathAllow()).toEqual(['/tmp/**']);
    expect(reloaded.listAllowedSkills()).toEqual(['play*']);

    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces deny precedence over allow', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.allowTool('group:pcp-comms');
    policy.denyTool('send_to_inbox');
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
    expect(policy.canCallPcpTool('trigger_agent').allowed).toBe(true);
  });

  it('supports prompt rule and removal', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.addPromptTool('send_to_inbox');
    const blocked = policy.canCallPcpTool('send_to_inbox');
    expect(blocked.allowed).toBe(false);
    expect(blocked.promptable).toBe(true);

    policy.removeToolRule('send_to_inbox');
    const postRemove = policy.canCallPcpTool('send_to_inbox');
    expect(postRemove.allowed).toBe(false);
    expect(postRemove.promptable).toBe(true);
  });

  it('supports wildcard allow and deny patterns', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.allowTool('send_*');
    expect(policy.canCallPcpTool('send_response').allowed).toBe(true);
    policy.denyTool('send_r*');
    expect(policy.canCallPcpTool('send_response').allowed).toBe(false);
  });

  it('tracks path allowlists', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.addReadPathAllow('  ');
    policy.addWritePathAllow('  ');
    policy.addReadPathAllow('/Users/conor/**');
    policy.addWritePathAllow('/tmp/*');
    expect(policy.isReadPathAllowed('/Users/conor/ws/file.txt')).toBe(true);
    expect(policy.isReadPathAllowed('/etc/passwd')).toBe(false);
    expect(policy.isWritePathAllowed('/tmp/a.txt')).toBe(true);
    expect(policy.isWritePathAllowed('/var/log/a.txt')).toBe(false);
  });

  it('filters skills by pattern when allowlist is set', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.setAllowedSkills(['play*', 'policy']);
    policy.allowSkill('screen*');
    policy.allowSkill('   ');
    expect(policy.isSkillAllowed('playwright')).toBe(true);
    expect(policy.isSkillAllowed('screenshot')).toBe(true);
    expect(policy.isSkillAllowed('policy')).toBe(true);
    expect(policy.isSkillAllowed('unknown')).toBe(false);
  });

  it('enforces skill trust mode', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    expect(policy.isSkillTrustAllowed('trusted')).toBe(true);
    expect(policy.isSkillTrustAllowed('local')).toBe(true);
    policy.setSkillTrustMode('trusted-only');
    expect(policy.isSkillTrustAllowed('trusted')).toBe(true);
    expect(policy.isSkillTrustAllowed('local')).toBe(false);
    expect(policy.isSkillTrustAllowed('untrusted')).toBe(false);
  });

  it('ignores malformed persisted policy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-test-'));
    const policyPath = join(dir, 'tool-policy.json');
    // Intentionally malformed JSON
    writeFileSync(policyPath, '{not-json', 'utf-8');
    const policy = new ToolPolicyState('backend', { persist: true, policyPath });
    expect(policy.canCallPcpTool('get_inbox').allowed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads wildcard deny/prompt rules and sanitized grants from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-test-'));
    const policyPath = join(dir, 'tool-policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        denyTools: ['send_*'],
        promptTools: ['trigger_*'],
        grants: { create_task: -3, remember: 2 },
      }),
      'utf-8'
    );

    const policy = new ToolPolicyState('backend', { persist: true, policyPath });
    expect(policy.canCallPcpTool('send_response').allowed).toBe(false);
    const triggerDecision = policy.canCallPcpTool('trigger_agent');
    expect(triggerDecision.allowed).toBe(false);
    expect(triggerDecision.promptable).toBe(true);
    expect(policy.listGrants().find((entry) => entry.tool === 'create_task')?.uses).toBe(0);
    expect(policy.canCallPcpTool('remember').allowed).toBe(true);
    expect(policy.canCallPcpTool('remember').allowed).toBe(true);
    expect(policy.canCallPcpTool('remember').allowed).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('handles session grant edge-cases and finite grant decrement path', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.grantToolForSession('   ', 'send_to_inbox');
    policy.grantToolForSession('sess-1', '');
    expect(policy.listSessionGrants()).toEqual([]);
    expect(policy.listSessionGrants('   ')).toEqual([]);
    expect(policy.listSessionGrants('missing')).toEqual([]);

    policy.grantToolForSession('sess-1', 'send_to_inbox');
    expect(policy.canCallPcpTool('send_to_inbox', 'sess-1').allowed).toBe(true);

    // Exercise finite decrement branch inside hasSessionGrant.
    (
      policy as unknown as {
        sessionGrants: Map<string, Map<string, number>>;
      }
    ).sessionGrants.set('finite', new Map([['send_to_inbox', 1]]));
    expect(policy.canCallPcpTool('send_to_inbox', 'finite').allowed).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox', 'finite').allowed).toBe(false);
  });

  it('rejects invalid tool names and sorts grants deterministically', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const invalid = policy.canCallPcpTool('   ');
    expect(invalid.allowed).toBe(false);
    expect(invalid.promptable).toBe(false);

    policy.grantTool('z_tool', 1);
    policy.grantTool('a_tool', 1);
    expect(policy.listGrants().map((entry) => entry.tool)).toEqual(['a_tool', 'z_tool']);
  });
});
