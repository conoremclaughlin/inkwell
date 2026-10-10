import { Router } from 'express';
import { addSessionControlRoute } from '../../routes/session-controls';
import {
  registerActiveRun,
  resetActiveRuns,
  attachRunControls,
  submitRunControl,
  isGenerationAdmitted,
} from './active-runs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSessionToolHost,
  createSkillInstructionHost,
  type CodingTool,
} from '@inklabs/shared/node-host';
import { SessionLog, ToolPolicyState } from '@inklabs/shared/runtime';
import type { BackendHost, BackendRunResult, BackendRunRequest } from '@inklabs/shared/providers';
import { createHostedInkExecutor, type HostedInkEffects } from './hosted-ink-executor';
import { HostedInkSessionRunner, type HostedInkTurnDependencies } from './hosted-ink-session';
import type { ClaudeRunnerConfig } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetActiveRuns();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const tool = (name: string, args: Record<string, unknown>) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const result = (text: string): BackendRunResult => ({
  success: true,
  childExited: true,
  responseText: text,
  stdout: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'scripted provider, no process',
});
async function fixture(replies: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-composition-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'fixture.txt'), 'Hosted harmless read');
  const events: Record<string, unknown>[] = [];
  const projections: Record<string, unknown>[] = [];
  const policy = new ToolPolicyState('backend');
  policy.allowTool('read');
  const pi = await import('@mariozechner/pi-coding-agent');
  const makeToolHost = () => {
    const toolHost = createSessionToolHost({
      cwd: root,
      home: root,
      imageRoots: [root],
      tempDir: root,
      credentials: {},
      coding: {
        load: async (cwd) => new Map([['read', pi.createReadTool(cwd) as unknown as CodingTool]]),
        readDocument: async () => null,
      },
    });
    cleanups.unshift(() => toolHost.close());
    return toolHost;
  };
  const toolHost = makeToolHost();
  const close = vi.fn(() => effects.toolHost.close());
  let n = 0;
  const effects: HostedInkEffects = {
    policy,
    toolHost,
    activeSkills: [],
    close,
    flushPolicy: vi.fn(async () => {}),
    mintId: () => `id-${++n}`,
    approve: async () => false,
    approveClone: async () => false,
    cloneLog: (path) => new SessionLog({ path, sink: { write: async () => {} } }),
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
  const mcp = vi.fn(async (name: string) =>
    name === 'bootstrap'
      ? { identityFiles: { soul: 'Echo fixture' }, user: { timezone: 'America/Los_Angeles' } }
      : { success: true, memories: [] }
  );
  const start = vi.fn((request: Record<string, unknown>) => {
    const text = replies.shift();
    if (text === undefined) throw new Error('unscripted provider');
    return {
      result: Promise.resolve().then(() => {
        const emit = request.onEvent as BackendRunRequest['onEvent'];
        emit?.({ kind: 'text-delta', text });
        emit?.({ kind: 'text', text });
        return result(text);
      }),
      abort: vi.fn(),
    };
  });
  const deps = (): HostedInkTurnDependencies => {
    const log = new SessionLog({
      path: join(root, 'session.jsonl'),
      sink: {
        write: async (line) => {
          await Promise.resolve();
          events.push(JSON.parse(line));
        },
      },
      onProjection: (event) => {
        projections.push(event);
      },
    });
    return {
      inkwell: { callTool: mcp },
      startProviderTurn: start,
      isHostedRefusal: () => false,
      deadlineAt: Date.now() + 30_000,
      sessionLog: {
        path: log.path,
        seed: (id) => log.seed(id),
        append: (event) => log.append(event),
        flush: () => log.flush(),
        read: async () => [...events],
      },
      providerContext: {
        workingDirectory: root,
        inkSessionId: 'hosted-fixture',
        studioId: undefined,
        host: {} as BackendHost,
      },
    };
  };
  let prepared = false;
  const prepare = vi.fn(async () => {
    // Production prepares fresh resources for each invocation, not a disposed
    // host retained by a previous turn. Keep mutable control-test inputs only.
    if (prepared) effects.toolHost = makeToolHost();
    prepared = true;
    return effects;
  });
  const runner = new HostedInkSessionRunner({
    execute: createHostedInkExecutor(prepare),
    forTurn: deps,
  });
  const config: ClaudeRunnerConfig = {
    workingDirectory: root,
    mcpConfigPath: join(root, '.mcp.json'),
    inkSessionId: 'hosted-fixture',
    turnEpoch: 'epoch-fixture',
    sbSlug: 'echo',
    maxTurns: 1,
    inkProvider: 'claude',
  };
  return { root, effects, events, projections, mcp, start, runner, config, deps, prepare };
}

