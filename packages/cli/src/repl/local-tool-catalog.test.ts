import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_TOOL_CATALOG,
  describeToolWithLocalSurface,
  findLocalTool,
  isLocalRuntimeTool,
  listLocalTools,
  renderLocalToolGroup,
} from './local-tool-catalog.js';
import { buildLocalToolInstruction } from '../commands/chat.js';
import { isForbiddenInClone } from './clone-policy.js';
import { isClientLocalTool } from './context-tools.js';
import { isPiTool } from './pi-tools.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

/**
 * What `PcpClient.callTool` actually hands back: the payload, already unwrapped
 * from the MCP envelope. Mocking the envelope instead is how the first cut of
 * this merge passed every unit test and did nothing at all in production.
 */
const serverPayload = (data: object): PcpToolCallResult => ({ ...data });

/** The legacy `/api/mcp/call` path, which returns whatever the endpoint gives. */
const enveloped = (data: object): PcpToolCallResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const payloadOf = (result: PcpToolCallResult): any => result;

const serverList = () =>
  serverPayload({
    success: true,
    count: 3,
    tools: ['bootstrap', 'create_reminder', 'recall'],
    scope: 'This lists Inkwell MCP tools only.',
    hint: "Call describe_tool with `name` for one tool's parameters.",
  });

describe('the local tool catalog', () => {
  it('names only tools this runtime actually dispatches', () => {
    // A catalog entry is a promise that the name is callable. The three
    // predicates below are what the dispatcher branches on, so this is the
    // promise checked against the thing that keeps it.
    for (const entry of LOCAL_TOOL_CATALOG) {
      expect(isLocalRuntimeTool(entry.name), entry.name).toBe(true);
      const dispatchable =
        isPiTool(entry.name) || isClientLocalTool(entry.name) || entry.group === 'delegation';
      expect(dispatchable, entry.name).toBe(true);
    }
  });

  it('gives a clone exactly the surface a clone may use', () => {
    // Derived from CLONE_DENIED_TOOLS rather than restated, so widening the
    // clone's authority cannot leave this list behind.
    expect(listLocalTools('clone').map((entry) => entry.name)).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'list_context',
      'evict_context',
      'signal_status',
    ]);
    for (const entry of listLocalTools('clone')) {
      expect(isForbiddenInClone(entry.name), entry.name).toBe(false);
    }
  });

  it('answers a miscased name, because the caller is asking what the name IS', () => {
    expect(findLocalTool('Bash')?.name).toBe('bash');
    expect(findLocalTool('  SIGNAL_STATUS ')?.name).toBe('signal_status');
    expect(findLocalTool('bash', 'clone')).toBeUndefined();
  });
});

/**
 * The prompt and discovery are two answers to one question, and they diverged:
 * the prompt said `bash` and `signal_status` existed, discovery said they did
 * not, and the agent believed discovery. Testing them against each other is the
 * only version of this that stays true — asserting what I think each says would
 * encode the same belief in two places.
 */
