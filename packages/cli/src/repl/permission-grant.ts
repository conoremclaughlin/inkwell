import { expandPolicySpecs } from '@personal-context/shared';
import { ToolPolicyState, TOOL_GROUPS, type ToolPolicyScopeRef } from './tool-policy.js';

export type PermissionGrantAction = 'allow' | 'deny' | 'grant' | 'grant-session' | 'revoke';

export interface PermissionGrantPayload {
  action: PermissionGrantAction;
  tools: string[];
  uses?: number;
  reason?: string;
}

const VALID_ACTIONS = new Set<string>(['allow', 'deny', 'grant', 'grant-session', 'revoke']);

/**
 * Parse and validate a permission grant payload from inbox metadata.
 * Returns null if the metadata is malformed or missing.
 */
export function parsePermissionGrant(metadata: unknown): PermissionGrantPayload | null {
  if (!metadata || typeof metadata !== 'object') return null;

  const obj = metadata as Record<string, unknown>;
  const grant = obj.permissionGrant;
  if (!grant || typeof grant !== 'object') return null;

  const payload = grant as Record<string, unknown>;

  // Validate action
  const action = String(payload.action || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) return null;

  // Validate tools — must be a non-empty string array
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return null;
  const tools = payload.tools
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean);
  if (tools.length === 0) return null;

  const result: PermissionGrantPayload = {
    action: action as PermissionGrantAction,
    tools,
  };

  if (typeof payload.uses === 'number' && payload.uses > 0) {
    result.uses = Math.floor(payload.uses);
  }
  if (typeof payload.reason === 'string' && payload.reason.trim()) {
    result.reason = payload.reason.trim();
  }

  return result;
}

/**
 * Apply a permission grant to the local tool policy.
 * Returns a human-readable summary and whether it was applied.
 */
export function applyPermissionGrant(params: {
  policy: ToolPolicyState;
  grant: PermissionGrantPayload;
  sessionId?: string;
  scope?: ToolPolicyScopeRef;
}): { applied: boolean; summary: string } {
  const { policy, grant, sessionId, scope } = params;

  // Expand group specs to individual tool names for the summary
  const expandedTools = expandPolicySpecs(grant.tools, TOOL_GROUPS);
  if (expandedTools.length === 0) {
    return { applied: false, summary: 'No valid tools specified.' };
  }

  const toolList = expandedTools.join(', ');

  switch (grant.action) {
    case 'allow':
      for (const tool of grant.tools) {
        policy.allowTool(tool, scope);
      }
      return { applied: true, summary: `${toolList} (always)` };

    case 'deny':
      for (const tool of grant.tools) {
        policy.denyTool(tool, scope);
      }
      return { applied: true, summary: `${toolList} (denied)` };

    case 'grant': {
      const uses = grant.uses || 1;
      for (const tool of grant.tools) {
        policy.grantTool(tool, uses, scope);
      }
      const suffix = uses === 1 ? 'once' : `${uses} uses`;
      return { applied: true, summary: `${toolList} (${suffix})` };
    }

    case 'grant-session':
      if (!sessionId) {
        // Fall back to single-use grant if no session
        for (const tool of grant.tools) {
          policy.grantTool(tool, 1, scope);
        }
        return { applied: true, summary: `${toolList} (once — no session for session grant)` };
      }
      for (const tool of expandedTools) {
        policy.grantToolForSession(sessionId, tool);
      }
      return { applied: true, summary: `${toolList} (session)` };

    case 'revoke':
      for (const tool of grant.tools) {
        policy.removeToolRule(tool, scope);
      }
      return { applied: true, summary: `${toolList} (revoked)` };

    default:
      return { applied: false, summary: `Unknown action: ${grant.action}` };
  }
}

/**
 * Build a structured permission grant metadata payload for sending via inbox.
 */
export function buildPermissionGrantMetadata(grant: PermissionGrantPayload): Record<string, unknown> {
  return { permissionGrant: grant };
}
