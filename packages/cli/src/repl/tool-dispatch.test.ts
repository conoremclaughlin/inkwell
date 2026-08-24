import { describe, expect, it, vi } from 'vitest';
import { bareToolName, createLocalToolDispatcher } from './tool-dispatch.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

const ok = (text: string) => ({ content: [{ type: 'text', text }] }) as PcpToolCallResult;

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

describe('bareToolName', () => {
  it('strips the MCP namespace the model may emit', () => {
    expect(bareToolName('mcp__inkwell__get_inbox')).toBe('get_inbox');
    expect(bareToolName('get_inbox')).toBe('get_inbox');
  });
});
