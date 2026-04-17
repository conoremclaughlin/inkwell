/**
 * Debug tool handlers.
 *
 * These tools reflect server-side state back to the caller so that
 * `.live.test.ts` tests can verify end-to-end behaviour that's otherwise
 * invisible (header injection, session context, identity pinning).
 *
 * Not intended for agent use — kept intentionally small.
 */

import { z } from 'zod';
import {
  getRequestContext,
  getSessionContext,
  getPinnedAgentId,
} from '../../utils/request-context';

export const debugRequestContextSchema = {} as const;

export type DebugRequestContextInput = z.infer<z.ZodObject<Record<string, never>>>;

export interface DebugRequestContextResult {
  transport: string;
  pinnedAgentId: string | null;
  requestContext: ReturnType<typeof getRequestContext> | null;
  sessionContext: ReturnType<typeof getSessionContext> | null;
}

export async function handleDebugRequestContext(
  _args: DebugRequestContextInput
): Promise<DebugRequestContextResult> {
  return {
    transport: process.env.MCP_TRANSPORT || 'stdio',
    pinnedAgentId: getPinnedAgentId(),
    requestContext: getRequestContext() ?? null,
    sessionContext: getSessionContext() ?? null,
  };
}
