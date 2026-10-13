import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSessionClones, type SessionClonesPorts } from './session-clones.js';
import { createSessionToolHost } from './session-tool-host.js';
import {
  CloneRegistry,
  ContextLedger,
  SessionContextState,
  SessionLog,
  ToolPolicyState,
  deriveClonePolicy,
} from '../runtime/index.js';
import type { CodingTool } from './coding-tools.js';
import type { BackendHost } from '../providers/types.js';
import type { BackendRunRequest, BackendRunResult } from '../providers/backend-runner.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const tool = (name: string, args: Record<string, unknown> = {}) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const done = `Read complete${tool('signal_status', { status: 'completed' })}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const outcome = (text: string): BackendRunResult => ({
  success: true,
  stdout: text,
  responseText: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'fixture',
  childExited: true,
});

async function fixture(replies = [tool('read', { path: 'fixture.txt' }), done]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-clone-composition-')));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'fixture.txt'), 'harmless clone fixture');
  const pi = await import('@mariozechner/pi-coding-agent');
  const toolHost = createSessionToolHost({
    cwd,
    home: root,
    imageRoots: [cwd],
    tempDir: root,
    credentials: {},
    coding: {
      load: async (path) => new Map([['read', pi.createReadTool(path) as unknown as CodingTool]]),
      readDocument: async () => null,
    },
  });
  cleanup.push(async () => {
    await toolHost.close();
    await rm(root, { recursive: true, force: true });
  });
  const events: Array<Record<string, unknown>> = [];
  const parentEvents: Array<Record<string, unknown>> = [];
  const parentLog = new SessionLog({
    path: join(root, 'parent.jsonl'),
    sink: {
      write: (line) => {
        parentEvents.push(JSON.parse(line));
      },
    },
  });
  const runtime: SessionClonesPorts<ToolPolicyState>['runtime'] = {
    sessionId: 'parent',
    backend: 'claude',
    model: 'original',
    effort: 'high',
    systemPromptOverride: 'original identity',
    backendTurnTimeoutMs: 1000,
    backendIdleTimeoutMs: 500,
    log: parentLog,
    verbose: false,
    maxContextTokens: 100000,
    toolRouting: 'local',
    toolMode: 'backend',
    strictTools: true,
    activeSkills: [],
  };
  const policy = new ToolPolicyState('backend');
  const ledger = new ContextLedger();
  const registry = new CloneRegistry();
  const sessionContext = new SessionContextState({
    runtime: () => runtime,
    append: (e) => parentLog.append(e),
    rolled: () => {},
  });
  const abort = vi.fn();
  const order: string[] = [];
  const startTurn = vi.fn((_request: BackendRunRequest) => {
    order.push('spawn');
    const reply = replies.shift();
    if (!reply) throw new Error('unscripted provider');
    return { result: Promise.resolve(outcome(reply)), abort };
  });
  let n = 0;
  const calls: Array<{ session: string | undefined; name: string; args: Record<string, unknown> }> =
    [];
  const ports: SessionClonesPorts<ToolPolicyState> = {
    runtime,
    sbSlug: 'echo',
    cliAttached: false,
    policy,
    ledger,
    registry,
    sessionContext,
    toolHost,
    cwd,
    mintId: () => `fixture-${++n}`,
    createLog: (path) =>
      new SessionLog({
        path,
        sink: {
          write: async (line) => {
            await Promise.resolve();
            const event = JSON.parse(line);
            events.push(event);
            order.push(`write:${event.type}`);
          },
        },
      }),
    spawnContext: () => ({
      workingDirectory: cwd,
      inkSessionId: runtime.sessionId,
      studioId: 'old-studio',
      host: {} as BackendHost,
    }),
    bindInk:
      ({ inkSessionId }) =>
      async (name, args) => {
        calls.push({ session: inkSessionId, name, args });
        return { success: true };
      },
    derivePolicy: (parent, sessionId) => deriveClonePolicy(parent, { sessionId }).policy,
    approve: vi.fn(async () => false),
    startTurn,
    recordUsage: vi.fn(),
    printEvent: vi.fn(),
  };
  return {
    ports,
    create: () => createSessionClones(ports),
    events,
    parentEvents,
    startTurn,
    abort,
    order,
    calls,
  };
}
const tasks = { tasks: [{ label: 'read', prompt: 'Read fixture.txt' }] };

