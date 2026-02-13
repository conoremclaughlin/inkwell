/**
 * Skill Management MCP Tool Handlers
 *
 * Tools for publishing, updating, forking, and deprecating skills.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUser, userIdentifierFields } from '../../services/user-resolver';
import { SkillsRepository } from '../../skills/repository';
import { logger } from '../../utils/logger';
import type { SkillType, SkillManifest } from '../../skills/types';

// ============================================================================
// Helper
// ============================================================================

function mcpResponse(data: Record<string, unknown>, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    ...(isError && { isError: true }),
  };
}

// ============================================================================
// PUBLISH SKILL
// ============================================================================

export const publishSkillSchema = {
  ...userIdentifierFields,
  name: z.string().min(1).max(100).describe('Unique skill name (lowercase, hyphens)'),
  displayName: z.string().min(1).max(200).describe('Human-readable display name'),
  description: z.string().min(1).max(2000).describe('Skill description'),
  type: z.enum(['mini-app', 'cli', 'guide']).describe('Skill type'),
  category: z.string().optional().describe('Category for organization'),
  tags: z.array(z.string()).optional().describe('Tags for search'),
  emoji: z.string().optional().describe('Visual identifier emoji'),
  version: z.string().default('1.0.0').describe('Semantic version'),
  content: z.string().describe('SKILL.md content'),
  manifest: z.record(z.unknown()).optional().describe('Additional manifest fields'),
  isPublic: z.boolean().default(true).describe('Visible in registry'),
};

export async function handlePublishSkill(
  args: Record<string, unknown>,
  dataComposer: DataComposer
) {
  try {
    const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const repository = new SkillsRepository(dataComposer.getClient());

    const skill = await repository.publishSkill({
      name: args.name as string,
      displayName: args.displayName as string,
      description: args.description as string,
      type: args.type as SkillType,
      category: args.category as string | undefined,
      tags: args.tags as string[] | undefined,
      emoji: args.emoji as string | undefined,
      version: (args.version as string) || '1.0.0',
      content: args.content as string,
      manifest: (args.manifest as Partial<SkillManifest>) || {},
      authorUserId: resolved.user.id,
      isPublic: args.isPublic !== false,
    });

    logger.info(`Skill published: ${skill.name} by user ${resolved.user.id}`);

    return mcpResponse({
      success: true,
      message: `Skill "${skill.name}" published successfully`,
      skill: {
        id: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        version: skill.currentVersion,
      },
      user: { id: resolved.user.id, resolvedBy: resolved.resolvedBy },
    });
  } catch (error) {
    logger.error('Error in publish_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to publish skill',
      },
      true
    );
  }
}

// ============================================================================
// UPDATE SKILL
// ============================================================================

export const updateSkillSchema = {
  ...userIdentifierFields,
  skillId: z.string().uuid().describe('Skill ID to update'),
  version: z.string().describe('New version (required for updates)'),
  displayName: z.string().optional().describe('Updated display name'),
  description: z.string().optional().describe('Updated description'),
  category: z.string().nullable().optional().describe('Updated category'),
  tags: z.array(z.string()).optional().describe('Updated tags'),
  emoji: z.string().nullable().optional().describe('Updated emoji'),
  content: z.string().optional().describe('Updated SKILL.md content'),
  manifest: z.record(z.unknown()).optional().describe('Updated manifest fields'),
  changelog: z.string().optional().describe('What changed in this version'),
};

export async function handleUpdateSkill(args: Record<string, unknown>, dataComposer: DataComposer) {
  try {
    const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    if (!args.version) {
      return mcpResponse({ success: false, error: 'Version is required for updates' }, true);
    }

    const repository = new SkillsRepository(dataComposer.getClient());

    const skill = await repository.updateSkillWithVersion(
      args.skillId as string,
      resolved.user.id,
      {
        displayName: args.displayName as string | undefined,
        description: args.description as string | undefined,
        category: args.category as string | null | undefined,
        tags: args.tags as string[] | undefined,
        emoji: args.emoji as string | null | undefined,
        version: args.version as string,
        content: args.content as string | undefined,
        manifest: args.manifest as Partial<SkillManifest> | undefined,
        changelog: args.changelog as string | undefined,
      }
    );

    return mcpResponse({
      success: true,
      message: `Skill updated to version ${args.version}`,
      skill: {
        id: skill.id,
        name: skill.name,
        version: skill.currentVersion,
      },
      user: { id: resolved.user.id, resolvedBy: resolved.resolvedBy },
    });
  } catch (error) {
    logger.error('Error in update_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update skill',
      },
      true
    );
  }
}

// ============================================================================
// FORK SKILL
// ============================================================================

export const forkSkillSchema = {
  ...userIdentifierFields,
  sourceSkillId: z.string().uuid().describe('Skill ID to fork'),
  name: z.string().min(1).max(100).describe('New skill name'),
  displayName: z.string().optional().describe('New display name'),
  description: z.string().optional().describe('Custom description'),
  category: z.string().optional().describe('Custom category'),
  tags: z.array(z.string()).optional().describe('Custom tags'),
};

export async function handleForkSkill(args: Record<string, unknown>, dataComposer: DataComposer) {
  try {
    const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const repository = new SkillsRepository(dataComposer.getClient());

    const skill = await repository.forkSkill({
      sourceSkillId: args.sourceSkillId as string,
      newName: args.name as string,
      newDisplayName: args.displayName as string | undefined,
      forkerUserId: resolved.user.id,
      customizations: {
        description: args.description as string | undefined,
        category: args.category as string | undefined,
        tags: args.tags as string[] | undefined,
      },
    });

    return mcpResponse({
      success: true,
      message: `Forked skill as "${args.name}"`,
      skill: {
        id: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        forkedFrom: args.sourceSkillId,
      },
      user: { id: resolved.user.id, resolvedBy: resolved.resolvedBy },
    });
  } catch (error) {
    logger.error('Error in fork_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fork skill',
      },
      true
    );
  }
}

// ============================================================================
// DEPRECATE SKILL
// ============================================================================

export const deprecateSkillSchema = {
  ...userIdentifierFields,
  skillId: z.string().uuid().describe('Skill ID to deprecate'),
  message: z.string().optional().describe('Deprecation message (e.g., migration guidance)'),
};

export async function handleDeprecateSkill(
  args: Record<string, unknown>,
  dataComposer: DataComposer
) {
  try {
    const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const repository = new SkillsRepository(dataComposer.getClient());

    const skill = await repository.deprecateSkill({
      skillId: args.skillId as string,
      userId: resolved.user.id,
      message: args.message as string | undefined,
    });

    return mcpResponse({
      success: true,
      message: `Skill "${skill.name}" marked as deprecated`,
      skill: {
        id: skill.id,
        name: skill.name,
        status: skill.status,
        deprecationMessage: skill.deprecationMessage,
      },
      user: { id: resolved.user.id, resolvedBy: resolved.resolvedBy },
    });
  } catch (error) {
    logger.error('Error in deprecate_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to deprecate skill',
      },
      true
    );
  }
}

// ============================================================================
// DELETE SKILL
// ============================================================================

export const deleteSkillSchema = {
  ...userIdentifierFields,
  skillId: z.string().uuid().describe('Skill ID to delete'),
};

export async function handleDeleteSkill(args: Record<string, unknown>, dataComposer: DataComposer) {
  try {
    const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const repository = new SkillsRepository(dataComposer.getClient());

    // Get skill name before deletion for response
    const skill = await repository.getSkillById(args.skillId as string);
    if (!skill) {
      return mcpResponse({ success: false, error: 'Skill not found' }, true);
    }

    await repository.deleteSkill(args.skillId as string, resolved.user.id);

    return mcpResponse({
      success: true,
      message: `Skill "${skill.name}" deleted`,
      skillId: args.skillId,
      user: { id: resolved.user.id, resolvedBy: resolved.resolvedBy },
    });
  } catch (error) {
    logger.error('Error in delete_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete skill',
      },
      true
    );
  }
}
