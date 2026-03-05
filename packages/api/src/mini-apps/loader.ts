/**
 * Mini-App Loader
 *
 * Discovers and loads mini-apps from the mini-apps directory.
 * Registers their functions as MCP tools.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../utils/logger';

// Import mini-app functions directly (for now, we'll make this dynamic later)
import * as billSplitFunctions from './bill-split/functions';

interface MiniAppManifest {
  name: string;
  version: string;
  description: string;
  triggers: {
    keywords: string[];
    intents?: string[];
  };
  capabilities?: {
    vision?: boolean;
    memory?: boolean;
  };
  functions: Array<{
    name: string;
    description: string;
    input: Record<string, string>;
    output: Record<string, string>;
  }>;
  entry: string;
}

export interface LoadedMiniApp {
  manifest: MiniAppManifest;
  skillContent: string;
  functions: Record<string, (...args: unknown[]) => unknown>;
}

const MINI_APPS_DIR = join(__dirname);

// Mini-apps hidden from tool registration (code preserved, just not loaded).
// Remove entries here to re-enable.
const HIDDEN_MINI_APPS = new Set(['bill-split']);

/**
 * Load all mini-apps from the mini-apps directory
 */
export function loadMiniApps(): Map<string, LoadedMiniApp> {
  const miniApps = new Map<string, LoadedMiniApp>();

  try {
    const entries = readdirSync(MINI_APPS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (HIDDEN_MINI_APPS.has(entry.name)) continue;

      const appDir = join(MINI_APPS_DIR, entry.name);
      const manifestPath = join(appDir, 'manifest.json');
      const skillPath = join(appDir, 'SKILL.md');

      if (!existsSync(manifestPath)) continue;

      try {
        const manifest: MiniAppManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        const skillContent = existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : '';

        // Load functions based on app name
        let functions: Record<string, (...args: unknown[]) => unknown> = {};
        if (entry.name === 'bill-split') {
          functions = billSplitFunctions as unknown as Record<
            string,
            (...args: unknown[]) => unknown
          >;
        }

        miniApps.set(manifest.name, {
          manifest,
          skillContent,
          functions,
        });

        logger.info(`Loaded mini-app: ${manifest.name} v${manifest.version}`);
      } catch (error) {
        logger.error(`Failed to load mini-app ${entry.name}:`, error);
      }
    }
  } catch (error) {
    logger.error('Failed to scan mini-apps directory:', error);
  }

  return miniApps;
}

/**
 * Register mini-app functions as MCP tools
 */
export function registerMiniAppTools(
  server: McpServer,
  miniApps: Map<string, LoadedMiniApp>
): void {
  for (const [appName, app] of miniApps) {
    const prefix = appName.replace(/-/g, '_');

    for (const funcDef of app.manifest.functions) {
      const toolName = `${prefix}_${funcDef.name}`;
      const func = app.functions[funcDef.name];

      if (!func) {
        logger.warn(`Function ${funcDef.name} not found in ${appName}`);
        continue;
      }

      // Build input schema from manifest
      const inputSchema: Record<string, z.ZodType> = {};
      for (const [key, type] of Object.entries(funcDef.input)) {
        const isOptional = type.endsWith('?');
        const baseType = type.replace('?', '');

        let zodType: z.ZodType;
        switch (baseType) {
          case 'string':
            zodType = z.string();
            break;
          case 'number':
            zodType = z.number();
            break;
          case 'boolean':
            zodType = z.boolean();
            break;
          case 'array':
            zodType = z.array(z.unknown());
            break;
          case 'object':
            zodType = z.record(z.unknown());
            break;
          default:
            zodType = z.unknown();
        }

        inputSchema[key] = isOptional ? zodType.optional() : zodType;
      }

      server.registerTool(
        toolName,
        {
          description: `[${appName}] ${funcDef.description}`,
          inputSchema,
        },
        async (args) => {
          try {
            const result = func(args);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error) {
            logger.error(`Error in ${toolName}:`, error);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: error instanceof Error ? error.message : 'Unknown error',
                  }),
                },
              ],
              isError: true,
            };
          }
        }
      );

      logger.debug(`Registered tool: ${toolName}`);
    }
  }
}

/**
 * Get skill content for a mini-app (for injection into prompts)
 */
export function getMiniAppSkill(
  miniApps: Map<string, LoadedMiniApp>,
  appName: string
): string | null {
  const app = miniApps.get(appName);
  return app?.skillContent || null;
}

/**
 * Check if a message might trigger a mini-app based on keywords
 */
export function detectMiniAppTrigger(
  miniApps: Map<string, LoadedMiniApp>,
  message: string
): string | null {
  const lowerMessage = message.toLowerCase();

  for (const [appName, app] of miniApps) {
    for (const keyword of app.manifest.triggers.keywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        return appName;
      }
    }
  }

  return null;
}

/**
 * Get all loaded mini-apps info
 */
export function getMiniAppsInfo(miniApps: Map<string, LoadedMiniApp>): Array<{
  name: string;
  version: string;
  description: string;
  triggers: string[];
  functions: string[];
}> {
  return Array.from(miniApps.values()).map((app) => ({
    name: app.manifest.name,
    version: app.manifest.version,
    description: app.manifest.description,
    triggers: app.manifest.triggers.keywords,
    functions: app.manifest.functions.map((f) => f.name),
  }));
}
