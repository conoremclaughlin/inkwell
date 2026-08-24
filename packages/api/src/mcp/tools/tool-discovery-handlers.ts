/**
 * Tool schema introspection.
 *
 * Until now there was no way for an agent to ask what a tool's parameters are.
 * The descriptions are good — create_reminder documents worked examples and
 * cron patterns — but they only reach clients that receive the full MCP
 * tools/list, which the ink runtime does not. An agent that guessed `remindAt`
 * instead of `runAt` had no recourse except reading the server source, which
 * only works if it happens to have a filesystem and a checkout. Myra did.
 * Benson on Discord does not, and would have hit the same wall with no way out.
 *
 * The whole payload is not an option: measured against the live server,
 * tools/list for 161 tools is ~251KB (~62K tokens). Hence a lookup — names are
 * cheap to list (~718 tokens), and the expensive part is fetched per tool.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

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

export interface RegisteredToolInfo {
  name: string;
  description?: string;
  /** Either a ZodRawShape or a ZodObject — registrations use both. */
  inputSchema?: unknown;
}

/** Name → definition, populated by the registerTool interceptor. */
export type ToolRegistry = Map<string, RegisteredToolInfo>;

export const describeToolSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Exact tool name to describe, e.g. "create_reminder". Returns its full description and its parameter schema, including which fields are required.'
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Substring to match against tool names and descriptions, e.g. "reminder" or "calendar". Returns matching names with a one-line summary each. Use this when you know what you want to do but not what the tool is called.'
      ),
  })
  .strict();

function firstLine(description: string | undefined): string {
  if (!description) return '';
  const line = description.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? '';
}

/**
 * Convert a registration's inputSchema to JSON Schema. Registrations pass
 * either a raw shape or a ZodObject, so both are normalized here — the same
 * split the SDK handles internally.
 */
function toParameterSchema(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== 'object') return { type: 'object', properties: {} };

  const asObject =
    inputSchema instanceof z.ZodObject ? inputSchema : z.object(inputSchema as z.ZodRawShape);

  try {
    return zodToJsonSchema(asObject, { $refStrategy: 'none' });
  } catch {
    // Never let introspection be the thing that breaks a call.
    return { type: 'object', properties: {}, note: 'schema could not be serialized' };
  }
}

export function handleDescribeTool(
  args: z.infer<typeof describeToolSchema>,
  registry: ToolRegistry
): McpResponse {
  const tools = Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));

  if (args.name) {
    const tool = registry.get(args.name);
    if (!tool) {
      // A wrong guess is the common case here — that is what this tool exists
      // for — so spend the response on getting them to the right name rather
      // than on saying no.
      const needle = args.name.toLowerCase();
      const suggestions = tools
        .map((candidate) => candidate.name)
        .filter((candidate) => {
          const stem = needle.replace(/^(get|list|create|update|delete|cancel|remove)_/, '');
          return candidate.includes(stem) || needle.includes(candidate);
        })
        .slice(0, 10);

      return mcpResponse(
        {
          success: false,
          error: `No tool named "${args.name}".`,
          ...(suggestions.length > 0 ? { didYouMean: suggestions } : {}),
          hint: 'Call describe_tool with `search` to find a tool by keyword, or with no arguments to list every tool name.',
        },
        true
      );
    }

    return mcpResponse({
      success: true,
      tool: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: toParameterSchema(tool.inputSchema),
      },
    });
  }

  if (args.search) {
    const needle = args.search.toLowerCase();
    const matches = tools
      .filter(
        (tool) =>
          tool.name.toLowerCase().includes(needle) ||
          (tool.description ?? '').toLowerCase().includes(needle)
      )
      .map((tool) => ({ name: tool.name, summary: firstLine(tool.description) }));

    return mcpResponse({
      success: true,
      query: args.search,
      count: matches.length,
      tools: matches,
      ...(matches.length === 0
        ? { hint: 'No match. Call describe_tool with no arguments to list every tool name.' }
        : {
            hint: 'Call describe_tool with `name` to get the full parameter schema for one of these.',
          }),
    });
  }

  return mcpResponse({
    success: true,
    count: tools.length,
    tools: tools.map((tool) => tool.name),
    hint: "Call describe_tool with `name` for one tool's parameters, or `search` to filter by keyword.",
  });
}
