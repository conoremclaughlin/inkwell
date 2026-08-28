/**
 * The ink runtime's own tool surface, as data.
 *
 * Two things need to agree about what an SB in this runtime can call: the system
 * prompt that teaches the surface at session start, and `describe_tool`, which
 * is what an agent is told to call when it is unsure. They disagreed. The prompt
 * listed `bash` and `signal_status`; `describe_tool` — answered entirely by the
 * Inkwell server, which hosts neither — listed 172 names and neither of those.
 *
 * That asymmetry is worse than a plain gap. A discovery list never invents a
 * tool, so its silence reads as authoritative absence rather than partial
 * coverage, and nothing an agent can do from the inside contradicts it. Myra
 * called `Bash`, then `mcp__inkwell__bash`, then a fenced block, got not-found
 * from all three, and concluded she had no shell. Had she then asked
 * `describe_tool` — the correct move — it would have agreed with her. The wrong
 * belief survived two compactions and hardened into a session-context note she
 * repeated for days, because inspection endorsed it.
 *
 * The server cannot fix this on its own: these tools run in-process in the CLI
 * and the MCP registry never sees them. So the runtime merges its own surface
 * into the answer (see `describeToolWithLocalSurface`), and the server states
 * the scope of what it can speak for. One catalog feeds both the prompt and
 * discovery, so the two cannot drift apart again.
 */

import { isForbiddenInClone } from './clone-policy.js';
import { initPiTools, isPiTool } from './pi-tools.js';
import { isClientLocalTool } from './context-tools.js';
import { COLLECT_AGENTS_TOOL, MAX_CLONES_PER_SPAWN, SPAWN_AGENT_TOOL } from './spawn-agent.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

/** Where a local tool runs, and which prompt block it belongs to. */
export type LocalToolGroup = 'coding' | 'client-local' | 'delegation';

/**
 * Who is being told. A shadow clone's surface is genuinely smaller — it may not
 * write, run a shell, or fan out further — and listing tools it will only be
 * refused for spends its turns on work it cannot do.
 */
export type LocalToolAudience = 'parent' | 'clone';

export interface LocalToolEntry {
  name: string;
  group: LocalToolGroup;
  /** One sentence. What the prompt shows and what a discovery listing summarizes. */
  summary: string;
  /** Argument line, prose. Omitted for tools that take none. */
  args?: string;
  /** Trailing guidance appended to the prompt line and the discovery summary. */
  note?: string;
  /**
   * Hand-written JSON Schema, for tools with no schema object to read.
   *
   * Coding tools deliberately have none: `describeLocalTool` reads Pi's own
   * schema instead, so the one thing a caller acts on cannot drift from the
   * implementation the way a transcribed copy would.
   */
  parameters?: Record<string, unknown>;
  /** Extra prompt-only lines, already indented. */
  promptNotes?: string[];
}

const GROUP_HEADERS: Record<LocalToolGroup, string> = {
  coding: 'Coding tools (in-process, scoped to working directory):',
  'client-local': 'Client-local tools (no server round-trip):',
  delegation: 'Delegation:',
};

