/**
 * Pi Coding Tools Adapter
 *
 * Bridges @mariozechner/pi-coding-agent's tool factories into Ink's
 * direct-api backend tool format (Anthropic.Tool + execution).
 *
 * Pi packages are ESM-only, so we use dynamic import().
 */

import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../utils/logger';

// Pi tool types — widened to accept TypeBox TObject schemas
interface PiAgentTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    callId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => Promise<unknown>;
}

interface PiToolResult {
  content?: Array<{ type: string; text?: string }>;
}

export interface InkToolDefinition {
  /** Anthropic API tool schema (for sending to the LLM) */
  schema: Anthropic.Tool;
  /** Execute the tool and return a string result */
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

export interface PiCodingToolsConfig {
  /** Working directory — scopes all filesystem tools to this path */
  cwd: string;
  /** Tools to include (default: all) */
  include?: Array<'read' | 'write' | 'edit' | 'bash' | 'grep' | 'find' | 'ls'>;
  /** Tools to exclude */
  exclude?: Array<'read' | 'write' | 'edit' | 'bash' | 'grep' | 'find' | 'ls'>;
  /** Enforce workspace root boundary — blocks access outside cwd (default: true) */
  enforceWorkspaceRoot?: boolean;
}

const TOOLS_WITH_PATH_PARAM = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);

function isPathWithinWorkspace(filePath: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, filePath);
  const normalizedCwd = path.resolve(cwd);
  return resolved.startsWith(normalizedCwd + path.sep) || resolved === normalizedCwd;
}

interface PiModuleExports {
  createCodingTools: (cwd: string) => PiAgentTool[];
  createGrepTool: (cwd: string, ...args: unknown[]) => PiAgentTool;
  createFindTool: (cwd: string, ...args: unknown[]) => PiAgentTool;
  createLsTool: (cwd: string, ...args: unknown[]) => PiAgentTool;
}

let piModule: PiModuleExports | null = null;

async function loadPiModule(): Promise<PiModuleExports> {
  if (piModule) return piModule;
  const mod = (await import('@mariozechner/pi-coding-agent')) as Record<string, unknown>;
  piModule = {
    createCodingTools: mod.createCodingTools as PiModuleExports['createCodingTools'],
    createGrepTool: mod.createGrepTool as PiModuleExports['createGrepTool'],
    createFindTool: mod.createFindTool as PiModuleExports['createFindTool'],
    createLsTool: mod.createLsTool as PiModuleExports['createLsTool'],
  };
  return piModule;
}

function piParametersToJsonSchema(params: unknown): Record<string, unknown> {
  if (!params) return { type: 'object', properties: {} };
  if (typeof params !== 'object') return { type: 'object', properties: {} };

  const p = params as Record<string, unknown>;
  // Pi uses TypeBox schemas — they compile to standard JSON Schema
  // The 'properties' and 'type' fields should already be present
  if (p.type === 'object' && p.properties) {
    return p;
  }

  // Fallback: wrap in an object schema
  return { type: 'object', properties: p };
}

function formatToolResult(result: unknown): string {
  if (result === null || result === undefined) {
    return '(no output)';
  }

  // Pi tools return { content: [{ type: 'text', text: '...' }] }
  if (typeof result === 'object' && result !== null) {
    const r = result as PiToolResult;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');
    }
  }

  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * Create Pi coding tools adapted for Ink's direct-api backend.
 *
 * Returns both the Anthropic.Tool schemas (for the API call) and
 * execute functions (for handling tool_use responses).
 */
export async function createInkCodingTools(
  config: PiCodingToolsConfig
): Promise<InkToolDefinition[]> {
  const pi = await loadPiModule();

  // createCodingTools gives us: read, bash, edit, write
  // Add grep, find, ls individually for the full coding toolset
  const rawTools: PiAgentTool[] = [
    ...pi.createCodingTools(config.cwd),
    pi.createGrepTool(config.cwd),
    pi.createFindTool(config.cwd),
    pi.createLsTool(config.cwd),
  ];

  // Filter tools based on include/exclude
  let tools = rawTools;
  if (config.include) {
    const includeSet = new Set(config.include);
    tools = tools.filter((t) => includeSet.has(t.name as any));
  }
  if (config.exclude) {
    const excludeSet = new Set(config.exclude);
    tools = tools.filter((t) => !excludeSet.has(t.name as any));
  }

  logger.info('Pi coding tools loaded', {
    cwd: config.cwd,
    tools: tools.map((t) => t.name),
  });

  const enforceRoot = config.enforceWorkspaceRoot !== false;

  return tools.map((tool) => ({
    schema: {
      name: tool.name,
      description: tool.description || `${tool.name} tool`,
      input_schema: piParametersToJsonSchema(tool.parameters) as Anthropic.Tool.InputSchema,
    },
    execute: async (params: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
      // Workspace root enforcement for file-based tools
      if (enforceRoot && TOOLS_WITH_PATH_PARAM.has(tool.name)) {
        const filePath = (params.path as string) || '';
        if (filePath && !isPathWithinWorkspace(filePath, config.cwd)) {
          return `Error: Access denied — path "${filePath}" is outside workspace root "${config.cwd}"`;
        }
      }

      const callId = `ink-${tool.name}-${Date.now()}`;
      try {
        const result = await tool.execute(callId, params, signal);
        return formatToolResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Pi tool ${tool.name} failed`, { error: message, params });
        return `Error: ${message}`;
      }
    },
  }));
}

/**
 * Convenience: get just the Anthropic.Tool schemas (for setTools).
 */
export async function getPiToolSchemas(config: PiCodingToolsConfig): Promise<Anthropic.Tool[]> {
  const tools = await createInkCodingTools(config);
  return tools.map((t) => t.schema);
}

/**
 * Create a tool executor map for handling tool_use responses.
 */
export async function createPiToolExecutor(
  config: PiCodingToolsConfig
): Promise<Map<string, InkToolDefinition['execute']>> {
  const tools = await createInkCodingTools(config);
  const map = new Map<string, InkToolDefinition['execute']>();
  for (const tool of tools) {
    map.set(tool.schema.name, tool.execute);
  }
  return map;
}
