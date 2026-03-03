import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyProfile,
  formatProfileList,
  isValidProfileId,
  PROFILE_IDS,
  TOOL_PROFILES,
  type ToolProfileId,
} from './tool-profiles.js';
import { ToolPolicyState } from './tool-policy.js';

function makePolicy(): ToolPolicyState {
  return new ToolPolicyState('backend', { persist: false });
}

describe('tool-profiles', () => {
  describe('TOOL_PROFILES', () => {
    it('defines all expected profiles', () => {
      expect(PROFILE_IDS).toEqual(['minimal', 'safe', 'collaborative', 'full']);
    });

    it('each profile has required fields', () => {
      for (const id of PROFILE_IDS) {
        const profile = TOOL_PROFILES[id];
        expect(profile.label).toBeTruthy();
        expect(profile.description).toBeTruthy();
        expect(['backend', 'off', 'privileged']).toContain(profile.mode);
        expect(Array.isArray(profile.safeSpecs)).toBe(true);
        expect(Array.isArray(profile.allowSpecs)).toBe(true);
        expect(Array.isArray(profile.promptSpecs)).toBe(true);
        expect(Array.isArray(profile.denySpecs)).toBe(true);
      }
    });
  });

  describe('isValidProfileId', () => {
    it('returns true for valid profile IDs', () => {
      expect(isValidProfileId('minimal')).toBe(true);
      expect(isValidProfileId('safe')).toBe(true);
      expect(isValidProfileId('collaborative')).toBe(true);
      expect(isValidProfileId('full')).toBe(true);
    });

    it('returns false for invalid profile IDs', () => {
      expect(isValidProfileId('invalid')).toBe(false);
      expect(isValidProfileId('')).toBe(false);
      expect(isValidProfileId('SAFE')).toBe(false);
    });
  });

  describe('applyProfile', () => {
    let policy: ToolPolicyState;

    beforeEach(() => {
      policy = makePolicy();
    });

    it('applies minimal profile — read-only, comms denied', () => {
      const result = applyProfile(policy, 'minimal');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('backend');
      // Comms should be denied
      expect(policy.listDenyTools()).toContain('send_to_inbox');
      expect(policy.listDenyTools()).toContain('trigger_agent');
      expect(policy.listDenyTools()).toContain('send_response');
      // Memory/session should NOT be in allow list
      expect(policy.listAllowTools()).not.toContain('remember');
    });

    it('applies safe profile — memory/session allowed, comms promptable', () => {
      const result = applyProfile(policy, 'safe');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('backend');
      // Memory tools allowed
      expect(policy.listAllowTools()).toContain('remember');
      expect(policy.listAllowTools()).toContain('forget');
      // Session tools allowed
      expect(policy.listAllowTools()).toContain('start_session');
      expect(policy.listAllowTools()).toContain('end_session');
      // Comms should require approval
      expect(policy.listPromptTools()).toContain('send_to_inbox');
      expect(policy.listPromptTools()).toContain('trigger_agent');
    });

    it('applies collaborative profile — everything allowed', () => {
      const result = applyProfile(policy, 'collaborative');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('backend');
      // Comms allowed (not in prompt or deny)
      expect(policy.listAllowTools()).toContain('send_to_inbox');
      expect(policy.listAllowTools()).toContain('trigger_agent');
      expect(policy.listPromptTools()).not.toContain('send_to_inbox');
      expect(policy.listDenyTools()).not.toContain('send_to_inbox');
    });

    it('applies full profile — privileged mode', () => {
      const result = applyProfile(policy, 'full');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('privileged');
    });

    it('clears previous rules when applying a new profile', () => {
      // Start with some custom rules
      policy.denyTool('recall');
      expect(policy.listDenyTools()).toContain('recall');

      // Apply collaborative — should clear the deny
      applyProfile(policy, 'collaborative');
      expect(policy.listDenyTools()).not.toContain('recall');
    });

    it('profiles can be switched', () => {
      applyProfile(policy, 'minimal');
      expect(policy.listDenyTools()).toContain('send_to_inbox');

      applyProfile(policy, 'collaborative');
      expect(policy.listDenyTools()).not.toContain('send_to_inbox');
      expect(policy.listAllowTools()).toContain('send_to_inbox');
    });

    it('safe tools are present after profile application', () => {
      applyProfile(policy, 'safe');
      // clearScopeRules on global re-populates DEFAULT_SAFE_PCP_TOOLS
      expect(policy.listSafeTools()).toContain('bootstrap');
      expect(policy.listSafeTools()).toContain('recall');
      expect(policy.listSafeTools()).toContain('get_inbox');
    });

    it('tool policy decisions reflect profile', () => {
      applyProfile(policy, 'safe');

      // Safe tool → allowed
      const recallDecision = policy.canCallPcpTool('recall');
      expect(recallDecision.allowed).toBe(true);

      // Allowed tool → allowed
      const rememberDecision = policy.canCallPcpTool('remember');
      expect(rememberDecision.allowed).toBe(true);

      // Prompt tool → not allowed, promptable
      const inboxDecision = policy.canCallPcpTool('send_to_inbox');
      expect(inboxDecision.allowed).toBe(false);
      expect(inboxDecision.promptable).toBe(true);
    });

    it('minimal profile denies comms outright', () => {
      applyProfile(policy, 'minimal');

      const decision = policy.canCallPcpTool('send_to_inbox');
      expect(decision.allowed).toBe(false);
      expect(decision.promptable).toBe(false);
    });
  });

  describe('formatProfileList', () => {
    it('lists all profiles', () => {
      const output = formatProfileList();
      expect(output).toContain('minimal');
      expect(output).toContain('safe');
      expect(output).toContain('collaborative');
      expect(output).toContain('full');
    });

    it('marks active profile', () => {
      const output = formatProfileList('safe');
      expect(output).toContain('safe (active)');
      expect(output).not.toContain('minimal (active)');
    });
  });
});