export const LOCAL_TOOL_CATALOG: readonly LocalToolEntry[] = [
  {
    name: 'read',
    group: 'coding',
    summary: 'Read a file.',
    args: 'path (string), offset (number, optional), limit (number, optional)',
  },
  {
    name: 'edit',
    group: 'coding',
    summary: 'Edit a file by find-and-replace.',
    args: 'path (string), edits (array of {oldText, newText})',
  },
  {
    name: 'write',
    group: 'coding',
    summary: 'Create or overwrite a file.',
    args: 'path (string), content (string)',
  },
  {
    name: 'bash',
    group: 'coding',
    summary: 'Execute a shell command.',
    args: 'command (string), timeout (number, optional)',
  },
  {
    name: 'grep',
    group: 'coding',
    summary: 'Search file contents.',
    args: 'pattern (string), path (string, optional), include (string, optional)',
  },
  {
    name: 'find',
    group: 'coding',
    summary: 'Find files by name/pattern.',
    args: 'pattern (string), path (string, optional)',
  },
  {
    name: 'ls',
    group: 'coding',
    summary: 'List directory contents.',
    args: 'path (string, optional)',
  },
  {
    name: 'list_context',
    group: 'client-local',
    summary:
      'Introspect your context window — see all entries with IDs, token counts, sources, and previews.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'evict_context',
    group: 'client-local',
    summary: 'Remove specific entries from your context to reclaim tokens.',
    args: 'entryIds (number[]), source (string), or role (string)',
    parameters: {
      type: 'object',
      properties: {
        entryIds: { type: 'array', items: { type: 'number' }, description: 'Entry IDs to evict.' },
        source: { type: 'string', description: 'Evict every entry from this source.' },
        role: { type: 'string', description: 'Evict every entry with this role.' },
      },
    },
  },
  {
    name: 'signal_status',
    group: 'client-local',
    summary: 'Signal your session status.',
    args: 'status ("completed" | "blocked" | "continuing"), reason (string, optional)',
    note: 'Use this at the end of your work to tell the runtime whether you are done, blocked on something, or need another turn.',
    parameters: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'blocked', 'continuing'],
          description:
            'completed and blocked end the turn; continuing asks the runtime for another round.',
        },
        reason: { type: 'string', description: 'Why, in one line.' },
      },
    },
  },
  {
    name: SPAWN_AGENT_TOOL,
    group: 'delegation',
    summary: `Fork yourself into up to ${MAX_CLONES_PER_SPAWN} shadow clones for bounded, independent work.`,
    args: 'tasks (array of {label, prompt}), wait (boolean, optional, default true)',
    promptNotes: [
      '  Each clone is you with a blank slate and read-only tools. It works alone and hands back one summary; its intermediate steps never enter your context. That is the point — use it when the reading would cost you more context than the answer is worth, or when two lines of enquiry are independent.',
      `  ${SPAWN_AGENT_TOOL} must be the ONLY tool call in its turn — a turn mixing it with other calls is refused whole and nothing runs.`,
      '  With wait:false the clones keep running in the background and you continue immediately; collect them later with collect_agents.',
    ],
    parameters: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          maxItems: MAX_CLONES_PER_SPAWN,
          items: {
            type: 'object',
            required: ['label', 'prompt'],
            properties: { label: { type: 'string' }, prompt: { type: 'string' } },
          },
          description: `At most ${MAX_CLONES_PER_SPAWN} tasks; must be the only tool call in its turn.`,
        },
        wait: {
          type: 'boolean',
          description: 'Block until the clones finish (default true).',
        },
      },
    },
  },
  {
    name: COLLECT_AGENTS_TOOL,
    group: 'delegation',
    summary: 'Read back what clones produced.',
    args: 'ids (string[], optional — omit for all), wait (boolean, optional, default true — block until the requested clones finish)',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Clone IDs; omit for all.',
        },
        wait: {
          type: 'boolean',
          description: 'Block until the requested clones finish (default true).',
        },
      },
    },
  },
];

/**
 * The surface an audience can actually reach.
 *
 * A clone's exclusions are DERIVED from `CLONE_DENIED_TOOLS` rather than listed
 * again here — this catalog is what a clone is told, and the executor is what
 * refuses it, so a second hand-maintained list is exactly how the two come to
 * disagree. Delegation goes too: a clone may not spawn, which leaves nothing for
 * it to collect.
 */
export function listLocalTools(audience: LocalToolAudience): LocalToolEntry[] {
  if (audience === 'parent') return [...LOCAL_TOOL_CATALOG];
  return LOCAL_TOOL_CATALOG.filter(
    (entry) => entry.group !== 'delegation' && !isForbiddenInClone(entry.name)
  );
}

export function findLocalTool(
  name: string,
  audience: LocalToolAudience = 'parent'
): LocalToolEntry | undefined {
  // Lowercased: `Bash` is the miscasing a model reaches for under pressure, and
  // a discovery call is precisely where it should be answered rather than
  // corrected — the caller is already asking what the right name is.
  const needle = name.trim().toLowerCase();
  return listLocalTools(audience).find((entry) => entry.name === needle);
}

/** One prompt line, as the system prompt has always rendered it. */
export function renderLocalToolLine(entry: LocalToolEntry): string {
  const args = entry.args ? ` Args: ${entry.args}.` : '';
  const note = entry.note ? ` ${entry.note}` : '';
  return [`- ${entry.name}: ${entry.summary}${args}${note}`, ...(entry.promptNotes ?? [])].join(
    '\n'
  );
}

/** A whole prompt block — header plus every tool in the group this audience gets. */
export function renderLocalToolGroup(group: LocalToolGroup, audience: LocalToolAudience): string {
  const entries = listLocalTools(audience).filter((entry) => entry.group === group);
  return [GROUP_HEADERS[group], ...entries.map(renderLocalToolLine)].join('\n');
}

/** The one-line summary a discovery listing shows. */
function discoverySummary(entry: LocalToolEntry): string {
  const args = entry.args ? ` Args: ${entry.args}.` : '';
  const note = entry.note ? ` ${entry.note}` : '';
  return `${entry.summary}${args}${note}`;
}

export interface LocalToolDescription {
  name: string;
  group: LocalToolGroup;
  description: string;
  parameters: unknown;
  /** Where the tool lives, so a reader knows why the server never listed it. */
  source: 'ink-runtime';
}

/**
 * Full detail for one local tool.
 *
 * Coding tools answer with Pi's own description and JSON Schema — the same
 * objects the executor runs — so the schema a caller acts on is the schema that
 * will be enforced. Everything else answers from the catalog, which is the only
 * description those tools have.
 */
export async function describeLocalTool(
  entry: LocalToolEntry,
  cwd: string
): Promise<LocalToolDescription> {
  const base: LocalToolDescription = {
    name: entry.name,
    group: entry.group,
    description: discoverySummary(entry),
    parameters: entry.parameters ?? { type: 'object', properties: {} },
    source: 'ink-runtime',
  };

  if (entry.group !== 'coding') return base;

  try {
    const piTool = (await initPiTools(cwd)).get(entry.name);
    if (!piTool) return base;
    return {
      ...base,
      description: piTool.description || base.description,
      parameters: piTool.parameters ?? base.parameters,
    };
  } catch {
    // Never let introspection be the thing that breaks a call.
    return base;
  }
}

