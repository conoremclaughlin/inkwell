import { describe, expect, it, vi } from 'vitest';
import { ToolPolicyState, type PersistedToolPolicyV2 } from './tool-policy.js';
import { applyProfile, PROFILE_IDS, TOOL_PROFILES } from './tool-profiles.js';

describe('host-independent Ink policy', () => {
  it('hydrates legacy rules without writing and keeps inspection non-consuming', () => {
    const onChange = vi.fn();
    const policy = new ToolPolicyState('backend', {
      snapshot: { version: 1, mode: 'off', promptTools: ['write'], grants: { write: 1 } },
      onChange,
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(policy.inspectInkTool('write')).toMatchObject({
      allowed: true,
      wouldConsumeGrant: true,
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(policy.canCallInkTool('write').allowed).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].scopes.global.grants).not.toHaveProperty('write');
    expect(policy.canCallInkTool('write').allowed).toBe(false);
  });

  it('hydrates all scoped rules with normalized ids and preserves deny precedence', () => {
    const snapshot: PersistedToolPolicyV2 = {
      version: 2,
      scopes: {
        global: { mode: 'backend', allowTools: ['*'] },
        workspace: { ' Work ': { denyTools: ['write'] } },
        agent: { ' ECHO ': { denyTools: ['bash'] } },
        studio: { ' ONE ': { denyTools: ['edit'] } },
      },
    };
    const policy = new ToolPolicyState('backend', {
      snapshot,
      context: { workspaceId: 'work', sbSlug: 'echo', studioId: 'one' },
    });
    expect(policy.canCallInkTool('read').allowed).toBe(true);
    for (const tool of ['write', 'bash', 'edit'])
      expect(policy.canCallInkTool(tool).allowed).toBe(false);
    expect(Object.keys(policy.snapshot().scopes!.studio!)).toEqual(['one']);
  });

  it('emits a detached persisted snapshot and round-trips the existing v2 format', () => {
    let saved!: PersistedToolPolicyV2;
    const policy = new ToolPolicyState('backend', {
      onChange: (snapshot) => {
        saved = snapshot;
      },
    });
    policy.denyTool('write');
    const restored = new ToolPolicyState('backend', { snapshot: saved });
    expect(restored.canCallInkTool('write').allowed).toBe(false);
    saved.scopes!.global!.denyTools!.push('read');
    expect(policy.canCallInkTool('read').allowed).toBe(true);
    expect(restored.canCallInkTool('read').allowed).toBe(true);
    policy.denyTool('bash');
    expect(restored.canCallInkTool('bash').allowed).toBe(true);
  });

  it('retains per-session grants in memory, not in snapshots or another policy instance', () => {
    const a = new ToolPolicyState('backend');
    a.addPromptTool('send_response');
    a.grantToolForSession('one', 'send_response');
    const b = new ToolPolicyState('backend', { snapshot: a.snapshot() });
    expect(a.canCallInkTool('send_response', 'one').allowed).toBe(true);
    expect(a.canCallInkTool('send_response', 'two').allowed).toBe(false);
    expect(b.canCallInkTool('send_response', 'one').allowed).toBe(false);
  });

  it('does not swallow host persistence errors or invent a successful write', () => {
    const failure = new Error('policy sink refused');
    const onChange = vi.fn(() => {
      throw failure;
    });
    const policy = new ToolPolicyState('backend', { onChange });
    expect(() => policy.denyTool('write')).toThrow(failure);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each(PROFILE_IDS)('applies the unchanged %s profile to a non-CLI policy', (profile) => {
    expect(PROFILE_IDS).toEqual(Object.keys(TOOL_PROFILES));
    const policy = new ToolPolicyState('backend');
    expect(applyProfile(policy, profile).success).toBe(true);
    expect(policy.getMode()).toBe(TOOL_PROFILES[profile].mode);
    const writing = policy.canCallInkTool('write');
    if (profile === 'minimal' || profile === 'inkling') expect(writing.allowed).toBe(false);
    else if (profile === 'safe')
      expect(writing).toMatchObject({ allowed: false, promptable: true });
    else expect(writing.allowed).toBe(true);
  });
});
