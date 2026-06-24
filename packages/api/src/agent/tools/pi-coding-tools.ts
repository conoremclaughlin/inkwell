/**
 * Pi Coding Tools Adapter
 *
 * Bridges @mariozechner/pi-coding-agent's tool factories into Ink's
 * Ink backend tool format (Anthropic.Tool + execution).
 *
 * Pi packages are ESM-only, so we use dynamic import().
 */

import path from 'path';
import { existsSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { PathContainmentError, assertContainedPath } from '@inklabs/shared';
import { logger } from '../../utils/logger';
import { guardBashCommand } from './bash-guard';

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
  /** Default bash timeout in seconds when model doesn't specify one (default: 120) */
  bashTimeoutSeconds?: number;
  /** Agent identity — enables bash guard (dangerous command blocking + kill scope) */
  agentId?: string;
  /** Bash guard options (requires agentId to be set) */
  bashGuard?: {
    /** Block catastrophic commands before execution (default: true) */
    blockDangerousCommands?: boolean;
    /** Enforce kill targeting only agent-owned PIDs (default: true) */
    enforceKillScope?: boolean;
  };
}

const TOOLS_WITH_PATH_PARAM = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);

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

const DOCUMENT_EXTENSIONS: Record<string, string> = {
  '.pdf': 'application/pdf',
};

async function tryReadDocument(filePath: string, cwd: string): Promise<string | null> {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  if (!DOCUMENT_EXTENSIONS[ext]) return null;

  const absolutePath = path.resolve(cwd, filePath);
  if (!existsSync(absolutePath)) return null;

  if (ext === '.pdf') {
    try {
      const { PDFParse } = await import('pdf-parse');
      const buffer = await readFile(absolutePath);
      const parser = new PDFParse(new Uint8Array(buffer));
      try {
        const textResult = await parser.getText();
        const pages = textResult.total;
        const header = `[PDF: ${path.basename(filePath)} — ${pages} page${pages !== 1 ? 's' : ''}]`;
        return textResult.text.trim()
          ? `${header}\n\n${textResult.text}`
          : `${header}\n\n(No extractable text — this PDF may contain only images or scanned content.)`;
      } finally {
        parser.destroy();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading PDF: ${message}`;
    }
  }

  return null;
}

const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
const MAX_PORTABLE_SEARCH_FILES = 2000;

function relativeToolPath(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative || '.';
}

async function collectFiles(root: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_PORTABLE_SEARCH_FILES) return files;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_PORTABLE_SEARCH_FILES) break;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function portableGrep(params: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  if (!pattern) return 'Error: pattern is required';

  const searchPath = typeof params.path === 'string' && params.path ? params.path : '.';
  const root = path.resolve(cwd, searchPath);
  const rootStat = await stat(root);
  const files = rootStat.isDirectory() ? await collectFiles(root) : [root];
  const matches: string[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes(pattern)) {
        matches.push(`${relativeToolPath(cwd, file)}:${index + 1}:${line}`);
      }
    }
  }

  return matches.length ? matches.join('\n') : '(no matches)';
}

async function portableFind(params: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = typeof params.pattern === 'string' && params.pattern ? params.pattern : '*';
  const searchPath = typeof params.path === 'string' && params.path ? params.path : '.';
  const root = path.resolve(cwd, searchPath);
  const matcher = globToRegExp(pattern);
  const rootStat = await stat(root);
  const files = rootStat.isDirectory() ? await collectFiles(root) : [root];
  const matches = files
    .map((file) => relativeToolPath(cwd, file))
    .filter((file) => matcher.test(path.basename(file)));

  return matches.length ? matches.join('\n') : '(no matches)';
}

async function maybePortableSearchFallback(
  toolName: string,
  formattedResult: string,
  params: Record<string, unknown>,
  cwd: string
): Promise<string | null> {
  if (
    toolName === 'grep' &&
    formattedResult.includes('ripgrep (rg) is not available and could not be downloaded')
  ) {
    logger.warn('Pi grep unavailable; using portable grep fallback');
    return portableGrep(params, cwd);
  }

  if (
    toolName === 'find' &&
    formattedResult.includes('fd is not available and could not be downloaded')
  ) {
    logger.warn('Pi find unavailable; using portable find fallback');
    return portableFind(params, cwd);
  }

  return null;
}

/**
 * Create Pi coding tools adapted for the Ink backend.
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
  const bashTimeout = config.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;
  const agentId = config.agentId;

  return tools.map((tool) => ({
    schema: {
      name: tool.name,
      description: tool.description || `${tool.name} tool`,
      input_schema: piParametersToJsonSchema(tool.parameters) as Anthropic.Tool.InputSchema,
    },
    execute: async (params: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
      // Workspace root enforcement — realpath-based, catches symlink escapes
      if (enforceRoot && TOOLS_WITH_PATH_PARAM.has(tool.name)) {
        const filePath = (params.path as string) || '';
        if (filePath) {
          try {
            assertContainedPath(filePath, config.cwd, tool.name);
          } catch (err) {
            if (err instanceof PathContainmentError) {
              return `Error: Access denied — path "${filePath}" is outside workspace root "${config.cwd}"`;
            }
            throw err;
          }
        }
      }

      // Document adapter: handle file types Pi read doesn't support
      if (tool.name === 'read') {
        const filePath = (params.path as string) || '';
        if (filePath) {
          const docResult = await tryReadDocument(filePath, config.cwd);
          if (docResult) return docResult;
        }
      }

      // Bash guard: block dangerous commands and enforce kill scope
      if (tool.name === 'bash' && agentId) {
        const command = params.command as string;
        if (command) {
          const guard = guardBashCommand(command, {
            agentId,
            ...config.bashGuard,
          });
          if (!guard.allowed) {
            return `Error: ${guard.reason}`;
          }
        }
      }

      // Inject default bash timeout if the model doesn't specify one
      if (tool.name === 'bash' && !params.timeout) {
        params = { ...params, timeout: bashTimeout };
      }

      const callId = `ink-${tool.name}-${Date.now()}`;
      try {
        const result = await tool.execute(callId, params, signal);
        const formatted = formatToolResult(result);
        return (
          (await maybePortableSearchFallback(tool.name, formatted, params, config.cwd)) ?? formatted
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const fallback = await maybePortableSearchFallback(
          tool.name,
          `Error: ${message}`,
          params,
          config.cwd
        );
        if (fallback !== null) return fallback;
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
