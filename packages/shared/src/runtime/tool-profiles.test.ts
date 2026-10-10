import { describe, expect, it, vi } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import {
  applyLaunchProfile,
  applyProfile,
  formatProfileList,
  isValidProfileId,
  PROFILE_IDS,
  TOOL_PROFILES,
} from './tool-profiles.js';

/** Host-loaded synthetic grants, never the machine's policy file. */
function withMachineGrants(): ToolPolicyState {
  return new ToolPolicyState('backend', {
    snapshot: {
      version: 2,
      scopes: {
        global: {
          mode: 'backend',
          permanentGrants: ['bash', 'send_response', 'send_to_inbox', 'view_image'],
        },
      },
    },
    context: { sbSlug: 'kindle-test' },
    mutationScope: { scope: 'agent', id: 'kindle-test' },
  });
}

describe('shared launch profiles', () => {
  it('keeps all profiles discoverable, including inkling', () => {
    expect(PROFILE_IDS).toEqual(['minimal', 'safe', 'collaborative', 'full', 'tools', 'inkling']);
    expect(PROFILE_IDS).toEqual(Object.keys(TOOL_PROFILES));
    expect(isValidProfileId('inkling')).toBe(true);
    expect(formatProfileList('inkling')).toContain('inkling (active)');
  });

  it.each(['tools', 'inkling'])(
    'keeps %s denials above inherited grants without narrowing other tools',
    (profile) => {
      const policy = withMachineGrants();
      expect(policy.snapshot().scopes?.global?.permanentGrants).toContain('bash');
      expect(policy.canCallInkTool('bash').allowed).toBe(true);
      expect(applyLaunchProfile(policy, profile)).toMatchObject({
        ok: true,
        withholdProviderTools: true,
      });
      for (const tool of [
        'bash',
        'edit',
        'write',
        'view_image',
        'trigger_agent',
        'send_response',
      ]) {
        expect(policy.canCallInkTool(tool), tool).toMatchObject({
          allowed: false,
          promptable: false,
        });
        expect(policy.canCallInkTool(`  ${tool.toUpperCase()}  `), tool).toMatchObject({
          allowed: false,
          promptable: false,
        });
      }
      for (const tool of [
        'send_to_inbox',
        'read',
        'grep',
        'find',
        'ls',
        'recall',
        'remember',
        'list_emails',
      ]) {
        expect(policy.canCallInkTool(tool).allowed, tool).toBe(true);
      }
      expect(policy.snapshot().scopes?.global?.permanentGrants).toContain('bash');
      expect(policy.listAllowTools()).toEqual([]);
    }
  );

  it.each(PROFILE_IDS)(
    'only tools and its inkling alias request provider withholding (%s)',
    (id) => {
      expect(applyLaunchProfile(new ToolPolicyState('backend'), id)).toMatchObject({
        ok: true,
        withholdProviderTools: id === 'tools' || id === 'inkling',
      });
      expect(TOOL_PROFILES[id].withholdProviderTools === true).toBe(
        id === 'tools' || id === 'inkling'
      );
    }
  );

  it('refuses an unknown launch profile without mutating policy or persisting', () => {
    const onChange = vi.fn();
    const policy = new ToolPolicyState('backend', { onChange });
    const before = policy.snapshot();
    expect(applyLaunchProfile(policy, 'inklnig')).toEqual({
      ok: false,
      message:
        'Unknown profile: inklnig. Valid: minimal, safe, collaborative, full, tools, inkling',
    });
    expect(policy.snapshot()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps view_image in the read group without weakening explicit inkling denials', () => {
    const policy = new ToolPolicyState('backend');
    applyProfile(policy, 'minimal');
    expect(policy.canCallInkTool('view_image').allowed).toBe(true);
    expect(policy.canCallInkTool('bash')).toMatchObject({ allowed: false, promptable: false });
    applyProfile(policy, 'inkling');
    expect(policy.canCallInkTool('view_image')).toMatchObject({
      allowed: false,
      promptable: false,
    });
  });
});
