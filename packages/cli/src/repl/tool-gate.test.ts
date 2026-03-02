import { describe, expect, it } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import { ensurePcpToolAllowed } from './tool-gate.js';

describe('ensurePcpToolAllowed', () => {
  it('allows already-allowed tools without prompting', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    let prompted = false;
    const allowed = await ensurePcpToolAllowed({
      policy,
      tool: 'get_inbox',
      prompt: async () => {
        prompted = true;
        return false;
      },
    });
    expect(allowed).toBe(true);
    expect(prompted).toBe(false);
  });

  it('blocks non-promptable denied tools immediately', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    policy.denyTool('send_to_inbox');
    let prompted = false;
    const allowed = await ensurePcpToolAllowed({
      policy,
      tool: 'send_to_inbox',
      prompt: async () => {
        prompted = true;
        return true;
      },
    });
    expect(allowed).toBe(false);
    expect(prompted).toBe(false);
  });

  it('prompts when policy marks tool as promptable and accepts approval', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const allowed = await ensurePcpToolAllowed({
      policy,
      tool: 'send_to_inbox',
      prompt: async () => true,
    });
    expect(allowed).toBe(true);
  });

  it('returns false when prompt is declined', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const allowed = await ensurePcpToolAllowed({
      policy,
      tool: 'send_to_inbox',
      prompt: async () => false,
    });
    expect(allowed).toBe(false);
  });
});
