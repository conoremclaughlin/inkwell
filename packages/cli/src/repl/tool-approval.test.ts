import { describe, expect, it } from 'vitest';
import { applyToolApprovalChoice, parseToolApprovalInput } from './tool-approval.js';
import { ToolPolicyState } from './tool-policy.js';

describe('tool approval', () => {
  it('parses approval aliases', () => {
    expect(parseToolApprovalInput('y')).toBe('once');
    expect(parseToolApprovalInput('yes')).toBe('once');
    expect(parseToolApprovalInput('s')).toBe('session');
    expect(parseToolApprovalInput('a')).toBe('always');
    expect(parseToolApprovalInput('d')).toBe('deny');
    expect(parseToolApprovalInput('nope')).toBe('cancel');
  });

  it('applies one-time approval', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const result = applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      choice: 'once',
    });
    expect(result.approved).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
  });

  it('applies session approval and fallback when no session', () => {
    const policy = new ToolPolicyState('backend', { persist: false });

    const fallback = applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      choice: 'session',
    });
    expect(fallback.approved).toBe(true);
    expect(fallback.message).toContain('granted once');

    const scoped = applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      sessionId: 'sess-1',
      choice: 'session',
    });
    expect(scoped.approved).toBe(true);
    expect(policy.canCallPcpTool('send_to_inbox', 'sess-1').allowed).toBe(true);
  });

  it('applies persistent allow and deny', () => {
    const policy = new ToolPolicyState('backend', { persist: false });

    applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      choice: 'always',
    });
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(true);

    applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      choice: 'deny',
    });
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
  });

  it('returns cancelled when user declines approval', () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const result = applyToolApprovalChoice({
      policy,
      tool: 'send_to_inbox',
      choice: 'cancel',
    });
    expect(result).toEqual({ approved: false, message: 'Cancelled.' });
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
  });
});
