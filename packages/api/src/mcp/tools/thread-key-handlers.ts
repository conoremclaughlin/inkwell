import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import {
  ThreadKeyTypesRepository,
  type WriteIntent,
  type StudioPolicy,
} from '../../data/repositories/thread-key-types.repository';

/**
 * Thread-key type registry tools (spec: ink://specs/thread-key-grammar v2).
 *
 * The registry is data: users adjust general rules ("pr:* creates a studio")
 * without a deploy; shipped templates work out of the box. These are the only
 * write/read surfaces — behavior consumers go through ThreadKeyService.
 */

const TYPE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const listThreadKeyTypesSchema = userIdentifierBaseSchema;

export const setThreadKeyTypeSchema = userIdentifierBaseSchema.extend({
  type: z
    .string()
    .min(1)
    .max(32)
    .describe('Thread-key type name (e.g., "pr", "spec"). Lowercase [a-z0-9-].'),
  writeIntent: z
    .enum(['write', 'presence'])
    .optional()
    .describe(
      'write = sessions on this thread type take the studio write lease at spawn; presence = they run without leasing and tolerate drift'
    ),
  studioPolicy: z
    .enum(['provision', 'reuse-only'])
    .optional()
    .describe(
      'provision = routing may create worktrees (D1 parents, overflow children) for this type; reuse-only = existing studios or main only'
    ),
  description: z.string().max(500).optional().describe('What this type means'),
  reset: z
    .boolean()
    .optional()
    .describe('Delete the user override so the shipped template (or default) resumes'),
});

export async function handleListThreadKeyTypes(args: unknown, dataComposer: DataComposer) {
  const params = listThreadKeyTypesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const repo = new ThreadKeyTypesRepository(dataComposer.getClient());
  const effective = await repo.listEffective(user.id);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: effective.length,
            types: effective,
            unknownTypeDefault: {
              writeIntent: 'write',
              studioPolicy: 'reuse-only',
              note: 'Conservative until escalation-on-write ships (Phase 6e), then flips to presence.',
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleSetThreadKeyType(args: unknown, dataComposer: DataComposer) {
  const params = setThreadKeyTypeSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const repo = new ThreadKeyTypesRepository(dataComposer.getClient());

  if (params.reset) {
    const removed = await repo.clearOverride(user.id, params.type);
    const effective = await repo.getEffective(user.id, params.type);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: removed
                ? `Override for "${params.type}" removed; ${effective.source} behavior resumes`
                : `No override existed for "${params.type}"`,
              user: { id: user.id, resolvedBy },
              effective,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (!TYPE_NAME.test(params.type)) {
    throw new Error(
      `Invalid type name "${params.type}": lowercase letters, digits, and hyphens only, starting with [a-z0-9]`
    );
  }
  if (!params.writeIntent || !params.studioPolicy) {
    throw new Error('writeIntent and studioPolicy are required unless reset: true');
  }

  // Reserved-name rule, this direction (grammar v2): a type name must not
  // collide with one of the user's project slugs — that collision is the one
  // structural ambiguity in the grammar, killed at write time on BOTH sides
  // (the other side rejects project slugs colliding with type names).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: slugRows, error: slugErr } = await (dataComposer.getClient() as any)
    .from('projects')
    .select('slug')
    .eq('user_id', user.id)
    .eq('slug', params.type);
  if (slugErr) {
    // Fail closed: cannot prove no collision → refuse the write, never guess.
    throw new Error(`Could not verify type name against project slugs: ${slugErr.message}`);
  }
  if ((slugRows || []).length > 0) {
    throw new Error(
      `Type name "${params.type}" collides with your project slug "${params.type}". ` +
        `Registered type names are reserved against project slugs (thread-key-grammar v2).`
    );
  }

  const row = await repo.setOverride(user.id, params.type, {
    writeIntent: params.writeIntent as WriteIntent,
    studioPolicy: params.studioPolicy as StudioPolicy,
    description: params.description,
  });

  logger.info('[ThreadKey] Type override set', {
    userId: user.id,
    type: row.type,
    writeIntent: row.writeIntent,
    studioPolicy: row.studioPolicy,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `Type "${row.type}" set: ${row.writeIntent} + ${row.studioPolicy}`,
            user: { id: user.id, resolvedBy },
            type: {
              type: row.type,
              writeIntent: row.writeIntent,
              studioPolicy: row.studioPolicy,
              description: row.description,
              source: 'override',
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
