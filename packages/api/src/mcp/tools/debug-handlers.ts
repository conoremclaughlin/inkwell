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
import { getRequestContext, getSessionContext, getPinnedSlug } from '../../utils/request-context';

export const debugRequestContextSchema = {} as const;

export type DebugRequestContextInput = z.infer<z.ZodObject<Record<string, never>>>;

export interface DebugRequestContextResult {
  transport: string;
  pinnedSlug: string | null;
  requestContext: ReturnType<typeof getRequestContext> | null;
  sessionContext: ReturnType<typeof getSessionContext> | null;
}

export async function handleDebugRequestContext(
  _args: DebugRequestContextInput
): Promise<DebugRequestContextResult> {
  return {
    transport: process.env.MCP_TRANSPORT || 'stdio',
    pinnedSlug: getPinnedSlug(),
    requestContext: getRequestContext() ?? null,
    sessionContext: getSessionContext() ?? null,
  };
}
