/**
 * Pi Coding Tools Adapter
 *
 * Wraps @mariozechner/pi-coding-agent tool implementations for use in
 * the ink CLI's local tool routing layer. Pi's tools (read, edit, write,
 * bash, grep, find, ls) execute in-process against a working directory.
 */

import { resolve, relative, dirname, basename, join } from 'path';
import { realpathSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

// Pi tool types — we use the AgentTool shape from pi-agent-core
interface PiToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface PiAgentTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<PiToolResult>;
}

const PI_TOOL_NAMES = new Set(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']);

let cachedTools: Map<string, PiAgentTool> | null = null;
let cachedCwd: string | null = null;

/**
 * Check if a tool name is a Pi coding tool.
 */
export function isPiTool(toolName: string): boolean {
  return PI_TOOL_NAMES.has(toolName);
}

/**
 * Initialize Pi coding tools for a working directory.
 * Tools are cached per cwd — call again with a different cwd to reinitialize.
 */
export async function initPiTools(cwd: string): Promise<Map<string, PiAgentTool>> {
  if (cachedTools && cachedCwd === cwd) return cachedTools;

  const pi = await import('@mariozechner/pi-coding-agent');
  const tools = [
    pi.createReadTool(cwd),
    pi.createEditTool(cwd),
    pi.createWriteTool(cwd),
    pi.createBashTool(cwd),
    pi.createGrepTool(cwd),
    pi.createFindTool(cwd),
    pi.createLsTool(cwd),
  ] as unknown as PiAgentTool[];

  cachedTools = new Map();
  for (const tool of tools) {
    cachedTools.set(tool.name, tool);
  }
  cachedCwd = cwd;
  return cachedTools;
}

const PATH_TOOLS = new Set(['read', 'edit', 'write', 'ls', 'grep', 'find']);

export class PathContainmentError extends Error {
  constructor(
    public readonly tool: string,
    public readonly requestedPath: string,
    public readonly resolvedPath: string,
    public readonly cwd: string
  ) {
    super(
      `Path containment violation: ${tool} attempted to access "${requestedPath}" ` +
        `(resolved to "${resolvedPath}") which is outside workspace "${cwd}"`
    );
    this.name = 'PathContainmentError';
  }
}

function resolveDeepestAncestor(targetPath: string): string {
  const parts: string[] = [];
  let current = targetPath;
  while (!existsSync(current) && current !== dirname(current)) {
    parts.unshift(basename(current));
    current = dirname(current);
  }
  try {
    const realAncestor = realpathSync(current);
    return join(realAncestor, ...parts);
  } catch {
    return targetPath;
  }
}

function assertContainedPath(rawPath: string, cwd: string, tool: string): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }

  const resolved = resolve(realCwd, rawPath);

  let realResolved: string;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    realResolved = resolveDeepestAncestor(resolved);
  }

  const rel = relative(realCwd, realResolved);
  if (rel.startsWith('..') || resolve(realCwd, rel) !== realResolved) {
    throw new PathContainmentError(tool, rawPath, realResolved, realCwd);
  }
}

function validatePathArgs(toolName: string, args: Record<string, unknown>, cwd: string): void {
  if (!PATH_TOOLS.has(toolName)) return;

  const pathArg = args.path ?? args.file_path ?? args.filePath;
  if (typeof pathArg === 'string' && pathArg) {
    assertContainedPath(pathArg, cwd, toolName);
  }
}

const DOCUMENT_EXTENSIONS: Record<string, string> = {
  '.pdf': 'application/pdf',
};

async function tryReadDocument(filePath: string, cwd: string): Promise<PcpToolCallResult | null> {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  if (!DOCUMENT_EXTENSIONS[ext]) return null;

  const absolutePath = resolve(cwd, filePath);
  if (!existsSync(absolutePath)) return null;

  if (ext === '.pdf') {
    try {
      const { PDFParse } = await import('pdf-parse');
      const buffer = await readFile(absolutePath);
      const parser = new PDFParse(new Uint8Array(buffer));
      try {
        const textResult = await parser.getText();
        const info = await parser.getInfo();
        const pages = textResult.total;
        const header = `[PDF: ${basename(filePath)} — ${pages} page${pages !== 1 ? 's' : ''}]`;
        const text = textResult.text.trim()
          ? `${header}\n\n${textResult.text}`
          : `${header}\n\n(No extractable text — this PDF may contain only images or scanned content.)`;
        return {
          content: [{ type: 'text', text }],
          text,
          success: true,
          metadata: { pages, info: info.info },
        };
      } finally {
        parser.destroy();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error reading PDF: ${message}` }],
        text: `Error reading PDF: ${message}`,
        success: false,
      };
    }
  }

  return null;
}

/**
 * Execute a Pi coding tool and return the result in PcpToolCallResult format.
 * This is the adapter between Pi's tool interface and the ink CLI's tool routing.
 */
export async function callPiTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal
): Promise<PcpToolCallResult> {
  const tools = await initPiTools(cwd);
  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`Pi tool "${toolName}" not found. Available: ${[...tools.keys()].join(', ')}`);
  }

  validatePathArgs(toolName, args, cwd);

  // Adapter: handle document types the Pi read tool doesn't support.
  // Pi's read handles text + images (jpg/png/gif/webp). For PDFs and
  // other document types, we extract text here before Pi tries to read
  // them as UTF-8 (which produces garbled output).
  if (toolName === 'read') {
    const filePath = (args.path as string) || (args.file_path as string) || '';
    if (filePath) {
      const docResult = await tryReadDocument(filePath, cwd);
      if (docResult) return docResult;
    }
  }

  const callId = `pi-${toolName}-${Date.now()}`;
  const result = await tool.execute(callId, args, signal);

  // Transform Pi's result format to PcpToolCallResult
  // Pi returns { content: [{ type: 'text', text: '...' }], details: {...} }
  // PcpToolCallResult is Record<string, unknown> — pass through content array
  // in MCP-compatible shape so the existing result formatting works
  const textContent = result.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');

  return {
    content: result.content,
    text: textContent,
    success: true,
  };
}

/**
 * Get the list of available Pi tool names (for system prompt injection).
 */
export function getPiToolNames(): string[] {
  return [...PI_TOOL_NAMES];
}

/**
 * Get tool descriptions for system prompt injection.
 * Returns a formatted block describing available coding tools.
 */
export async function getPiToolDescriptions(cwd: string): Promise<string> {
  const tools = await initPiTools(cwd);
  const lines: string[] = ['## Coding Tools (Pi)', ''];
  for (const [name, tool] of tools) {
    lines.push(`### ${name}`);
    lines.push(tool.description);
    lines.push('');
  }
  return lines.join('\n');
}
