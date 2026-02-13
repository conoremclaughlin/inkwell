/**
 * MCP Tool Handlers for Skills
 *
 * Enables Claude to discover and read mini-app skill instructions.
 * Following the clawdbot pattern: list available skills, read on-demand.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';

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
let miniAppsRegistry: Map<string, LoadedMiniApp> | null = null;

/**
 * Register the loaded mini-apps for skill access
 * Called by server.ts after loading mini-apps
 */
export function setMiniAppsRegistry(miniApps: Map<string, LoadedMiniApp>): void {
  miniAppsRegistry = miniApps;
  logger.info(`Skills registry initialized with ${miniApps.size} mini-apps`);
}

/**
 * Get the mini-apps registry
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

export const listSkillsSchema = z.object({});

export async function handleListSkills(
  _args: z.infer<typeof listSkillsSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    if (!miniAppsRegistry || miniAppsRegistry.size === 0) {
      return mcpResponse({
        success: true,
        skills: [],
        message: 'No mini-app skills loaded.',
      });
    }

    const skills = Array.from(miniAppsRegistry.entries()).map(([name, app]) => ({
      name,
      version: app.manifest.version,
      description: app.manifest.description,
      triggers: app.manifest.triggers.keywords,
      functions: app.manifest.functions.map((f) => f.name),
      hasSkillDoc: app.skillContent.length > 0,
    }));

    return mcpResponse({
      success: true,
      skills,
      usage: 'When a user message matches a trigger, call get_skill to read the full instructions.',
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
  skillName: z.string().describe('Name of the skill/mini-app to get instructions for'),
});

export async function handleGetSkill(
  args: z.infer<typeof getSkillSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    if (!miniAppsRegistry) {
      return mcpResponse(
        {
          success: false,
          error: 'Skills registry not initialized.',
        },
        true
      );
    }

    const app = miniAppsRegistry.get(args.skillName);
    if (!app) {
      // Try case-insensitive match
      for (const [name, miniApp] of miniAppsRegistry) {
        if (name.toLowerCase() === args.skillName.toLowerCase()) {
          return mcpResponse({
            success: true,
            skillName: name,
            version: miniApp.manifest.version,
            description: miniApp.manifest.description,
            content: miniApp.skillContent || 'No skill documentation available.',
            functions: miniApp.manifest.functions,
          });
        }
      }

      return mcpResponse(
        {
          success: false,
          error: `Skill "${args.skillName}" not found.`,
          availableSkills: Array.from(miniAppsRegistry.keys()),
        },
        true
      );
    }

    logger.info(`Skill loaded: ${args.skillName}`);

    return mcpResponse({
      success: true,
      skillName: args.skillName,
      version: app.manifest.version,
      description: app.manifest.description,
      content: app.skillContent || 'No skill documentation available.',
      functions: app.manifest.functions,
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
