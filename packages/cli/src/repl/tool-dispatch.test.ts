import { describe, expect, it, vi } from 'vitest';
import { bareToolName, createLocalToolDispatcher } from './tool-dispatch.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

const ok = (text: string) => ({ content: [{ type: 'text', text }] }) as PcpToolCallResult;

const payloadOf = (result: PcpToolCallResult): any => result;

function makeDeps(overrides: Partial<Parameters<typeof createLocalToolDispatcher>[0]> = {}) {
  const callPi = vi.fn(async () => ok('pi'));
  const callPcp = vi.fn(async () => ok('pcp'));
  const resolveCredentials = vi.fn((args: Record<string, unknown>) => ({
    ...args,
    resolved: true,
  }));
  return {
    callPi,
    callPcp,
    resolveCredentials,
    deps: { cwd: '/work', callPi, callPcp, resolveCredentials, ...overrides },
  };
}

describe('createLocalToolDispatcher', () => {
  it('forwards the cancellation signal to Pi tools', async () => {
    // The reason this is a factory rather than two inline closures: both hosts
    // dropped the signal here, twice, and a closure gives TypeScript nothing to
    // complain about. Constructing the dispatcher is now the only way to reach
    // a Pi tool, so forwarding is not something a host can omit.
    const { callPi, deps } = makeDeps();
    const dispatch = createLocalToolDispatcher(deps);
    const controller = new AbortController();

    await dispatch('bash', { command: 'echo hi' }, { signal: controller.signal });

    expect(callPi).toHaveBeenCalledWith('bash', { command: 'echo hi' }, '/work', controller.signal);
  });

  it('passes an absent signal through as undefined rather than inventing one', async () => {
    const { callPi, deps } = makeDeps();
    await createLocalToolDispatcher(deps)('read', { path: 'a.ts' }, {});
    expect(callPi).toHaveBeenCalledWith('read', { path: 'a.ts' }, '/work', undefined);
  });

  it('sends everything else to PCP with credentials resolved and the namespace stripped', async () => {
    const { callPcp, resolveCredentials, deps } = makeDeps();
    await createLocalToolDispatcher(deps)('mcp__inkwell__recall', { query: '$TOKEN' }, {});

    expect(resolveCredentials).toHaveBeenCalledWith({ query: '$TOKEN' });
    expect(callPcp).toHaveBeenCalledWith('recall', { query: '$TOKEN', resolved: true });
  });

  // The Myra regression (Aug 2026). A long-lived session drifts toward its
  // priors and starts namespacing every tool it names. Only the PCP
  // fallthrough stripped that namespace, so a namespaced coding tool sailed
  // past isPiTool, was posted to a server that has no `bash`, and came back
  // "tool not found" — which she reasonably read as "you have no shell".
  it.each(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'])(
    'routes namespaced %s to the Pi tool, not the server',
    async (piTool) => {
      const { callPi, callPcp, deps } = makeDeps();
      await createLocalToolDispatcher(deps)(`mcp__inkwell__${piTool}`, { path: 'a.ts' }, {});

      expect(callPi).toHaveBeenCalledWith(piTool, { path: 'a.ts' }, '/work', undefined);
      expect(callPcp).not.toHaveBeenCalled();
    }
  );

  it('hands the head a bare name so its own branches match', async () => {
    // isClientLocalTool / isForbiddenInClone in both hosts test against bare
    // names. Normalizing before the head is what makes `mcp__inkwell__
    // signal_status` reach the ledger instead of the server.
    const seen: string[] = [];
    const { deps } = makeDeps({
      head: (tool) => {
        seen.push(tool);
        return tool === 'signal_status' ? ok('signalled') : null;
      },
    });

    const result = await createLocalToolDispatcher(deps)(
      'mcp__inkwell__signal_status',
      { status: 'completed' },
      {}
    );

    expect(seen).toEqual(['signal_status']);
    expect(result).toEqual(ok('signalled'));
  });

  it('refuses a foreign MCP namespace with a reason instead of relaying "not found"', async () => {
    // `mcp__github__*` cannot resolve here: the ink loop has no generic MCP
    // client. Saying that is the difference between "you misspelled it" and
    // "this capability is absent" — the second is actionable, the first sent
    // Myra retrying across two days.
    const { callPcp, callPi, deps } = makeDeps();
    const result = await createLocalToolDispatcher(deps)(
      'mcp__github__list_issues',
      { owner: 'conoremclaughlin', repo: 'inkwell' },
      {}
    );

    expect(callPcp).not.toHaveBeenCalled();
    expect(callPi).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('no "github" MCP server');
    expect(text).toContain('bash');
  });

  // Myra's own account of the failure: `Bash`, the prefixed name, and a fenced
  // block all returned the same not-found, so three wrong conventions read as
  // consistent evidence the shell was gone. An error that cannot tell a
  // miscased name from an absent tool makes retrying confirm the wrong answer.
  it.each([
    ['Bash', 'bash'],
    ['Read', 'read'],
    ['Write', 'write'],
    ['Grep', 'grep'],
    ['LS', 'ls'],
  ])('corrects miscased %s to %s instead of relaying "not found"', async (emitted, correct) => {
    const { callPcp, callPi, deps } = makeDeps();
    const result = await createLocalToolDispatcher(deps)(emitted, { command: 'ls' }, {});

    expect(callPcp).not.toHaveBeenCalled();
    expect(callPi).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toContain(`"${correct}"`);
  });

  it('corrects a name that is both namespaced and miscased', async () => {
    const { callPcp, deps } = makeDeps();
    const result = await createLocalToolDispatcher(deps)('mcp__inkwell__Bash', {}, {});

    expect(callPcp).not.toHaveBeenCalled();
    expect(result.content[0].text as string).toContain('"bash"');
  });

  it('does not "correct" a capitalised name that is not a coding tool', async () => {
    // ToolSearch and WebSearch are Claude Code tools with no lowercase
    // equivalent here. The server stays the authority on those.
    const { callPcp, deps } = makeDeps();
    await createLocalToolDispatcher(deps)('ToolSearch', {}, {});
    expect(callPcp).toHaveBeenCalledWith('ToolSearch', { resolved: true });
  });

  it('still sends a bare unknown tool to the server rather than guessing', async () => {
    // Only an `mcp__<server>__` prefix proves the target is foreign. A bare
    // name we do not recognise may simply be an Inkwell tool this build has
    // not heard of, and the server is the authority on that.
    const { callPcp, deps } = makeDeps();
    await createLocalToolDispatcher(deps)('some_new_inkwell_tool', {}, {});
    expect(callPcp).toHaveBeenCalledWith('some_new_inkwell_tool', { resolved: true });
  });

  it('lets the host head answer first and stop there', async () => {
    const { callPi, callPcp, deps } = makeDeps({
      head: (tool) => (tool === 'bash' ? ok('refused') : null),
    });
    const dispatch = createLocalToolDispatcher(deps);

    const refused = await dispatch('bash', {}, {});
    expect(refused).toEqual(ok('refused'));
    expect(callPi).not.toHaveBeenCalled();

    // Anything the head declines still falls through to the shared tail.
    await dispatch('recall', {}, {});
    expect(callPcp).toHaveBeenCalled();
  });

  it('gives the head the signal too, for host work that can be cancelled', async () => {
    const head = vi.fn(() => null);
    const { deps } = makeDeps({ head });
    const controller = new AbortController();

    await createLocalToolDispatcher(deps)(
      'spawn_agent',
      { tasks: [] },
      {
        signal: controller.signal,
      }
    );

    expect(head).toHaveBeenCalledWith('spawn_agent', { tasks: [] }, { signal: controller.signal });
  });

  it('awaits an async head', async () => {
    const { callPcp, deps } = makeDeps({ head: async () => ok('async refusal') });
    expect(await createLocalToolDispatcher(deps)('anything', {}, {})).toEqual(ok('async refusal'));
    expect(callPcp).not.toHaveBeenCalled();
  });
});

