import { describe, expect, it, vi } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import { applyProfile } from './tool-profiles.js';
import { executeToolCalls } from './tool-call-executor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('tools-tier reply channels', () => {
  it('only executes the Inkling channel, even with grants for external sends', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    applyProfile(policy, 'tools');
    policy.grantToolForSession('synthetic', 'send_response');
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"success":true}' }],
    }));
    const channels = ['telegram', 'whatsapp', 'api', undefined, 'INKLING', 'inkling'];
    const results = await executeToolCalls(
      channels.map((channel) => ({
        tool: 'send_response',
        args: { channel, conversationId: 'chat:synthetic', content: 'Example' },
        raw: '',
      })),
      {
        policy,
        callTool,
        sessionId: 'synthetic',
        promptForApproval: vi.fn(async () => true),
        commitIntent: vi.fn(async () => undefined),
      }
    );
    expect(results.map((r) => r.status)).toEqual([
      'blocked',
      'blocked',
      'blocked',
      'blocked',
      'blocked',
      'executed',
    ]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('does not bypass an explicit deny even for the Inkling channel', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    applyProfile(policy, 'tools');
    policy.denyTool('send_response');
    expect(policy.canCallInkTool('send_response', undefined, { channel: 'inkling' }).allowed).toBe(
      false
    );
  });

  it('persists the scoped channel restriction and intersects it with broader grants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkling-channel-policy-'));
    try {
      const options = { policyPath: join(dir, 'policy.json'), context: { sbSlug: 'pip' } };
      const policy = new ToolPolicyState('backend', options);
      policy.setMutationScope('agent');
      applyProfile(policy, 'tools');
      const reloaded = new ToolPolicyState('backend', options);
      reloaded.grantToolForSession('synthetic', 'send_response');
      expect(
        reloaded.canCallInkTool('send_response', 'synthetic', { channel: 'telegram' })
      ).toMatchObject({ allowed: false, promptable: false });
      expect(
        reloaded.canCallInkTool('mcp__inkwell__send_response', 'synthetic', { channel: 'inkling' })
          .allowed
      ).toBe(true);
      reloaded.setContext({ sbSlug: 'moss' });
      expect(
        reloaded.canCallInkTool('send_response', undefined, { channel: 'telegram' }).allowed
      ).toBe(true);
      reloaded.setContext({ sbSlug: 'pip' });
      reloaded.setMutationScope('agent');
      applyProfile(reloaded, 'collaborative');
      expect(
        reloaded.canCallInkTool('send_response', undefined, { channel: 'telegram' }).allowed
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
