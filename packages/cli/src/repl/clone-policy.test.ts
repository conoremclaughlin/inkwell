import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolPolicyState } from './tool-policy.js';
import {
  CLONE_BASELINE_TOOLS,
  CLONE_DENIED_TOOLS,
  deriveClonePolicy,
  isForbiddenInClone,
} from './clone-policy.js';

function parentPolicy(mode: 'backend' | 'off' | 'privileged' = 'backend') {
  return new ToolPolicyState(mode, { persist: false });
}

describe('deriveClonePolicy', () => {
  it('grants the read-oriented baseline', () => {
    const { policy } = deriveClonePolicy(parentPolicy());
    for (const tool of ['read', 'grep', 'find', 'ls', 'recall', 'get_artifact']) {
      expect(policy.canCallPcpTool(tool).allowed).toBe(true);
    }
  });

  it('refuses the tools a clone must never have, outright', () => {
    const { policy } = deriveClonePolicy(parentPolicy());
    for (const tool of ['remember', 'send_to_inbox', 'bash', 'write', 'spawn_agent']) {
      const decision = policy.canCallPcpTool(tool);
      expect({ tool, ...decision }).toMatchObject({ tool, allowed: false, promptable: false });
    }
  });

  it('escalates an unknown tool rather than silently allowing or hard-denying it', () => {
    const { policy } = deriveClonePolicy(parentPolicy());
    const decision = policy.canCallPcpTool('save_link');
    expect(decision.allowed).toBe(false);
    // Promptable — it goes to the parent's coordinator labelled with the clone.
    expect(decision.promptable).toBe(true);
  });

  it('intersects with the parent — what the parent cannot do, the clone cannot do', () => {
    const parent = parentPolicy();
    parent.denyTool('grep');

    const { policy, narrowedByParent } = deriveClonePolicy(parent);
    expect(narrowedByParent).toContain('grep');
    expect(policy.canCallPcpTool('grep').allowed).toBe(false);
    // Siblings in the baseline are unaffected.
    expect(policy.canCallPcpTool('read').allowed).toBe(true);
  });

  it('does not inherit a baseline tool the parent only holds via a one-use grant', () => {
    const parent = parentPolicy();
    parent.addPromptTool('read');
    parent.grantTool('read', 1);

    const { policy, excludedGrantBackedTools } = deriveClonePolicy(parent);
    expect(excludedGrantBackedTools).toContain('read');
    expect(policy.canCallPcpTool('read').allowed).toBe(false);

    // And the parent's grant is still intact — deriving an envelope must not
    // spend it.
    expect(parent.listGrants()).toEqual([{ tool: 'read', uses: 1 }]);
    expect(parent.canCallPcpTool('read').allowed).toBe(true);
  });

  it('never produces a privileged clone from a privileged parent', () => {
    const parent = parentPolicy('privileged');
    const { policy } = deriveClonePolicy(parent);

    expect(policy.getMode()).toBe('backend');
    // Privileged mode short-circuits the deny list; clamping is what keeps the
    // envelope meaningful.
    expect(policy.canCallPcpTool('bash').allowed).toBe(false);
    expect(policy.canCallPcpTool('send_to_inbox').allowed).toBe(false);
  });

  it('stays off when the parent is off', () => {
    const { policy } = deriveClonePolicy(parentPolicy('off'));
    expect(policy.getMode()).toBe('off');
    expect(policy.canUseBackendTools()).toBe(false);
  });

  it('gives each clone its own state, so siblings cannot rewrite each other', () => {
    const parent = parentPolicy();
    const a = deriveClonePolicy(parent).policy;
    const b = deriveClonePolicy(parent).policy;

    // Clone A's user answering "always" for a tool must not widen clone B.
    a.allowTool('save_link');
    expect(a.canCallPcpTool('save_link').allowed).toBe(true);
    expect(b.canCallPcpTool('save_link').allowed).toBe(false);

    // And neither one touches the parent.
    expect(parent.listAllowTools()).not.toContain('save_link');
  });

  it('cannot write policy to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clone-policy-'));
    const policyPath = join(dir, 'tool-policy.json');
    try {
      const parent = new ToolPolicyState('backend', { persist: true, policyPath });
      parent.allowTool('read');
      const before = readFileSync(policyPath, 'utf8');

      const { policy } = deriveClonePolicy(parent);
      policy.allowTool('save_link');
      policy.grantTool('save_link', 5);

      // The clone shares the parent's path in name only — persist:false means
      // nothing it does reaches durable policy.
      expect(readFileSync(policyPath, 'utf8')).toBe(before);
      expect(parent.listAllowTools()).not.toContain('save_link');
      expect(parent.listGrants()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inherits parent denials on top of its own', () => {
    const parent = parentPolicy();
    parent.denyTool('list_emails');

    const { policy } = deriveClonePolicy(parent);
    expect(policy.canCallPcpTool('list_emails').allowed).toBe(false);
    expect(policy.canCallPcpTool('list_emails').promptable).toBe(false);
  });

  it('inherits the parent read-path allowlist and grants no write paths', () => {
    const parent = parentPolicy();
    parent.addReadPathAllow('/Users/conor/ws/**');

    const { policy } = deriveClonePolicy(parent);
    expect(policy.isReadPathAllowed('/Users/conor/ws/file.ts')).toBe(true);
    expect(policy.isReadPathAllowed('/etc/passwd')).toBe(false);
    expect(policy.listWritePathAllow()).toEqual([]);
  });

  it('accepts extra tools but still intersects them with the parent', () => {
    const parent = parentPolicy();
    parent.denyTool('list_reminders');

    const { policy } = deriveClonePolicy(parent, {
      additionalTools: ['save_link', 'list_reminders'],
    });
    expect(policy.canCallPcpTool('save_link').allowed).toBe(true);
    expect(policy.canCallPcpTool('list_reminders').allowed).toBe(false);
  });

  it('refuses to widen the envelope through additionalTools', () => {
    const { policy } = deriveClonePolicy(parentPolicy(), { additionalTools: ['bash', 'remember'] });
    expect(policy.canCallPcpTool('bash').allowed).toBe(false);
    expect(policy.canCallPcpTool('remember').allowed).toBe(false);
  });

  it('recomputes backend gating from the clone envelope, not the parent', () => {
    const parent = parentPolicy();
    parent.allowTool('group:ink-comms');
    parent.allowTool('group:read');

    const parentGate = parent.getBackendToolGate();
    expect(parentGate.allowedTools).toEqual(expect.arrayContaining(['send_to_inbox', 'read']));

    // The clone's gate is derived from its own policy. Inheriting the parent's
    // passthroughArgs would hand a narrowed clone the parent's tool surface.
    const { policy } = deriveClonePolicy(parent);
    const cloneGate = policy.getBackendToolGate();
    expect(cloneGate.allowedTools).not.toContain('send_to_inbox');
    expect(cloneGate.allowedTools).not.toContain('trigger_agent');
    expect(cloneGate.allowedTools).toEqual(expect.arrayContaining(['read', 'grep']));
  });

  it("narrows the baseline to what the parent's own allowlist permits", () => {
    // A parent restricted to comms cannot read files, so neither can its clone —
    // the baseline is a ceiling on the intersection, not a floor under it.
    const parent = parentPolicy();
    parent.allowTool('group:ink-comms');

    const { policy, narrowedByParent } = deriveClonePolicy(parent);
    expect(narrowedByParent).toContain('read');
    expect(policy.canCallPcpTool('read').allowed).toBe(false);
  });

  it('leaves the default safe read-only tools reachable', () => {
    // DEFAULT_SAFE_PCP_TOOLS bypass allowlist narrowing by design. Every member
    // is read-only, so the clone envelope tolerates the union — but a parent
    // denial still wins.
    const parent = parentPolicy();
    const { policy } = deriveClonePolicy(parent);
    expect(policy.canCallPcpTool('get_inbox').allowed).toBe(true);

    parent.denyTool('get_inbox');
    const { policy: narrowed } = deriveClonePolicy(parent);
    expect(narrowed.canCallPcpTool('get_inbox').allowed).toBe(false);
  });
});

describe('isForbiddenInClone', () => {
  it('recognises forbidden tools with or without the MCP namespace', () => {
    expect(isForbiddenInClone('spawn_agent')).toBe(true);
    expect(isForbiddenInClone('mcp__inkwell__send_to_inbox')).toBe(true);
    expect(isForbiddenInClone('read')).toBe(false);
  });
});

describe('envelope definition', () => {
  it('keeps the baseline and the denylist disjoint', () => {
    const overlap = CLONE_BASELINE_TOOLS.filter((t) => CLONE_DENIED_TOOLS.includes(t));
    expect(overlap).toEqual([]);
  });

  it('denies every write-shaped Pi tool', () => {
    for (const tool of ['write', 'edit', 'bash']) {
      expect(CLONE_DENIED_TOOLS).toContain(tool);
      expect(CLONE_BASELINE_TOOLS).not.toContain(tool);
    }
  });
});
