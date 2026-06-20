/**
 * Pi Coding Tools Adapter
 *
 * Wraps @mariozechner/pi-coding-agent tool implementations for use in
 * the ink CLI's local tool routing layer. Pi's tools (read, edit, write,
 * bash, grep, find, ls) execute in-process against a working directory.
 */

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