describe('the prompt and the catalog describe the same surface', () => {
  const namesIn = (text: string) => [...text.matchAll(/^- ([a-z_]+):/gm)].map((match) => match[1]!);

  it.each(['parent', 'clone'] as const)('for a %s', (audience) => {
    const prompt = buildLocalToolInstruction({ audience });
    const promptNames = namesIn(prompt);
    const catalogNames = listLocalTools(audience).map((entry) => entry.name);

    expect(promptNames.sort()).toEqual([...catalogNames].sort());
  });

  // Verbatim against the hand-written blocks this replaced. Rendering a prompt
  // that shapes every session from data is only safe if the data renders the
  // same prompt, and "contains bash" would not have caught a mangled Args line.
  it('renders byte-for-byte what the hand-written blocks said', () => {
    expect(renderLocalToolGroup('coding', 'parent')).toBe(
      [
        'Coding tools (in-process, scoped to working directory):',
        '- read: Read a file. Args: path (string), offset (number, optional), limit (number, optional).',
        '- edit: Edit a file by find-and-replace. Args: path (string), edits (array of {oldText, newText}).',
        '- write: Create or overwrite a file. Args: path (string), content (string).',
        '- bash: Execute a shell command. Args: command (string), timeout (number, optional).',
        '- grep: Search file contents. Args: pattern (string), path (string, optional), include (string, optional).',
        '- find: Find files by name/pattern. Args: pattern (string), path (string, optional).',
        '- ls: List directory contents. Args: path (string, optional).',
      ].join('\n')
    );

    expect(renderLocalToolGroup('coding', 'clone')).toBe(
      [
        'Coding tools (in-process, scoped to working directory):',
        '- read: Read a file. Args: path (string), offset (number, optional), limit (number, optional).',
        '- grep: Search file contents. Args: pattern (string), path (string, optional), include (string, optional).',
        '- find: Find files by name/pattern. Args: pattern (string), path (string, optional).',
        '- ls: List directory contents. Args: path (string, optional).',
      ].join('\n')
    );

    expect(renderLocalToolGroup('client-local', 'parent')).toBe(
      [
        'Client-local tools (no server round-trip):',
        '- list_context: Introspect your context window — see all entries with IDs, token counts, sources, and previews.',
        '- evict_context: Remove specific entries from your context to reclaim tokens. Args: entryIds (number[]), source (string), or role (string).',
        '- signal_status: Signal your session status. Args: status ("completed" | "blocked" | "continuing"), reason (string, optional). Use this at the end of your work to tell the runtime whether you are done, blocked on something, or need another turn.',
      ].join('\n')
    );

    expect(renderLocalToolGroup('delegation', 'parent')).toBe(
      [
        'Delegation:',
        '- spawn_agent: Fork yourself into up to 3 shadow clones for bounded, independent work. Args: tasks (array of {label, prompt}), wait (boolean, optional, default true).',
        '  Each clone is you with a blank slate and read-only tools. It works alone and hands back one summary; its intermediate steps never enter your context. That is the point — use it when the reading would cost you more context than the answer is worth, or when two lines of enquiry are independent.',
        '  spawn_agent must be the ONLY tool call in its turn — a turn mixing it with other calls is refused whole and nothing runs.',
        '  With wait:false the clones keep running in the background and you continue immediately; collect them later with collect_agents.',
        '- collect_agents: Read back what clones produced. Args: ids (string[], optional — omit for all), wait (boolean, optional, default true — block until the requested clones finish).',
      ].join('\n')
    );
  });
});

