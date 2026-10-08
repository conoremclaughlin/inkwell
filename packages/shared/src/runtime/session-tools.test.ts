import { describe, expect, it, vi } from 'vitest';
import { createSessionTools, type SessionToolsPorts } from './session-tools.js';
import { ContextLedger } from './context-ledger.js';
import { createSignalSink } from './context-tools.js';
import { ToolPolicyState } from './tool-policy.js';
import { resolveCredentialRefs } from './credential-resolver.js';

function harness() {
  const events: Record<string, unknown>[] = [];
  const policy = new ToolPolicyState('backend');
  const signals = createSignalSink();
  let sessionId = 'session-one';
  const settle = vi.fn();
  const ports: SessionToolsPorts = {
    sessionId: () => sessionId,
    ledger: new ContextLedger(),
    log: { append: (entry) => events.push(entry), flush: vi.fn(async () => {}) },
    policy,
    signalState: signals,
    mintInvocationId: () => 'fixture-invocation',
    beginContextMutation: () => settle,
    takeImages: () => [],
    capture: (dispatch) => dispatch,
    dispatch: {
      cwd: '/fixture',
      loadCodingTools: async () => new Map(),
      callPi: vi.fn(async () => ({ text: 'read result' })),
      callInk: vi.fn(async () => ({ success: true, text: 'server result' })),
      viewImage: vi.fn(async () => ({ text: 'image result' })),
      resolveCredentials: (args) =>
        resolveCredentialRefs(args, { EXAMPLE_KEY: 'synthetic-secret' }).args,
    },
    spawnAgent: vi.fn(async () => ({ text: 'clone handoff' })),
    collectAgents: vi.fn(async () => ({ text: 'clone summary' })),
    compact: vi.fn(async () => ({ text: 'compacted' })),
    measurement: () => undefined,
    recordEviction: vi.fn(),
  };
  const execute = createSessionTools(ports);
  const approve = vi.fn(async () => false);
  const run = (tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    execute([{ tool, args, raw: 'fixture' }], { signal, promptForApproval: approve });
  return {
    ports,
    events,
    policy,
    settle,
    approve,
    run,
    signals,
    switchSession: () => {
      sessionId = 'session-two';
    },
  };
}

describe('the shared parent tool composition', () => {
  it('keeps original credential references in receipts and resolves only at dispatch', async () => {
    const h = harness();
    h.policy.allowTool('fixture_tool');
    await h.run('fixture_tool', { key: '$EXAMPLE_KEY' });
    expect(h.ports.dispatch.callInk).toHaveBeenCalledWith('fixture_tool', {
      key: 'synthetic-secret',
    });
    expect(h.events[0]).toMatchObject({ type: 'tool_intent', args: { key: '$EXAMPLE_KEY' } });
    expect(JSON.stringify(h.events)).not.toContain('synthetic-secret');
    expect(h.events.at(-1)).toMatchObject({ type: 'local_tool_call', dispatchState: 'returned' });
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('refuses dispatch when intent writes fail and still settles mutation tracking', async () => {
    const h = harness();
    h.policy.allowTool('read');
    vi.mocked(h.ports.log.flush).mockRejectedValue(new Error('fixture disk failure'));
    const [result] = await h.run('read', { path: 'fixture.txt' });
    expect(result.status).toBe('error');
    expect(h.ports.dispatch.callPi).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('delegation remains policy checked, while context and signal tools stay local', async () => {
    const h = harness();
    h.policy.denyTool('spawn_agent');
    h.policy.denyTool('signal_status');
    const [denied] = await h.run('spawn_agent', { tasks: [] });
    expect(denied.status).toBe('blocked');
    expect(h.ports.spawnAgent).not.toHaveBeenCalled();
    await h.run('signal_status', { status: 'completed' });
    expect(h.signals.get()?.status).toBe('completed');
    expect(h.ports.dispatch.callInk).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ tool: 'signal_status', status: 'executed' });
  });

  it('hands compaction the cancellation signal rather than sending it to MCP', async () => {
    const h = harness();
    const controller = new AbortController();
    await h.run('compact_context', { summary: 'kept meaning' }, controller.signal);
    expect(h.ports.compact).toHaveBeenCalledExactlyOnceWith(
      { summary: 'kept meaning' },
      { signal: controller.signal }
    );
    expect(h.ports.dispatch.callInk).not.toHaveBeenCalled();
    expect(h.ports.ledger.listEntries()).toEqual([]);
  });

  it('persists eviction refs through the host without re-inserting removed text', async () => {
    const h = harness();
    h.ports.ledger.addEntry('system', 'a fixture entry to drop', 'fixture');
    await h.run('evict_context', { source: 'fixture' });
    expect(h.ports.recordEviction).toHaveBeenCalledWith(
      'sb',
      expect.any(String),
      expect.any(Number),
      expect.any(Array)
    );
    expect(h.ports.ledger.listEntries()).toEqual([]);
  });

  it('reads live session grants and never consumes a describe_tool grant for optional help', async () => {
    const h = harness();
    h.policy.allowTool('fixture_tool');
    h.policy.grantTool('describe_tool', 1);
    const lookup = vi.fn(async () => undefined);
    h.ports.dispatch.toolParameters = lookup;
    await h.run('fixture_tool');
    expect(lookup).not.toHaveBeenCalled();
    expect(h.policy.inspectInkTool('describe_tool', 'session-one').wouldConsumeGrant).toBe(true);
    h.switchSession();
    await h.run('fixture_tool');
    expect(lookup).not.toHaveBeenCalled();
    h.policy.setMode('off');
    h.policy.grantToolForSession('session-two', 'fixture_private');
    expect((await h.run('fixture_private'))[0].status).toBe('executed');
  });
});