/**
 * Discovery is a tail concern for the same reason cancellation is: the server
 * can only answer for its own namespace, and BOTH hosts would otherwise ship an
 * answer that reads as the complete callable surface while omitting every tool
 * that runs in-process. Myra spent two days believing she had no shell because
 * `describe_tool` — the thing an agent is told to call when unsure — confirmed
 * it.
 */
describe('createLocalToolDispatcher — describe_tool', () => {
  /**
   * What the live server returns today: its own namespace, and only that.
   *
   * Shaped as `PcpClient.callTool` hands it back — the payload, already
   * unwrapped from the MCP envelope. Mocking the envelope instead is how the
   * first cut of this merge passed here and did nothing in production.
   */
  const serverList = (): PcpToolCallResult => ({
    success: true,
    count: 2,
    tools: ['bootstrap', 'recall'],
    hint: "Call describe_tool with `name` for one tool's parameters, or `search` to filter by keyword.",
  });

  it('lists the in-process tools alongside the server namespace', async () => {
    const callPcp = vi.fn(async () => serverList());
    const dispatch = createLocalToolDispatcher({
      cwd: '/work',
      callPi: async () => ok('pi'),
      callPcp,
      resolveCredentials: (args) => args,
    });

    const parsed = payloadOf(await dispatch('describe_tool', {}, {}));

    // The two Myra verified by calling them, and could not find by asking.
    expect(parsed.tools).toContain('bash');
    expect(parsed.tools).toContain('signal_status');
    // The server's own names survive the merge.
    expect(parsed.tools).toContain('recall');
    expect(parsed.count).toBe(parsed.tools.length);
    expect(parsed.runtimeTools).toContain('bash');
  });

  it('answers for a coding tool without asking the server, which has never heard of it', async () => {
    const callPcp = vi.fn(async () => serverList());
    const dispatch = createLocalToolDispatcher({
      cwd: process.cwd(),
      callPi: async () => ok('pi'),
      callPcp,
      resolveCredentials: (args) => args,
    });

    const parsed = payloadOf(await dispatch('describe_tool', { name: 'bash' }, {}));

    expect(parsed.success).toBe(true);
    expect(parsed.tool.name).toBe('bash');
    expect(parsed.tool.source).toBe('ink-runtime');
    // Pi's own schema, not a hand-copy of it that can drift.
    expect(parsed.tool.parameters.properties).toHaveProperty('command');
    expect(callPcp).not.toHaveBeenCalled();
  });

  it('narrows the surface for a clone, which genuinely may not run bash', async () => {
    const dispatch = createLocalToolDispatcher({
      cwd: '/work',
      callPi: async () => ok('pi'),
      callPcp: async () => serverList(),
      resolveCredentials: (args) => args,
      audience: 'clone',
    });

    const parsed = payloadOf(await dispatch('describe_tool', {}, {}));

    expect(parsed.tools).toContain('read');
    expect(parsed.tools).not.toContain('bash');
    expect(parsed.tools).not.toContain('spawn_agent');
  });

  it('leaves a server response it cannot parse exactly as it found it', async () => {
    const opaque = ok('not json at all');
    const dispatch = createLocalToolDispatcher({
      cwd: '/work',
      callPi: async () => ok('pi'),
      callPcp: async () => opaque,
      resolveCredentials: (args) => args,
    });

    expect(await dispatch('describe_tool', {}, {})).toEqual(opaque);
  });
});

describe('bareToolName', () => {
  it('strips the MCP namespace the model may emit', () => {
    expect(bareToolName('mcp__inkwell__get_inbox')).toBe('get_inbox');
    expect(bareToolName('get_inbox')).toBe('get_inbox');
  });
});
