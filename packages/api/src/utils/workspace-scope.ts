import { getRequestContext, mergeWithContext } from './request-context';

export type WorkspaceScopeSource = 'header' | 'derived' | 'context';

export interface ResolvedWorkspaceScope {
  workspaceId: string;
  source: WorkspaceScopeSource;
}

export interface ResolveWorkspaceScopeForWriteParams {
  rawArgs: Record<string, unknown>;
  explicitWorkspaceId?: string;
  agentId?: string;
  deriveWorkspaceIdFromAgent?: (agentId: string) => Promise<string | null>;
}

export interface ResolveWorkspaceContextForRequestParams {
  requestedWorkspaceId?: string;
  validateRequestedWorkspaceId?: (workspaceId: string) => Promise<boolean>;
  deriveWorkspaceIdFromAgent?: () => Promise<string | null>;
}

/**
 * Resolve workspace scope for write operations with stable precedence:
 * 1) Header-derived request context (authoritative)
 * 2) Agent-derived workspace (injectable callback)
 * 3) Merged request/session/args fallback
 */
export async function resolveWorkspaceScopeForWrite({
  rawArgs,
  explicitWorkspaceId,
  agentId,
  deriveWorkspaceIdFromAgent,
}: ResolveWorkspaceScopeForWriteParams): Promise<ResolvedWorkspaceScope | null> {
  const reqCtx = getRequestContext();
  if (reqCtx?.workspaceSource === 'header' && reqCtx.workspaceId) {
    return { workspaceId: reqCtx.workspaceId, source: 'header' };
  }

  if (reqCtx?.workspaceSource === 'derived' && reqCtx.workspaceId) {
    return { workspaceId: reqCtx.workspaceId, source: 'derived' };
  }

  if (agentId && deriveWorkspaceIdFromAgent) {
    const derived = await deriveWorkspaceIdFromAgent(agentId);
    if (derived) {
      return { workspaceId: derived, source: 'derived' };
    }
  }

  const mergedWorkspaceId = mergeWithContext(rawArgs).workspaceId;
  const fallbackWorkspaceId =
    typeof mergedWorkspaceId === 'string' ? mergedWorkspaceId : explicitWorkspaceId;
  if (fallbackWorkspaceId) {
    return { workspaceId: fallbackWorkspaceId, source: 'context' };
  }

  return null;
}

/**
 * Resolve workspace context at request entry (middleware/onion layer):
 * 1) Header workspace when provided and authorized
 * 2) Agent-derived workspace (injectable callback)
 * 3) No workspace context (tool-level fallback may still apply)
 */
export async function resolveWorkspaceContextForRequest({
  requestedWorkspaceId,
  validateRequestedWorkspaceId,
  deriveWorkspaceIdFromAgent,
}: ResolveWorkspaceContextForRequestParams): Promise<{
  workspaceId: string;
  source: 'header' | 'derived';
} | null> {
  if (requestedWorkspaceId) {
    if (validateRequestedWorkspaceId) {
      const allowed = await validateRequestedWorkspaceId(requestedWorkspaceId);
      if (!allowed) {
        throw new Error(`Workspace not found or not accessible: ${requestedWorkspaceId}`);
      }
    }
    return { workspaceId: requestedWorkspaceId, source: 'header' };
  }

  if (deriveWorkspaceIdFromAgent) {
    const derived = await deriveWorkspaceIdFromAgent();
    if (derived) {
      return { workspaceId: derived, source: 'derived' };
    }
  }

  return null;
}