describe('describeToolWithLocalSurface', () => {
  it('merges the runtime surface into the no-arg listing and says which is which', async () => {
    const result = await describeToolWithLocalSurface(
      {},
      { audience: 'parent', cwd: '/work', callServer: async () => serverList() }
    );
    const parsed = payloadOf(result);

    expect(parsed.tools).toContain('bash');
    expect(parsed.tools).toContain('signal_status');
    expect(parsed.tools).toContain('recall');
    expect(parsed.count).toBe(parsed.tools.length);
    expect(parsed.runtimeTools).toEqual(listLocalTools('parent').map((entry) => entry.name));
    expect(parsed.note).toContain('ink-runtime');
    // Sorted as one list, so a reader scanning for a name does not have to know
    // which half to look in.
    expect(parsed.tools).toEqual(
      [...parsed.tools].sort((a: string, b: string) => a.localeCompare(b))
    );
  });

  it('finds local tools by keyword too', async () => {
    const server = () =>
      serverPayload({ success: true, query: 'shell', count: 0, tools: [], hint: 'No match.' });
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        { search: 'shell' },
        { audience: 'parent', cwd: '/work', callServer: server }
      )
    );

    expect(parsed.count).toBe(1);
    expect(parsed.tools[0].name).toBe('bash');
    expect(parsed.tools[0].source).toBe('ink-runtime');
  });

  it('returns Pi’s own schema for a coding tool, without a round trip', async () => {
    const callServer = vi.fn(async () => serverList());
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        { name: 'bash' },
        { audience: 'parent', cwd: process.cwd(), callServer }
      )
    );

    expect(callServer).not.toHaveBeenCalled();
    expect(parsed.tool.name).toBe('bash');
    expect(parsed.tool.parameters.properties.command.type).toBe('string');
    expect(parsed.tool.parameters.required).toContain('command');
    // Pi's description, not the catalog's one-liner — the schema a caller acts
    // on is the schema the executor enforces.
    expect(parsed.tool.description).toContain('Execute a bash command');
  });

  it('describes a client-local tool the server has never registered', async () => {
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        { name: 'signal_status' },
        { audience: 'parent', cwd: '/work', callServer: async () => serverList() }
      )
    );

    expect(parsed.success).toBe(true);
    expect(parsed.tool.parameters.properties.status.enum).toEqual([
      'completed',
      'blocked',
      'continuing',
    ]);
  });

  it('tells a clone that bash exists but is not for it, rather than that it does not exist', async () => {
    // This test previously asserted the server's not-found reached the clone,
    // which pinned the exact defect the PR is about: "no tool named bash" is
    // true of the Inkwell namespace and false of this runtime, and the caller
    // cannot tell which one it was told.
    const callServer = vi.fn(async () =>
      serverPayload({ success: false, error: 'No tool named "bash" in the Inkwell MCP namespace.' })
    );
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        { name: 'bash' },
        { audience: 'clone', cwd: '/work', callServer }
      )
    );

    expect(callServer).not.toHaveBeenCalled();
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('exists in this runtime');
    expect(parsed.error).toContain('not available to a shadow clone');
    expect(parsed.error).not.toContain('No tool named');
  });

  it('does not advertise server tools a clone is hard-denied', async () => {
    // audience:'clone' narrowed only the local additions, so the server's half
    // still offered every write-side tool the executor refuses. A discovery
    // list over-reporting the surface is the same defect pointed the other way.
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        {},
        {
          audience: 'clone',
          cwd: '/work',
          callServer: async () =>
            serverPayload({
              success: true,
              count: 4,
              tools: ['recall', 'remember', 'send_response', 'list_tasks'],
            }),
        }
      )
    );

    expect(parsed.tools).toContain('recall');
    expect(parsed.tools).toContain('list_tasks');
    expect(parsed.tools).not.toContain('remember');
    expect(parsed.tools).not.toContain('send_response');
    expect(parsed.count).toBe(parsed.tools.length);
    expect(parsed.scope).toContain('Tools a shadow clone may not call are omitted');
  });

  it('replaces the server-only scope instead of contradicting itself', async () => {
    // The server's scope says the list cannot contain runtime tools. After the
    // merge it does, so carrying that sentence through would ship an object
    // denying its own contents — the original defect in the same field.
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        {},
        {
          audience: 'parent',
          cwd: '/work',
          callServer: async () =>
            serverPayload({
              success: true,
              count: 1,
              tools: ['recall'],
              scope:
                'This lists Inkwell MCP tools only. Absence from it is not evidence a tool is unavailable to you.',
            }),
        }
      )
    );

    expect(parsed.tools).toContain('bash');
    expect(parsed.scope).not.toContain('Inkwell MCP tools only');
    expect(parsed.scope).toContain('both namespaces');
  });

  it('points a near-miss at the local tool it was reaching for', async () => {
    const callServer = async () =>
      serverPayload({
        success: false,
        error: 'No tool named "run_bash" in the Inkwell MCP namespace.',
      });

    const result = await describeToolWithLocalSurface(
      { name: 'run_bash' },
      { audience: 'parent', cwd: '/work', callServer }
    );

    expect(payloadOf(result).success).toBe(false);
    expect(payloadOf(result).didYouMean).toContain('bash');
  });

  it('leaves the server response alone when it cannot be parsed', async () => {
    // Discovery degrading to the old, incomplete answer is bad. Discovery
    // throwing where a caller expected a list is worse.
    const opaque = { content: [{ type: 'text', text: '<html>502</html>' }] } as PcpToolCallResult;
    expect(
      await describeToolWithLocalSurface(
        {},
        { audience: 'parent', cwd: '/work', callServer: async () => opaque }
      )
    ).toEqual(opaque);
  });

  it('merges the legacy enveloped shape too', async () => {
    // /api/mcp/call has not been unwrapped by the client, so both shapes reach
    // here depending on which transport answered.
    const parsed = payloadOf(
      await describeToolWithLocalSurface(
        {},
        {
          audience: 'parent',
          cwd: '/work',
          callServer: async () => enveloped({ success: true, count: 1, tools: ['recall'] }),
        }
      )
    );

    expect(parsed.tools).toContain('bash');
    expect(parsed.tools).toContain('recall');
  });
});