describe('HostedInkSessionRunner executing the shared session composition', () => {
  it('bootstraps, reads through Pi, streams and confirms history before the reply, without ink chat', async () => {
    const h = await fixture([
      tool('read', { path: 'fixture.txt' }),
      'File says: Hosted harmless read',
    ]);
    const reply = vi.fn(async () => {
      expect(
        h.events.some(
          (event) =>
            event.type === 'assistant' && event.content === 'File says: Hosted harmless read'
        )
      ).toBe(true);
    });
    const outcome = await h.runner.run('Read fixture.txt', {
      config: { ...h.config, onTurnReply: reply },
    });
    expect(outcome).toMatchObject({
      success: true,
      finalTextResponse: 'File says: Hosted harmless read',
    });
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.start.mock.calls[1][0].prompt).toContain('Hosted harmless read');
    expect(h.effects.presentation.render).toHaveBeenCalled();
    expect(h.projections.some((event) => event.type === 'assistant')).toBe(true);
    expect(reply).toHaveBeenCalledOnce();
    expect(h.effects.close).toHaveBeenCalledOnce();
    expect(h.start.mock.calls.every(([request]) => request.backend === 'claude')).toBe(true);
  });

  it('takes the existing outer continuation loop and stops on signal_status', async () => {
    const h = await fixture([
      'First answer',
      `Done${tool('signal_status', { status: 'completed' })}`,
    ]);
    const replies = vi.fn(async () => {});
    const outcome = await h.runner.run('Work', {
      config: { ...h.config, maxTurns: 5, onTurnReply: replies },
    });
    expect(outcome.success).toBe(true);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls).toHaveLength(2);
    expect(h.events.at(-1)).toMatchObject({
      type: 'session_pause',
      turnsCompleted: 2,
      signal: expect.objectContaining({ status: 'completed' }),
    });
  });

  it('refuses missing host context instead of launching an ink subprocess fallback', async () => {
    const h = await fixture(['unused']);
    const deps = h.deps();
    delete (deps as { providerContext?: unknown }).providerContext;
    const runner = new HostedInkSessionRunner({
      execute: createHostedInkExecutor(h.prepare),
      forTurn: () => deps,
    });
    const outcome = await runner.run('Read', { config: h.config });
    expect(outcome.success).toBe(false);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('does not report success when the committed reply fails to hand over', async () => {
    const h = await fixture(['Saved answer']);
    const outcome = await h.runner.run('Answer', {
      config: {
        ...h.config,
        onTurnReply: async () => {
          throw new Error('fixture reply failure');
        },
      },
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('fixture reply failure');
    expect(h.events.some((event) => event.type === 'assistant')).toBe(true);
    expect(h.effects.close).toHaveBeenCalledOnce();
  });

  it('passes attachments as content only on their delivery turn and keeps the read directories', async () => {
    const h = await fixture(['One', `Done${tool('signal_status', { status: 'completed' })}`]);
    const media = join(h.root, 'fixture.txt');
    const outcome = await h.runner.run('Read attachment', {
      config: { ...h.config, maxTurns: 2 },
      mediaAttachments: [{ type: 'document', path: media, mimeType: 'text/plain' }],
    });
    expect(outcome.success).toBe(true);
    expect(h.start.mock.calls[0][0]).toMatchObject({
      media: [{ path: media, mimeType: 'text/plain' }],
      attachmentDirs: [h.root],
    });
    expect(h.start.mock.calls[0][0].prompt).toContain('[Attached files]');
    expect(h.start.mock.calls[1][0]).toMatchObject({ media: undefined, attachmentDirs: [h.root] });
  });
});

function controlsHarness(h: Awaited<ReturnType<typeof fixture>>) {
  const receipts: unknown[] = [];
  h.effects.manualSkills = createSkillInstructionHost(h.root, h.root);
  h.effects.controlReceipt = (receipt) => receipts.push(receipt);
  const runner = new HostedInkSessionRunner({
    execute: createHostedInkExecutor(h.prepare),
    forTurn: ({ sessionId, turnEpoch }) => {
      registerActiveRun({
        sessionId,
        turnEpoch,
        userId: 'fixture-owner',
        sbSlug: 'echo',
        backend: 'ink',
        startedAt: Date.now(),
      });
      return {
        ...h.deps(),
        controls: {
          assertCurrent: () => {
            if (!isGenerationAdmitted(sessionId, turnEpoch)) throw new Error('stale');
          },
          bind: (enqueue) => attachRunControls(sessionId, turnEpoch, enqueue),
        },
      };
    },
  });
  const router = Router();
  addSessionControlRoute(router, {
    authProvider: {
      verifyAccessToken: async () => ({ ok: true, token: { userId: 'fixture-owner' } }),
    } as never,
    dataComposer: {
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  user_id: 'fixture-owner',
                  cli_attached: false,
                  turn_epoch: h.config.turnEpoch,
                },
              }),
            }),
          }),
        }),
      }),
    } as never,
  });
  const post = async (control: Record<string, unknown>) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await router.stack[0].route!.stack[0].handle(
      {
        headers: {},
        params: { id: 'hosted-fixture' },
        body: { turnEpoch: h.config.turnEpoch, control },
      } as never,
      res as never,
      vi.fn()
    );
    return res;
  };
  return { runner, post, receipts };
}

