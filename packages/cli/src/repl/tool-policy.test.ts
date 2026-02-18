import { describe, expect, it } from 'vitest';
import { ToolPolicyState } from './tool-policy.js';
import { mkdtempSync, rmSync } from 'fs';
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
});