/** True for any name this runtime serves in-process, whatever the audience. */
export function isLocalRuntimeTool(name: string): boolean {
  const bare = name.trim().toLowerCase();
  return (
    isPiTool(bare) ||
    isClientLocalTool(bare) ||
    bare === SPAWN_AGENT_TOOL ||
    bare === COLLECT_AGENTS_TOOL
  );
}

/**
 * The server's payload, or null when it is not a shape we can merge into.
 *
 * `PcpClient.callTool` returns the tool's payload ALREADY UNWRAPPED — it parses
 * the MCP envelope's text and hands back `{success, tools, …}` — so that is the
 * shape this sees in production and the shape it must return. The envelope
 * branch is for the legacy `/api/mcp/call` path, which returns whatever the
 * endpoint gives.
 *
 * Worth stating because assuming the envelope is exactly how this fix was dead
 * on arrival the first time: every unit test passed against a mock that wrapped
 * its payload, and the live call fell through the merge untouched.
 */
function parseServerPayload(result: PcpToolCallResult): Record<string, unknown> | null {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = (content[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  // Already unwrapped. Recognized by describe_tool's own fields rather than by
  // "is an object", so an unfamiliar shape is passed through rather than
  // decorated with a listing it does not have.
  if ('tools' in result || 'tool' in result || 'success' in result) {
    return result as Record<string, unknown>;
  }
  return null;
}

const SCOPE_NOTE =
  'Names marked ink-runtime run in-process in this CLI and are not registered with the Inkwell server, which is why a server-only listing omits them.';

export interface DescribeToolLocalOptions {
  audience: LocalToolAudience;
  cwd: string;
  /** Ask the Inkwell server the same question. */
  callServer: () => Promise<PcpToolCallResult>;
}

/**
 * `describe_tool`, answered for the WHOLE callable surface.
 *
 * The server owns its namespace and this runtime owns the rest, so the answer is
 * assembled here — the only place that can see both. A name this runtime serves
 * is answered without a round trip, since the server has never heard of it and
 * its not-found would be the very thing that misled the caller.
 *
 * A server response that does not parse is returned untouched. Discovery
 * degrading to the old, incomplete answer is bad; discovery throwing where a
 * caller expected a list is worse.
 */
export async function describeToolWithLocalSurface(
  args: Record<string, unknown>,
  opts: DescribeToolLocalOptions
): Promise<PcpToolCallResult> {
  const name = typeof args.name === 'string' ? args.name : undefined;
  const search = typeof args.search === 'string' ? args.search : undefined;
  const local = listLocalTools(opts.audience);

  if (name) {
    const entry = findLocalTool(name, opts.audience);
    if (entry) {
      return {
        success: true,
        tool: await describeLocalTool(entry, opts.cwd),
        note: SCOPE_NOTE,
      };
    }
  }

  const serverResult = await opts.callServer();
  const payload = parseServerPayload(serverResult);
  if (!payload) return serverResult;

  if (name) {
    // The server said no and this runtime has no such tool either — so the
    // answer stands. Offer the local near-misses anyway: a caller guessing
    // `shell` or `run_command` is looking for `bash`.
    if (payload.success === false) {
      const needle = name.toLowerCase();
      const suggestions = local
        .filter((entry) => entry.name.includes(needle) || needle.includes(entry.name))
        .map((entry) => entry.name);
      if (suggestions.length === 0) return serverResult;
      const existing = Array.isArray(payload.didYouMean) ? (payload.didYouMean as string[]) : [];
      return { ...payload, didYouMean: [...existing, ...suggestions], note: SCOPE_NOTE };
    }
    return serverResult;
  }

  if (search) {
    if (!Array.isArray(payload.tools)) return serverResult;
    const needle = search.toLowerCase();
    const matches = local
      .filter(
        (entry) =>
          entry.name.includes(needle) || discoverySummary(entry).toLowerCase().includes(needle)
      )
      .map((entry) => ({
        name: entry.name,
        summary: discoverySummary(entry),
        source: 'ink-runtime' as const,
      }));
    if (matches.length === 0) return serverResult;
    const tools = [...(payload.tools as unknown[]), ...matches];
    return {
      ...payload,
      count: tools.length,
      tools,
      hint: 'Call describe_tool with `name` to get the full parameter schema for one of these.',
      note: SCOPE_NOTE,
    };
  }

  if (!Array.isArray(payload.tools)) return serverResult;
  const runtimeTools = local.map((entry) => entry.name);
  const tools = [...(payload.tools as string[]), ...runtimeTools].sort((a, b) =>
    a.localeCompare(b)
  );
  return { ...payload, count: tools.length, tools, runtimeTools, note: SCOPE_NOTE };
}