describe('hosted live controls through the admitted route and real composition', () => {
  it('queues during a provider, persists at the final boundary, then replays, resumes and removes drift', async () => {
    const h = await fixture(['second', 'third', 'fourth']);
    const skillsPath = join(h.root, '.ink', 'skills', 'review');
    await mkdir(skillsPath, { recursive: true });
    await writeFile(join(skillsPath, 'SKILL.md'), 'CONTROL SKILL ORIGINAL');
    const c = controlsHarness(h);
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    let finish!: (value: BackendRunResult) => void;
    h.start.mockImplementationOnce(() => {
      started();
      return {
        result: new Promise<BackendRunResult>((r) => {
          finish = r;
        }),
        abort: vi.fn(),
      };
    });
    const first = c.runner.run('first', { config: h.config });
    await began;
    const model = await c.post({ controlId: 'model', action: 'model', model: 'fixture-selected' });
    const skill = await c.post({ controlId: 'skill', action: 'skill_use', name: 'review' });
    expect(model.status).toHaveBeenCalledWith(202);
    expect(skill.status).toHaveBeenCalledWith(202);
    expect(h.events.some((e) => e.type === 'session_control')).toBe(false);
    expect(h.start.mock.calls[0][0].model).not.toBe('fixture-selected');
    finish(result('first'));
    expect((await first).success).toBe(true);
    expect(c.receipts).toEqual([
      expect.objectContaining({ controlId: 'model', status: 'applied' }),
      expect.objectContaining({ controlId: 'skill', status: 'applied' }),
    ]);
    const committed = h.events.filter((e) => e.type === 'session_control');
    expect(committed).toHaveLength(2);
    expect(h.projections.filter((e) => e.type === 'session_control')).toEqual(committed);
    expect(JSON.stringify(committed)).not.toContain('CONTROL SKILL ORIGINAL');
    const closed = await c.post({ controlId: 'late', action: 'model', model: null });
    expect(closed.status).toHaveBeenCalledWith(409);
    h.config.turnEpoch = 'epoch-second';
    expect((await c.runner.run('second', { config: h.config })).success).toBe(true);
    const second = h.start.mock.calls[1][0];
    expect(second.model).toBe('fixture-selected');
    expect(second.prompt).toContain('CONTROL SKILL ORIGINAL');
    expect(second.backendSessionId).toBeUndefined();
    const baseline = second.backendSessionSeedId;
    h.config.turnEpoch = 'epoch-third';
    await c.runner.run('third', { config: h.config });
    expect(h.start.mock.calls[2][0].backendSessionId).toBe(baseline);
    await writeFile(join(skillsPath, 'SKILL.md'), 'CHANGED WITHOUT CONSENT');
    h.config.turnEpoch = 'epoch-fourth';
    await c.runner.run('fourth', { config: h.config });
    const fourth = h.start.mock.calls[3][0];
    expect(fourth.backendSessionId).toBeUndefined();
    expect(fourth.prompt).not.toContain('CHANGED WITHOUT CONSENT');
    expect(fourth.prompt).not.toContain('CONTROL SKILL ORIGINAL');
    expect(h.events.filter((e) => e.type === 'session_control').at(-1)).toMatchObject({
      reason: 'replay_skill_removed',
      selection: { skills: [] },
    });
  });
  it('retains unavailable skills without recovering an incomplete native seed on the next run', async () => {
    const h = await fixture(['temporarily absent', 'restored', 'resumed']);
    const path = join(h.root, '.ink', 'skills', 'review');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), 'RECOVERED SKILL INSTRUCTION');
    const c = controlsHarness(h);
    const host = h.effects.manualSkills!;
    const [found] = await host.discover();
    const { content: _content, ...selected } = await host.load(found);
    h.events.push({
      eid: 1,
      type: 'session_control',
      version: 1,
      controlId: 'prior',
      backend: 'claude',
      selection: { skills: [selected] },
    });
    h.effects.manualSkills = {
      ...host,
      load: async () => {
        throw Object.assign(new Error('busy'), { code: 'EMFILE' });
      },
    };
    expect((await c.runner.run('unavailable', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[0][0].prompt).not.toContain('RECOVERED SKILL INSTRUCTION');
    expect(h.events.filter((e) => e.type === 'session_control')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'backend_session').at(-1)).toMatchObject({
      recoverable: false,
    });
    h.effects.manualSkills = host;
    h.config.turnEpoch = 'epoch-restored';
    expect((await c.runner.run('restored', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[1][0].backendSessionId).toBeUndefined();
    expect(h.start.mock.calls[1][0].prompt).toContain('RECOVERED SKILL INSTRUCTION');
    const restored = h.start.mock.calls[1][0].backendSessionSeedId;
    h.config.turnEpoch = 'epoch-resumed';
    expect((await c.runner.run('resumed', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[2][0].backendSessionId).toBe(restored);
  });
  it('hydrates past future records and commits a changed-provider reset before launch', async () => {
    const h = await fixture(['reset complete']);
    const c = controlsHarness(h);
    h.events.push(
      {
        eid: 1,
        type: 'session_control',
        version: 1,
        controlId: 'prior',
        backend: 'codex',
        selection: { model: 'old-provider-only', skills: [] },
      },
      { eid: 2, type: 'session_control', version: 2, selection: 'opaque' },
      { eid: 3, type: 'backend_session', id: 'opaque-provider-seed', routing: 'local' }
    );
    expect((await c.runner.run('reset', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[0][0].model).not.toBe('old-provider-only');
    expect(h.start.mock.calls[0][0].backendSessionId).toBeUndefined();
    const reset = h.events.findIndex((e) => e.reason === 'replay_backend_changed');
    expect(reset).toBeGreaterThan(2);
    expect(reset).toBeLessThan(h.events.map((e) => e.type).lastIndexOf('backend_session'));
    expect(h.effects.presentation.notice).toHaveBeenCalledWith(
      'Skipped an invalid or unsupported session control record.'
    );
  });
  it('does not adopt a CLI seed that never applied the hosted selection', async () => {
    const h = await fixture(['reseeding', 'resuming']);
    const c = controlsHarness(h);
    h.events.push(
      {
        eid: 1,
        type: 'session_control',
        version: 1,
        controlId: 'selected',
        backend: 'claude',
        selection: { model: 'persisted-model', skills: [] },
      },
      // A CLI without durable control support does not stamp an applied control id.
      { eid: 2, type: 'backend_session', id: 'cli-unaware', routing: 'local' }
    );
    expect((await c.runner.run('hosted again', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[0][0].backendSessionId).toBeUndefined();
    expect(h.start.mock.calls[0][0].model).toBe('persisted-model');
    expect(h.events.filter((e) => e.type === 'backend_session').at(-1)).toMatchObject({
      controlId: 'selected',
    });
    const seed = h.start.mock.calls[0][0].backendSessionSeedId;
    h.config.turnEpoch = 'epoch-next';
    expect((await c.runner.run('matching host', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[1][0].backendSessionId).toBe(seed);
  });
  it('applies before the next outer turn, not during an inner provider turn', async () => {
    const h = await fixture(['next turn']);
    h.config.maxTurns = 2;
    const c = controlsHarness(h);
    h.start.mockImplementationOnce(() => {
      expect(
        submitRunControl('hosted-fixture', 'epoch-fixture', {
          controlId: 'between',
          action: 'model',
          model: 'outer-model',
        }).status
      ).toBe('pending');
      return { result: Promise.resolve(result('first')), abort: vi.fn() };
    });
    expect((await c.runner.run('first', { config: h.config })).success).toBe(true);
    expect(h.start.mock.calls[0][0].model).not.toBe('outer-model');
    expect(h.start.mock.calls[1][0].model).toBe('outer-model');
    expect(h.start.mock.calls[1][0].backendSessionId).toBeUndefined();
    const controlIndex = h.events.findIndex((e) => e.type === 'session_control');
    expect(controlIndex).toBeGreaterThan(h.events.findIndex((e) => e.type === 'assistant'));
    expect(controlIndex).toBeLessThan(h.events.map((e) => e.type).lastIndexOf('backend_session'));
  });
  it('Stop closes the mailbox and refuses queued controls without a late applied receipt', async () => {
    const h = await fixture([]);
    const c = controlsHarness(h);
    const stop = new AbortController();
    h.config.signal = stop.signal;
    h.start.mockImplementationOnce(() => {
      submitRunControl('hosted-fixture', 'epoch-fixture', {
        controlId: 'stop',
        action: 'model',
        model: 'never',
      });
      stop.abort();
      return { result: Promise.resolve(result('stopped')), abort: vi.fn() };
    });
    expect((await c.runner.run('first', { config: h.config })).success).toBe(false);
    expect(h.events.filter((e) => e.type === 'session_control')).toEqual([]);
    expect(c.receipts).toContainEqual(
      expect.objectContaining({ controlId: 'stop', status: 'refused' })
    );
    expect(
      submitRunControl('hosted-fixture', 'epoch-fixture', {
        controlId: 'after',
        action: 'skill_clear',
      }).status
    ).toBe('refused');
  });
});
