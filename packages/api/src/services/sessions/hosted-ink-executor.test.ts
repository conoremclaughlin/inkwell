import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSessionToolHost, type CodingTool } from '@inklabs/shared/node-host';
import { SessionLog, ToolPolicyState } from '@inklabs/shared/runtime';
import type { BackendHost, BackendRunResult, BackendRunRequest } from '@inklabs/shared/providers';
import { createHostedInkExecutor, type HostedInkEffects } from './hosted-ink-executor';
import { HostedInkSessionRunner, type HostedInkTurnDependencies } from './hosted-ink-session';
import type { ClaudeRunnerConfig } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
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
  const close = vi.fn(() => toolHost.close());
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
  const prepare = vi.fn(async () => effects);
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
