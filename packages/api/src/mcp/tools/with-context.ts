/**
 * Tool Handler Context Wrapper
 *
 * Wraps MCP tool handlers to automatically merge request context.
 * This allows tools to work with injected user context from:
 * - Authenticated web dashboard requests
 * - Channel messages (Telegram/WhatsApp)
 * - Session context
 *
 * Usage:
 * Instead of:
 *   async (args) => await handler(args, dataComposer)
 *
 * Use:
 *   withContext(handler, dataComposer)
 *
 * The wrapper will merge userId, email, platform, platformId from
 * request context when those values aren't explicitly provided in args.
 */

import { mergeWithContext, getRequestContext } from '../../utils/request-context';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolHandler<T> = (args: T, dataComposer: DataComposer) => Promise<ToolResult>;

/**
 * Wrap a tool handler to automatically merge request context.
 * Explicit args take precedence over context values.
 */
export function withContext<T extends Record<string, unknown>>(
  handler: ToolHandler<T>,
  dataComposer: DataComposer
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    // Merge context - explicit values take precedence
    const mergedArgs = mergeWithContext(args);

    // Log context usage for debugging
    const ctx = getRequestContext();
    if (ctx?.userId && !args.userId) {
      logger.debug('Tool using userId from request context', { userId: ctx.userId });
    }

    return handler(mergedArgs as T, dataComposer);
  };
}

/**
 * Create a context-aware error handler wrapper.
 * Catches errors and returns standardized error responses.
 */
export function withContextAndErrorHandler<T extends Record<string, unknown>>(
  handler: ToolHandler<T>,
  dataComposer: DataComposer,
  toolName: string
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      const mergedArgs = mergeWithContext(args);
      return await handler(mergedArgs as T, dataComposer);
    } catch (error) {
      logger.error(`Error in ${toolName}:`, error);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
