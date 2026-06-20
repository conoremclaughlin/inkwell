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

    it('applies safe profile — no narrowing, comms promptable', () => {
      const result = applyProfile(policy, 'safe');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('backend');
      // No explicit allow list — tools default to allowed
      expect(policy.listAllowTools()).toHaveLength(0);
      // Comms should require approval
      expect(policy.listPromptTools()).toContain('send_to_inbox');
      expect(policy.listPromptTools()).toContain('trigger_agent');
    });

    it('applies collaborative profile — everything allowed, no narrowing', () => {
      const result = applyProfile(policy, 'collaborative');

      expect(result.success).toBe(true);
      expect(policy.getMode()).toBe('backend');
      // No explicit allow list — tools default to allowed
      expect(policy.listAllowTools()).toHaveLength(0);
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
      // Collaborative has no explicit allow list — tools allowed by default
      expect(policy.listPromptTools()).not.toContain('send_to_inbox');
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

      // MCP tool (not in any list) → allowed by default (no narrowing)
      const rememberDecision = policy.canCallPcpTool('remember');
      expect(rememberDecision.allowed).toBe(true);

      // MCP tool like list_emails → allowed by default (no narrowing)
      const emailDecision = policy.canCallPcpTool('list_emails');
      expect(emailDecision.allowed).toBe(true);

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

    // Pi coding tool groups (group:read / group:write)
    describe('Pi tool groups', () => {
      it('minimal profile allows read tools and denies write tools', () => {
        applyProfile(policy, 'minimal');

        // group:read → allowed
        expect(policy.canCallPcpTool('read').allowed).toBe(true);
        expect(policy.canCallPcpTool('grep').allowed).toBe(true);
        expect(policy.canCallPcpTool('find').allowed).toBe(true);
        expect(policy.canCallPcpTool('ls').allowed).toBe(true);

        // group:write → denied
        const bashDecision = policy.canCallPcpTool('bash');
        expect(bashDecision.allowed).toBe(false);
        expect(bashDecision.promptable).toBe(false);

        const editDecision = policy.canCallPcpTool('edit');
        expect(editDecision.allowed).toBe(false);
        expect(editDecision.promptable).toBe(false);

        const writeDecision = policy.canCallPcpTool('write');
        expect(writeDecision.allowed).toBe(false);
        expect(writeDecision.promptable).toBe(false);
      });

      it('safe profile allows read tools and prompts for write tools', () => {
        applyProfile(policy, 'safe');

        // group:read → allowed
        expect(policy.canCallPcpTool('read').allowed).toBe(true);
        expect(policy.canCallPcpTool('grep').allowed).toBe(true);

        // group:write → promptable (2FA path)
        const bashDecision = policy.canCallPcpTool('bash');
        expect(bashDecision.allowed).toBe(false);
        expect(bashDecision.promptable).toBe(true);

        const editDecision = policy.canCallPcpTool('edit');
        expect(editDecision.allowed).toBe(false);
        expect(editDecision.promptable).toBe(true);

        const writeDecision = policy.canCallPcpTool('write');
        expect(writeDecision.allowed).toBe(false);
        expect(writeDecision.promptable).toBe(true);
      });

      it('collaborative profile allows both read and write tools', () => {
        applyProfile(policy, 'collaborative');

        expect(policy.canCallPcpTool('read').allowed).toBe(true);
        expect(policy.canCallPcpTool('grep').allowed).toBe(true);
        expect(policy.canCallPcpTool('bash').allowed).toBe(true);
        expect(policy.canCallPcpTool('edit').allowed).toBe(true);
        expect(policy.canCallPcpTool('write').allowed).toBe(true);
      });

      it('full profile allows everything via privileged mode', () => {
        applyProfile(policy, 'full');

        expect(policy.canCallPcpTool('read').allowed).toBe(true);
        expect(policy.canCallPcpTool('bash').allowed).toBe(true);
        expect(policy.canCallPcpTool('edit').allowed).toBe(true);
      });
    });

    describe('MCP tool passthrough (no narrowing)', () => {
      it('safe profile allows MCP tools that are not in any group', () => {
        applyProfile(policy, 'safe');

        expect(policy.canCallPcpTool('list_emails').allowed).toBe(true);
        expect(policy.canCallPcpTool('get_integration_health').allowed).toBe(true);
        expect(policy.canCallPcpTool('list_calendar_events').allowed).toBe(true);
        expect(policy.canCallPcpTool('remember').allowed).toBe(true);
        expect(policy.canCallPcpTool('save_link').allowed).toBe(true);
      });

      it('collaborative profile allows MCP tools', () => {
        applyProfile(policy, 'collaborative');

        expect(policy.canCallPcpTool('list_emails').allowed).toBe(true);
        expect(policy.canCallPcpTool('get_integration_health').allowed).toBe(true);
        expect(policy.canCallPcpTool('remember').allowed).toBe(true);
      });

      it('minimal profile blocks MCP tools not in allowlist via narrowing', () => {
        applyProfile(policy, 'minimal');

        // MCP tools not in group:read → blocked by allowlist narrowing
        const emailDecision = policy.canCallPcpTool('list_emails');
        expect(emailDecision.allowed).toBe(false);
        expect(emailDecision.promptable).toBe(true);

        const healthDecision = policy.canCallPcpTool('get_integration_health');
        expect(healthDecision.allowed).toBe(false);
        expect(healthDecision.promptable).toBe(true);
      });

      it('minimal profile still allows safe tools despite narrowing', () => {
        applyProfile(policy, 'minimal');

        // DEFAULT_SAFE_PCP_TOOLS bypass the narrowing filter
        expect(policy.canCallPcpTool('bootstrap').allowed).toBe(true);
        expect(policy.canCallPcpTool('recall').allowed).toBe(true);
        expect(policy.canCallPcpTool('get_inbox').allowed).toBe(true);
        expect(policy.canCallPcpTool('get_timezone').allowed).toBe(true);
      });
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
