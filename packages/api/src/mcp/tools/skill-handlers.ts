/**
 * MCP Tool Handlers for Skills
 *
 * Enables AI agents to discover and read skill instructions.
 * Uses the SkillsService (4-tier cascade) for all skill types,
 * plus the miniAppsRegistry for dynamic MCP tool registration.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { getSkillsService } from '../../skills/service';

// Type for loaded mini-app (matches loader.ts)
interface LoadedMiniApp {
  manifest: {
    name: string;
    version: string;
    description: string;
    triggers: {
      keywords: string[];
      intents?: string[];
    };
    functions: Array<{
      name: string;
      description: string;
    }>;
  };
  skillContent: string;
}

// Registry of loaded mini-apps (set by server startup)
// Used for dynamic MCP tool registration — separate from SkillsService browsing
let miniAppsRegistry: Map<string, LoadedMiniApp> | null = null;

/**
 * Register the loaded mini-apps for dynamic tool access
 * Called by server.ts after loading mini-apps
 */
export function setMiniAppsRegistry(miniApps: Map<string, LoadedMiniApp>): void {
  miniAppsRegistry = miniApps;
  logger.info(`Mini-apps registry initialized with ${miniApps.size} mini-apps`);
}

/**
 * Get the mini-apps registry (for dynamic tool registration)
 */
export function getMiniAppsRegistry(): Map<string, LoadedMiniApp> | null {
  return miniAppsRegistry;
}

// ============================================================================
// MCP Tool Response Helper
// ============================================================================

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

// ============================================================================
// LIST SKILLS
// ============================================================================

export const listSkillsSchema = z.object({
  includeContent: z
    .boolean()
    .optional()
    .describe('Include full skill content for guide-type skills (for session injection)'),
});

export async function handleListSkills(
  args: z.infer<typeof listSkillsSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const service = getSkillsService();
    const { skills: allSkills } = service.listSkills();

    if (allSkills.length === 0) {
      return mcpResponse({
        success: true,
        skills: [],
        message: 'No skills loaded.',
      });
    }

    const skills = allSkills.map((s) => {
      const base: Record<string, unknown> = {
        name: s.name,
        displayName: s.displayName,
        type: s.type,
        version: s.version,
        description: s.description,
        status: s.status,
        triggers: s.triggers,
        functionCount: s.functionCount,
        capabilities: s.capabilities,
        ...(s.mcp ? { mcp: s.mcp } : {}),
      };

      // Include full content for guides when requested (for hook injection)
      if (args.includeContent && s.type === 'guide' && s.eligibility?.eligible !== false) {
        const detail = service.getSkill(s.name);
        if (detail?.skillContent) {
          base.content = detail.skillContent;
        }
      }

      return base;
    });

    return mcpResponse({
      success: true,
      skills,
      usage:
        'Call get_skill with a skill name for full instructions. Guide skills are behavioral — follow their instructions when active.',
    });
  } catch (error) {
    logger.error('Error in list_skills:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list skills',
      },
      true
    );
  }
}

// ============================================================================
// GET SKILL
// ============================================================================

export const getSkillSchema = z.object({
  skillName: z.string().describe('Name of the skill to get instructions for'),
});

export async function handleGetSkill(
  args: z.infer<typeof getSkillSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const service = getSkillsService();
    const detail = service.getSkill(args.skillName);

    if (!detail) {
      // Try case-insensitive match
      const { skills: allSkills } = service.listSkills();
      const match = allSkills.find((s) => s.name.toLowerCase() === args.skillName.toLowerCase());
      if (match) {
        const matchDetail = service.getSkill(match.name);
        if (matchDetail) {
          return mcpResponse({
            success: true,
            skillName: match.name,
            type: matchDetail.manifest.type,
            version: matchDetail.manifest.version,
            description: matchDetail.manifest.description,
            content: matchDetail.skillContent || 'No skill documentation available.',
            functions: matchDetail.manifest.functions,
            triggers: matchDetail.manifest.triggers,
            ...(matchDetail.manifest.mcp ? { mcp: matchDetail.manifest.mcp } : {}),
          });
        }
      }

      return mcpResponse(
        {
          success: false,
          error: `Skill "${args.skillName}" not found.`,
          availableSkills: allSkills.map((s) => s.name),
        },
        true
      );
    }

    logger.info(`Skill loaded: ${args.skillName}`);

    return mcpResponse({
      success: true,
      skillName: args.skillName,
      type: detail.manifest.type,
      version: detail.manifest.version,
      description: detail.manifest.description,
      content: detail.skillContent || 'No skill documentation available.',
      functions: detail.manifest.functions,
      triggers: detail.manifest.triggers,
      ...(detail.manifest.mcp ? { mcp: detail.manifest.mcp } : {}),
    });
  } catch (error) {
    logger.error('Error in get_skill:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get skill',
      },
      true
    );
  }
}