describe('the production shared clone composition', () => {
  it('runs a real Pi read, flushes before continuation, commits summary before settlement and collects once', async () => {
    const h = await fixture();
    const clones = h.create();
    const result = await clones.spawn(tasks, {});
    await clones.drain();
    expect(JSON.stringify(result)).toContain('Read complete');
    expect(h.startTurn).toHaveBeenCalledTimes(2);
    expect(h.startTurn.mock.calls[1][0].prompt).toContain('harmless clone fixture');
    expect(h.order[0]).toBe('write:clone_start');
    expect(h.order.indexOf('write:clone_tool_call')).toBeLessThan(h.order.lastIndexOf('spawn'));
    expect(h.events.at(-1)?.type).toBe('clone_end');
    const intent = h.events.find((event) => event.type === 'tool_intent' && event.tool === 'read');
    expect(intent).toMatchObject({
      tool: 'read',
      args: { path: 'fixture.txt' },
      invocationId: expect.any(String),
    });
    expect(h.events.find((event) => event.type === 'clone_tool_call')?.invocationId).toBe(
      intent?.invocationId
    );
    expect(h.order.indexOf('write:tool_intent')).toBeLessThan(
      h.order.indexOf('write:clone_tool_call')
    );
    expect(h.ports.registry.get('clone-1')?.status).toBe('completed');
    const count = h.ports.ledger.listEntries().length;
    await clones.collect({});
    expect(h.ports.ledger.listEntries()).toHaveLength(count);
    expect(h.parentEvents.map((event) => event.type)).toEqual(['clone_fanout']);
    expect(h.events.find((event) => event.type === 'clone_tool_call')).toMatchObject({
      invocationId: expect.any(String),
      dispatchState: 'returned',
    });
  });

  it('freezes provider knobs and tool attribution even when the parent switches during a background read', async () => {
    const h = await fixture([tool('recall', { query: 'fixture' }), done]);
    const gate = deferred<BackendRunResult>();
    const started = deferred<void>();
    h.startTurn.mockImplementationOnce(() => {
      started.resolve();
      return { result: gate.promise, abort: h.abort };
    });
    const clones = h.create();
    await clones.spawn({ ...tasks, wait: false }, {});
    await started.promise;
    Object.assign(h.ports.runtime, {
      sessionId: 'different-parent',
      model: 'different',
      effort: 'low',
      systemPromptOverride: 'different identity',
      backendTurnTimeoutMs: 8000,
      backendIdleTimeoutMs: 7000,
    });
    h.ports.spawnContext = () => ({
      workingDirectory: '/different',
      inkSessionId: 'different-parent',
      studioId: 'different-studio',
      host: {} as BackendHost,
    });
    gate.resolve(outcome(tool('recall', { query: 'fixture' })));
    await clones.drain();
    const request = h.startTurn.mock.calls[1][0];
    expect(request).toMatchObject({
      model: 'original',
      effort: 'high',
      systemPromptOverride: 'original identity',
      timeoutMs: 1000,
      idleTimeoutMs: 500,
      workingDirectory: h.ports.cwd,
      inkSessionId: 'parent',
      studioId: 'old-studio',
    });
    expect(h.calls.every((call) => call.session === 'parent')).toBe(true);
    expect(h.calls.find((call) => call.name === 'log_activity')?.args).toMatchObject({
      sessionId: 'parent',
      payload: expect.objectContaining({ studioId: 'old-studio' }),
    });
  });

  it('does not launch when Stop wins during the initial async log write', async () => {
    const h = await fixture();
    const write = deferred<void>();
    const entered = deferred<void>();
    const stop = new AbortController();
    h.ports.createLog = (path) =>
      new SessionLog({
        path,
        sink: {
          write: async () => {
            entered.resolve();
            await write.promise;
          },
        },
      });
    const clones = h.create();
    const pending = clones.spawn(tasks, { signal: stop.signal });
    await entered.promise;
    stop.abort();
    write.resolve();
    await pending;
    await clones.drain();
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.ports.registry.runningCount).toBe(0);
  });

  it('does not launch a continuation when its log write failed', async () => {
    const h = await fixture([tool('signal_status', { status: 'in_progress' }), done]);
    h.ports.createLog = (path) =>
      new SessionLog({
        path,
        sink: {
          write: async (line) => {
            if (JSON.parse(line).type === 'backend_turn') throw new Error('fixture disk full');
          },
        },
      });
    const clones = h.create();
    await clones.spawn(tasks, {});
    await clones.drain();
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(h.ports.registry.get('clone-1')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('fixture disk full'),
    });
  });

  it('keeps a cancelled slot occupied and drain pending until the actual provider result arrives', async () => {
    const h = await fixture();
    const result = deferred<BackendRunResult>();
    const started = deferred<void>();
    h.startTurn.mockImplementationOnce(() => {
      started.resolve();
      return { result: result.promise, abort: h.abort };
    });
    const clones = h.create();
    await clones.spawn({ ...tasks, wait: false }, {});
    await started.promise;
    clones.cancel();
    expect(h.abort).toHaveBeenCalledOnce();
    expect(h.ports.registry.runningCount).toBe(1);
    let drained = false;
    const pending = clones.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    result.resolve(outcome(done));
    await pending;
    expect(h.ports.registry.get('clone-1')?.status).toBe('aborted');
  });

  it('aborts a provider that synchronously races Stop before its handle is returned', async () => {
    const h = await fixture();
    const stop = new AbortController();
    h.startTurn.mockImplementationOnce(() => {
      stop.abort();
      return { result: Promise.resolve(outcome(done)), abort: h.abort };
    });
    const clones = h.create();
    await clones.spawn(tasks, { signal: stop.signal });
    await clones.drain();
    expect(h.abort).toHaveBeenCalledOnce();
    expect(h.startTurn).toHaveBeenCalledOnce();
  });

  it('settles a failed log factory instead of leaving collect waiting forever', async () => {
    const h = await fixture();
    h.ports.createLog = () => {
      throw new Error('cannot open fixture log');
    };
    const clones = h.create();
    await clones.spawn({ ...tasks, wait: false }, {});
    await clones.drain();
    expect(JSON.stringify(await clones.collect({}))).toContain('cannot open fixture log');
    expect(h.ports.registry.runningCount).toBe(0);
    expect(h.startTurn).not.toHaveBeenCalled();
  });
});
