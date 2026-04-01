import { describe, it, expect, beforeEach } from 'vitest';
import { parsePermissionGrant, applyPermissionGrant, buildPermissionGrantMetadata } from './permission-grant.js';
import { ToolPolicyState } from './tool-policy.js';

describe('parsePermissionGrant', () => {
  it('returns null for missing metadata', () => {
    expect(parsePermissionGrant(null)).toBeNull();
    expect(parsePermissionGrant(undefined)).toBeNull();
    expect(parsePermissionGrant({})).toBeNull();
  });

  it('returns null for missing permissionGrant key', () => {
    expect(parsePermissionGrant({ other: 'data' })).toBeNull();
  });

  it('returns null for invalid action', () => {
    expect(parsePermissionGrant({
      permissionGrant: { action: 'invalid', tools: ['remember'] },
    })).toBeNull();
  });

  it('returns null for empty tools array', () => {
    expect(parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: [] },
    })).toBeNull();
  });

  it('returns null for non-array tools', () => {
    expect(parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: 'remember' },
    })).toBeNull();
  });

  it('parses valid allow grant', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: ['remember', 'recall'] },
    });
    expect(result).toEqual({
      action: 'allow',
      tools: ['remember', 'recall'],
    });
  });

  it('parses valid deny grant', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'deny', tools: ['send_email'] },
    });
    expect(result).toEqual({
      action: 'deny',
      tools: ['send_email'],
    });
  });

  it('parses grant with uses', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'grant', tools: ['remember'], uses: 5 },
    });
    expect(result).toEqual({
      action: 'grant',
      tools: ['remember'],
      uses: 5,
    });
  });

  it('parses grant-session', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'grant-session', tools: ['group:ink-memory'] },
    });
    expect(result).toEqual({
      action: 'grant-session',
      tools: ['group:ink-memory'],
    });
  });

  it('includes reason when present', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: ['remember'], reason: 'User approved' },
    });
    expect(result).toEqual({
      action: 'allow',
      tools: ['remember'],
      reason: 'User approved',
    });
  });

  it('normalizes tool names to lowercase', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: ['Remember', 'RECALL'] },
    });
    expect(result?.tools).toEqual(['remember', 'recall']);
  });

  it('filters out empty tool strings', () => {
    const result = parsePermissionGrant({
      permissionGrant: { action: 'allow', tools: ['remember', '', '  '] },
    });
    expect(result?.tools).toEqual(['remember']);
  });
});

describe('applyPermissionGrant', () => {
  let policy: ToolPolicyState;

  beforeEach(() => {
    policy = new ToolPolicyState('backend', { persist: false });
  });

  it('applies allow action', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'allow', tools: ['remember'] },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('remember');
    expect(result.summary).toContain('always');

    const decision = policy.canCallPcpTool('remember');
    expect(decision.allowed).toBe(true);
  });

  it('applies deny action', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'deny', tools: ['send_email'] },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('denied');

    const decision = policy.canCallPcpTool('send_email');
    expect(decision.allowed).toBe(false);
  });

  it('applies grant action with uses', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'grant', tools: ['remember'], uses: 3 },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('3 uses');
  });

  it('applies grant-session action', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'grant-session', tools: ['remember'] },
      sessionId: 'test-session-123',
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('session');

    // Session grant should allow the tool
    const decision = policy.canCallPcpTool('remember', 'test-session-123');
    expect(decision.allowed).toBe(true);
  });

  it('falls back to once-grant when no sessionId for grant-session', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'grant-session', tools: ['remember'] },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('once');
  });

  it('applies revoke action', () => {
    // First allow, then revoke
    policy.allowTool('remember');
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'revoke', tools: ['remember'] },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('revoked');
  });

  it('expands group specs', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'allow', tools: ['group:ink-memory'] },
    });
    expect(result.applied).toBe(true);
    expect(result.summary).toContain('remember');
    expect(result.summary).toContain('recall');
    expect(result.summary).toContain('forget');
    expect(result.summary).toContain('update_memory');
  });

  it('returns not applied for empty tools after expansion', () => {
    const result = applyPermissionGrant({
      policy,
      grant: { action: 'allow', tools: [''] },
    });
    expect(result.applied).toBe(false);
  });
});

describe('buildPermissionGrantMetadata', () => {
  it('wraps grant in permissionGrant key', () => {
    const metadata = buildPermissionGrantMetadata({
      action: 'allow',
      tools: ['remember'],
    });
    expect(metadata).toEqual({
      permissionGrant: {
        action: 'allow',
        tools: ['remember'],
      },
    });
  });
});
