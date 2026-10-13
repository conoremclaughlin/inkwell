import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { composeInkSession, type SessionCompositionPorts } from './session-composition.js';
import { createSessionToolHost } from './session-tool-host.js';
import type { CodingTool } from './coding-tools.js';
import { SessionLog, ToolPolicyState } from '../runtime/index.js';
import type { BackendHost } from '../providers/types.js';
import type { BackendRunRequest, BackendRunResult } from '../providers/backend-runner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tool = (name: string, args: Record<string, unknown> = {}) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const outcome = (text: string): BackendRunResult => ({
  success: true,
  stdout: text,
  responseText: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'scripted fixture, no provider process',
  childExited: true,
});
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function readEvents(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function fixture(name: string, replies: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-composition-stop-')));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'fixture.txt'), `${name} harmless fixture contents`);
  const pi = await import('@mariozechner/pi-coding-agent');
  const load = vi.fn(
    async (path: string) => new Map([['read', pi.createReadTool(path) as unknown as CodingTool]])
  );
  const toolHost = createSessionToolHost({
    cwd,
    home: root,
    imageRoots: [cwd],
    tempDir: root,
    credentials: {},
    coding: { load, readDocument: async () => null },
  });
  const stop = new AbortController();
  const cloneStarted = deferred<void>();
  const cloneResult = deferred<BackendRunResult>();
  const terminalWriteEntered = deferred<void>();
  const terminalWrite = deferred<void>();
  const order: string[] = [];
  const log = new SessionLog({
    path: join(root, 'parent.jsonl'),
    sink: { write: (line) => appendFile(join(root, 'parent.jsonl'), line) },
  });
  const cloneLogs: SessionLog[] = [];
  const abortClone = vi.fn(() => {
    order.push('clone-abort-requested');
    // Cancellation is a request, not settlement: the test releases result later.
  });
  let cloneDispatches = 0;
  const start = vi.fn((request: BackendRunRequest) => {
    // The production parent supplies streaming callbacks; clones own a private log.
    if (!request.onEvent) {
      if (cloneLogs.length !== 1 || ++cloneDispatches !== 1)
        throw new Error('unscripted clone provider dispatch');
      order.push('clone-provider-started');
      cloneStarted.resolve();
      return {
        result: cloneResult.promise.finally(() => order.push('clone-provider-settled')),
        abort: abortClone,
      };
    }
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted parent provider dispatch');
    return {
      result: Promise.resolve().then(() => {
        request.onEvent?.({ kind: 'text-delta', text: reply });
        request.onEvent?.({ kind: 'text', text: reply });
        return outcome(reply);
      }),
      abort: vi.fn(),
    };
  });
  const policy = new ToolPolicyState('backend');
  policy.allowTool('read');
  policy.allowTool('spawn_agent');
  let id = 0;
  const ports: SessionCompositionPorts = {
    sbSlug: 'echo',
    cwd,
    cliAttached: false,
    contextBudgetAuto: false,
    history: [],
    log,
    policy,
    toolHost,
    runtime: {
      sessionId: name,
      backend: 'claude',
      model: 'fixture-model',
      backendTokenWindow: 200_000,
      maxContextTokens: 100_000,
      verbose: false,
      strictTools: true,
      toolMode: 'backend',
      toolRouting: 'local',
      activeSkills: [],
      userTimezone: 'America/Los_Angeles',
    },
    callInk: vi.fn(async (name) =>
      name === 'bootstrap'
        ? {
            identityFiles: { soul: 'Echo fixture identity' },
            user: { timezone: 'America/Los_Angeles' },
          }
        : { success: true, memories: [] }
    ),
    logActivity: vi.fn(async () => {}),
    prepareHost: vi.fn(async () => {}),
    unavailable: (reason) => {
      throw new Error(reason);
    },
    mintId: () => `${name}-${++id}`,
    startTurn: start,
    spawnContext: () => ({
      workingDirectory: cwd,
      inkSessionId: name,
      studioId: undefined,
      host: {} as BackendHost,
    }),
    cloneLog: (path) => {
      const cloneLog = new SessionLog({
        path,
        sink: {
          write: async (line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const terminal = event.type === 'clone_end' || event.type === 'clone_error';
            if (terminal) {
              terminalWriteEntered.resolve();
              await terminalWrite.promise;
            }
            await appendFile(path, line);
            if (terminal) order.push('clone-terminal-committed');
          },
        },
      });
      cloneLogs.push(cloneLog);
      return cloneLog;
    },
    approveClone: vi.fn(async () => false),
    approve: vi.fn(async () => false),
    presentation: {
      ui: { printLine: vi.fn(), printEvent: vi.fn(), startWaiting: () => vi.fn() },
      render: vi.fn(),
      progress: vi.fn(),
      toolStarted: vi.fn(),
      modelReported: vi.fn(),
      toolResult: vi.fn(),
      compacted: vi.fn(),
      notice: vi.fn(),
    },
  };
  let session: Awaited<ReturnType<typeof composeInkSession>> | undefined;
  cleanups.push(async () => {
    stop.abort();
    cloneResult.resolve(outcome('fixture cleanup'));
    terminalWrite.resolve();
    session?.clones.cancel();
    await session?.clones.drain();
    await Promise.all([log, ...cloneLogs].map((value) => value.close()));
    await toolHost.close();
    await rm(root, { recursive: true, force: true });
  });
  session = await composeInkSession(ports);
  return {
    session,
    ports,
    log,
    toolHost,
    load,
    start,
    stop,
    cloneStarted,
    cloneResult,
    abortClone,
    terminalWriteEntered,
    terminalWrite,
    order,
  };
}

describe('Stop across the real session and clone composition (no provider process)', () => {
  it.each(['resolve', 'reject'] as const)(
    'drains a background clone that will %s only after settlement, without closing another composition',
    async (settlement) => {
      const a = await fixture('stopped', [
        tool('spawn_agent', {
          tasks: [{ label: 'inspection', prompt: 'Inspect fixture.txt' }],
          wait: false,
        }),
        'Inspection continues in the background.',
      ]);
      const b = await fixture('independent', [
        tool('read', { path: 'fixture.txt' }),
        'Independent read completed.',
        'Still usable after the other host closes.',
      ]);
      const cacheA = await a.toolHost.cacheDir();
      const cacheB = await b.toolHost.cacheDir();
      expect(cacheA).not.toBe(cacheB);
      const parent = await a.session.run(
        { raw: 'Delegate the inspection in the background', source: 'user' },
        { signal: a.stop.signal, continueOnFailure: true }
      );
      await a.cloneStarted.promise;
      expect(parent?.execution.loop.success).toBe(true);
      expect(a.session.cloneRegistry.get('clone-1')).toMatchObject({
        status: 'running',
        parentSessionId: 'stopped',
      });
      expect(a.start).toHaveBeenCalledTimes(3); // parent, clone, parent continuation
      expect(a.abortClone).not.toHaveBeenCalled();

      // Stop the parent run's signal, not the registry: its background clone
      // must remain reachable even after that parent turn has returned.
      a.stop.abort(new Error('fixture parent Stop'));
      expect(a.abortClone).toHaveBeenCalledOnce();
      expect(a.session.cloneRegistry.runningCount).toBe(1);
      expect(a.order).not.toContain('clone-provider-settled');

      // This is the host's documented cancel -> drain -> close contract, not
      // a test of an API/CLI host's finally block or of OS child/process exit.
      a.session.clones.cancel();
      let drained = false;
      const drain = a.session.clones.drain().then(() => {
        drained = true;
        a.order.push('drained');
      });
      const closeHost = vi.fn(async () => {
        await a.toolHost.close();
        await a.log.close();
        a.order.push('host-closed');
      });
      const closing = drain.then(closeHost);
      await checkpoint();
      expect(drained).toBe(false);
      expect(closeHost).not.toHaveBeenCalled();
      await expect(access(cacheA)).resolves.toBeUndefined();

      // A separate composition can dispatch real harmless reads while A drains.
      const independent = await b.session.run(
        { raw: 'Read fixture.txt', source: 'user' },
        { signal: b.stop.signal, continueOnFailure: true }
      );
      expect(independent?.execution.loop.success).toBe(true);
      expect(b.start.mock.calls[1][0].prompt).toContain('independent harmless fixture contents');
      expect(b.start.mock.calls[1][0].prompt).not.toContain('stopped harmless fixture contents');
      expect(b.stop.signal.aborted).toBe(false);
      expect(b.session.cloneRegistry.runningCount).toBe(0);
      expect(drained).toBe(false);

      if (settlement === 'resolve') {
        // A late successful result tries to request more work; Stop must forbid
        // both that tool dispatch and the provider continuation it would cause.
        a.cloneResult.resolve(outcome(tool('read', { path: 'fixture.txt' })));
      } else {
        a.cloneResult.reject(new Error('fixture provider rejected after Stop'));
      }
      await a.terminalWriteEntered.promise;
      await checkpoint();
      expect(a.order).toContain('clone-provider-settled');
      expect(a.order).not.toContain('clone-terminal-committed');
      expect(a.session.cloneRegistry.runningCount).toBe(1);
      expect(drained).toBe(false);
      expect(closeHost).not.toHaveBeenCalled();
      await expect(access(cacheA)).resolves.toBeUndefined();

      a.terminalWrite.resolve();
      await closing;
      expect(a.order).toEqual([
        'clone-provider-started',
        'clone-abort-requested',
        'clone-provider-settled',
        'clone-terminal-committed',
        'drained',
        'host-closed',
      ]);
      expect(a.session.cloneRegistry.runningCount).toBe(0);
      const clone = a.session.cloneRegistry.get('clone-1')!;
      expect(clone.status).toBe('aborted');
      const cloneEvents = await readEvents(clone.transcriptPath);
      expect(cloneEvents.at(-1)).toMatchObject(
        settlement === 'resolve'
          ? { type: 'clone_end', stopReason: 'aborted' }
          : { type: 'clone_error', error: 'fixture provider rejected after Stop' }
      );
      expect(cloneEvents.some((event) => event.type === 'tool_intent')).toBe(false);
      expect(a.load).not.toHaveBeenCalled();
      expect(a.abortClone).toHaveBeenCalledOnce();
      expect(closeHost).toHaveBeenCalledOnce();
      await expect(access(cacheA)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(cacheB)).resolves.toBeUndefined();

      await expect(
        a.session.run(
          { raw: 'Must not dispatch after Stop', source: 'user' },
          { signal: a.stop.signal, continueOnFailure: true }
        )
      ).rejects.toThrow('fixture parent Stop');
      expect(a.start).toHaveBeenCalledTimes(3);
      const stillUsable = await b.session.run(
        { raw: 'Continue independently', source: 'user' },
        { signal: b.stop.signal, continueOnFailure: true }
      );
      expect(stillUsable?.execution.loop.success).toBe(true);
      expect(b.start).toHaveBeenCalledTimes(3);
      expect((await readEvents(b.log.path)).at(-1)).toMatchObject({
        type: 'assistant',
        content: 'Still usable after the other host closes.',
        success: true,
      });
    }
  );
});
