import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';

// Tool schemas (extend the base schema, not the refined one)
export const saveLinkSchema = userIdentifierBaseSchema.extend({
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.enum(['telegram', 'whatsapp', 'discord', 'api']).optional(),
});

export const searchLinksSchema = userIdentifierBaseSchema.extend({
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.number().min(1).max(100).default(20),
});

export const tagLinkSchema = userIdentifierBaseSchema.extend({
  linkId: z.string().uuid(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
});

// Tool handlers
export async function handleSaveLink(args: unknown, dataComposer: DataComposer) {
  const params = saveLinkSchema.parse(args);

  // Resolve user from flexible identifiers
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const link = await dataComposer.repositories.links.create({
    user_id: user.id,
    url: params.url,
    title: params.title,
    description: params.description,
    tags: params.tags || [],
    source: params.source,
    metadata: {},
  });

  logger.info(`Link saved: ${link.id} for user ${user.id} (resolved by ${resolvedBy})`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Link saved successfully',
            user: {
              id: user.id,
              resolvedBy,
            },
            link: {
              id: link.id,
              url: link.url,
              title: link.title,
              tags: link.tags,
              created_at: link.created_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleSearchLinks(args: unknown, dataComposer: DataComposer) {
  const params = searchLinksSchema.parse(args);

  // Resolve user from flexible identifiers
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const options: Parameters<typeof dataComposer.repositories.links.search>[1] = {
    query: params.query,
    tags: params.tags,
    startDate: params.startDate ? new Date(params.startDate) : undefined,
    endDate: params.endDate ? new Date(params.endDate) : undefined,
    limit: params.limit,
  };

  const links = await dataComposer.repositories.links.search(user.id, options);

  logger.info(`Found ${links.length} links for user ${user.id} (resolved by ${resolvedBy})`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: {
              id: user.id,
              resolvedBy,
            },
            count: links.length,
            links: links.map((link) => ({
              id: link.id,
              url: link.url,
              title: link.title,
              description: link.description,
              tags: link.tags,
              created_at: link.created_at,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleTagLink(args: unknown, dataComposer: DataComposer) {
  const params = tagLinkSchema.parse(args);

  // Resolve user from flexible identifiers
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let link;
  if (params.addTags && params.addTags.length > 0) {
    link = await dataComposer.repositories.links.addTags(params.linkId, user.id, params.addTags);
  }

  if (params.removeTags && params.removeTags.length > 0) {
    link = await dataComposer.repositories.links.removeTags(
      params.linkId,
      user.id,
      params.removeTags
    );
  }

  logger.info(
    `Link tags updated: ${params.linkId} for user ${user.id} (resolved by ${resolvedBy})`
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Tags updated successfully',
            user: {
              id: user.id,
              resolvedBy,
            },
            link: {
              id: link?.id,
              tags: link?.tags,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
