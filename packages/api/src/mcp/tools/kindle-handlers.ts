/**
 * Kindle MCP Tool Handlers
 *
 * Exposes kindle functionality via MCP so existing SBs can generate
 * invite links from within conversations (Myra, Wren, Benson, etc.)
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { getKindleService } from '../../services/kindle/kindle-service';
import { logger } from '../../utils/logger';

export const createKindleTokenSchema = userIdentifierBaseSchema.extend({
  agentId: z
    .string()
    .optional()
    .describe("Parent agent ID whose values will seed the new SB"),
  expiresInHours: z
    .number()
    .optional()
    .default(168)
    .describe('Token expiry in hours (default: 168 = 7 days)'),
});

export async function handleCreateKindleToken(
  args: unknown,
  dataComposer: DataComposer
) {
  const params = createKindleTokenSchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);

  const kindleService = getKindleService();
  const token = await kindleService.createKindleToken(
    user.id,
    params.agentId,
    params.expiresInHours
  );

  const webPortalUrl = process.env.WEB_PORTAL_URL || 'http://localhost:3002';
  const inviteUrl = `${webPortalUrl}/kindle/${token.token}`;

  logger.info('Kindle token created via MCP', {
    userId: user.id,
    agentId: params.agentId,
    tokenId: token.id,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          token: token.token,
          inviteUrl,
          expiresAt: token.expiresAt,
          valueSeed: token.valueSeed,
        }),
      },
    ],
  };
}
