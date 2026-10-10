/** Real hosted file/media effects through the executor; provider and Ink ports are inert. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32, deflateSync } from 'zlib';
import { createSessionToolHost } from '@inklabs/shared/node-host';
import { SessionLog, ToolPolicyState } from '@inklabs/shared/runtime';
import type { BackendHost, BackendRunRequest, BackendRunResult } from '@inklabs/shared/providers';
import { createHostedInkCoding } from './hosted-ink-coding';
import { createHostedInkExecutor, type HostedInkEffects } from './hosted-ink-executor';
import { HostedInkSessionRunner } from './hosted-ink-session';
import type { ClaudeRunnerConfig } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tool = (name: string, args: Record<string, unknown> = {}) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;

/** Invented, fully decodable PNG (not just an image header). */
function png(shade: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, shade, shade, shade, shade, shade, shade]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Step = { text: string; receipt?: 'missing' | 'failed' };
async function fixture(steps: Step[], shade = 128, mediaLimits?: { maxBytes?: number }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-media-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const tempDir = join(root, 'temp');
  const files = join(home, '.ink', 'files');
  await Promise.all([cwd, home, tempDir, files].map((dir) => mkdir(dir, { recursive: true })));
  const bytes = png(shade);
  await writeFile(join(cwd, 'image.png'), bytes);
  await writeFile(join(files, 'attachment.png'), bytes);
  const logPath = join(root, 'session.jsonl');
  await writeFile(logPath, '');
  const history = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const sessionEnv = vi.fn(async (): Promise<NodeJS.ProcessEnv> => {
    throw new Error('No credentials or shell handoff belong in this fixture');
  });
  const resolveBinary = vi.fn(async (): Promise<string> => {
    throw new Error('No search subprocess belongs in this fixture');
  });
  const results: unknown[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  let id = 0;
  const start = vi.fn((request: BackendRunRequest) => {
    const step = steps.shift();
    if (!step) throw new Error('Unscripted provider call');
    return {
      abort: vi.fn(),
      result: (async (): Promise<BackendRunResult> => {
        // Check the bytes at the provider handoff, before resource cleanup.
        for (const image of request.contextImages ?? []) {
          expect(image.mimeType).toBe('image/png');
          expect(await readFile(image.path)).toEqual(bytes);
        }
        request.onEvent?.({ kind: 'text', text: step.text });
        return {
          success: step.receipt !== 'failed',
          childExited: true,
          responseText: step.text,
          stdout: step.text,
          stderr: '',
          exitCode: step.receipt === 'failed' ? 1 : 0,
          durationMs: 1,
          command: 'fixture provider, no process',
          contextImagesDelivered: step.receipt === 'missing' ? undefined : request.contextImages,
        };
      })(),
    };
  });
  const runner = new HostedInkSessionRunner({
    execute: createHostedInkExecutor(async (_input, ports): Promise<HostedInkEffects> => {
      const coding = await createHostedInkCoding({
        cwd,
        tempDir,
        shell: '/bin/bash',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
        signal: ports.signal,
        sessionEnv,
        resolveBinary,
      });
      const toolHost = createSessionToolHost({
        cwd,
        home,
        tempDir,
        imageRoots: [cwd, files],
        credentials: {},
        coding: coding.ports,
        logPath: ports.sessionLog.path,
        mediaLimits,
      });
      const close = vi.fn(async () => {
        await coding.close();
        await toolHost.close();
      });
      closes.push(close);
      cleanups.push(close);
      const policy = new ToolPolicyState('backend');
      for (const name of ['read', 'write', 'edit', 'ls', 'view_image']) policy.allowTool(name);
      return {
        toolHost,
        policy,
        activeSkills: [],
        close,
        flushPolicy: async () => {},
        mintId: () => `fixture-${++id}`,
        approve: async (name, _reason, args) => {
          if (!['write', 'edit'].includes(name) || args.path !== 'nested/note.txt') return false;
          policy.grantTool(name);
          return true;
        },
        approveClone: async () => false,
        cloneLog: () => {
          throw new Error('No clone belongs in this fixture');
        },
        presentation: {
          ui: { printLine: vi.fn(), printEvent: vi.fn(), startWaiting: () => vi.fn() },
          render: vi.fn(),
          progress: vi.fn(),
          toolStarted: vi.fn(),
          modelReported: vi.fn(),
          toolResult: (result) => results.push(result),
          compacted: vi.fn(),
          notice: vi.fn(),
        },
      };
    }),
    forTurn: () => {
      const log = new SessionLog({
        path: logPath,
        sink: { write: (line) => appendFile(logPath, line) },
      });
      return {
        inkwell: {
          callTool: async (name) =>
            name === 'bootstrap'
              ? {
                  identityFiles: { soul: 'Echo fixture' },
                  user: { timezone: 'America/Los_Angeles' },
                }
              : { success: true, memories: [] },
        },
        // The executor supplies the full shared request through the runner's opaque port.
        startProviderTurn: (request) => start(request as unknown as BackendRunRequest),
        isHostedRefusal: () => false,
        deadlineAt: Date.now() + 30_000,
        sessionLog: {
          path: logPath,
          seed: (eid) => log.seed(eid),
          append: (event) => log.append(event),
          flush: () => log.flush(),
          read: history,
        },
        providerContext: {
          workingDirectory: cwd,
          inkSessionId: 'media-fixture',
          studioId: undefined,
          host: {} as BackendHost,
        },
      };
    },
  });
  const config: ClaudeRunnerConfig = {
    workingDirectory: cwd,
    mcpConfigPath: join(root, 'unused.json'),
    inkSessionId: 'media-fixture',
    turnEpoch: 'fixture-epoch',
    sbSlug: 'echo',
    inkProvider: 'claude',
    toolRouting: 'local',
    maxTurns: 1,
  };
  return {
    root,
    cwd,
    home,
    files,
    bytes,
    history,
    logPath,
    start,
    results,
    closes,
    sessionEnv,
    resolveBinary,
    run: (overrides: Partial<ClaudeRunnerConfig> = {}) =>
      runner.run('Inspect the fixture', { config: { ...config, ...overrides } }),
  };
}

describe('hosted coding/media through the shared loop and file log', () => {
  it('writes, edits and reads via actual hosted Pi effects before replying, then replays on a fresh executor', async () => {
    const h = await fixture([
      { text: tool('write', { path: 'nested/note.txt', content: 'old\n' }) },
      {
        text: tool('edit', {
          path: 'nested/note.txt',
          edits: [{ oldText: 'old', newText: 'new' }],
        }),
      },
      { text: tool('read', { path: 'nested/note.txt' }) },
      { text: 'The note now says new.' },
      { text: tool('read', { path: 'nested/note.txt' }) },
      { text: 'It still says new.' },
    ]);
    const reply = vi.fn(async () => {
      expect((await h.history()).some((event) => event.content === 'The note now says new.')).toBe(
        true
      );
      expect(await readFile(join(h.cwd, 'nested/note.txt'), 'utf8')).toBe('new\n');
    });
    expect(await h.run({ onTurnReply: reply })).toMatchObject({ success: true });
    expect(h.start.mock.calls[3][0].prompt).toContain('new');
    expect(reply).toHaveBeenCalledOnce();
    expect(h.closes[0]).toHaveBeenCalledOnce();
    const previous = h.start.mock.calls[0][0].backendSessionSeedId;
    expect(await h.run()).toMatchObject({ success: true });
    expect(h.start.mock.calls[4][0].backendSessionId).toBe(previous);
    expect(h.start.mock.calls[5][0].prompt).toContain('new');
    expect(h.sessionEnv).not.toHaveBeenCalled();
    expect(h.resolveBinary).not.toHaveBeenCalled();
    const events = await h.history();
    expect(new Set(events.map((event) => event.eid)).size).toBe(events.length);
  });

  it.each(['read', 'view_image'])(
    '%s captures images, deduplicates receipts, resends on reseed and respects eviction',
    async (name) => {
      const h = await fixture([
        { text: tool(name, { path: 'image.png' }) },
        { text: tool('ls') },
        { text: tool('evict_context', { source: 'server' }) },
        { text: tool('evict_context', { source: 'local-tool' }) },
        { text: 'Done.' },
        { text: 'Fresh executor after eviction.' },
      ]);
      expect(await h.run()).toMatchObject({ success: true });
      const requests = h.start.mock.calls.map(([request]) => request);
      expect(requests.map((r) => r.contextImages?.length ?? 0)).toEqual([0, 1, 0, 1, 0]);
      expect(requests[3].contextImages).toEqual(requests[1].contextImages);
      expect(requests[3].backendSessionSeedId).not.toBe(requests[0].backendSessionSeedId);
      expect(requests[4].backendSessionSeedId).not.toBe(requests[3].backendSessionSeedId);
      expect(requests[1].prompt).toContain('img:');
      expect(requests[1].prompt).not.toContain(h.bytes.toString('base64'));
      const events = await h.history();
      expect(
        events.some(
          (e) =>
            e.type === 'local_tool_call' &&
            e.tool === name &&
            JSON.stringify(e.result).includes('img:')
        )
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(h.bytes.toString('base64'));
      // The evicted image must not return when a new host hydrates the committed log.
      expect(await h.run()).toMatchObject({ success: true });
      expect(h.start.mock.calls[5][0].contextImages).toBeUndefined();
    }
  );

  it('reoffers an image when a successful provider has not acknowledged delivery', async () => {
    const h = await fixture([
      { text: tool('read', { path: 'image.png' }) },
      { text: tool('ls'), receipt: 'missing' },
      { text: 'Now received.' },
    ]);
    expect(await h.run()).toMatchObject({ success: true });
    expect(h.start.mock.calls[1][0].contextImages).toHaveLength(1);
    expect(h.start.mock.calls[2][0].contextImages).toEqual(h.start.mock.calls[1][0].contextImages);
  });

  it('does not accept an image receipt from a failed provider result', async () => {
    const h = await fixture([
      { text: tool('read', { path: 'image.png' }) },
      { text: 'Failed after input.', receipt: 'failed' },
      { text: 'Next outer turn received it.' },
    ]);
    expect(await h.run({ maxTurns: 2 })).toMatchObject({ success: true });
    const requests = h.start.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(requests[1].contextImages).toHaveLength(1);
    expect(requests[2].contextImages).toEqual(requests[1].contextImages);
  });

  it('view_image reads the explicit attachment root but refuses an outside path without capturing it', async () => {
    const steps: Step[] = [];
    const h = await fixture(steps);
    const outside = join(h.root, 'outside.png');
    await writeFile(outside, h.bytes);
    steps.push({ text: tool('view_image', { path: outside }) }, { text: 'Refused safely.' });
    const allowed = await fixture([
      { text: tool('view_image', { path: '~/.ink/files/attachment.png' }) },
      { text: 'Saw attachment.' },
    ]);
    expect(await allowed.run()).toMatchObject({ success: true });
    expect(allowed.start.mock.calls[1][0].contextImages).toHaveLength(1);
    // Refusal is observable at the continuation even when the provider then stops.
    expect(await h.run()).toMatchObject({ success: true });
    expect(h.start.mock.calls[1][0].contextImages).toBeUndefined();
    expect(JSON.stringify(h.results)).toContain('outside the directories');
    expect((await h.history()).some((e) => Array.isArray(e.images) && e.images.length)).toBe(false);
  });

  it('restores retained bytes into a fresh seed after closing both host and original source', async () => {
    const h = await fixture([
      { text: tool('read', { path: 'image.png' }) },
      { text: 'First host saw it.' },
      { text: tool('evict_context', { source: 'server' }) },
      { text: 'Fresh seed saw it.' },
    ]);
    expect(await h.run()).toMatchObject({ success: true });
    expect(h.start.mock.calls[1][0].contextImages).toHaveLength(1);
    const image = h.start.mock.calls[1][0].contextImages![0];
    await rm(join(h.cwd, 'image.png'));
    await expect(readFile(image.path)).resolves.toEqual(h.bytes);
    expect(await h.run()).toMatchObject({ success: true });
    const fresh = h.start.mock.calls[3][0];
    expect(fresh.backendSessionSeedId).toBeDefined();
    expect(fresh.backendSessionSeedId).not.toBe(h.start.mock.calls[0][0].backendSessionSeedId);
    expect(fresh.contextImages).toEqual([image]);
    const events = await h.history();
    const mediaEvent = events.find((e) => e.imageContext);
    expect(mediaEvent).toMatchObject({
      imageContext: {
        version: 1,
        images: [{ retained: { version: 1, byteLength: h.bytes.length } }],
      },
    });
    expect(JSON.stringify(mediaEvent?.imageContext)).not.toContain(image.path);
    expect(JSON.stringify(events)).not.toContain(h.bytes.toString('base64'));
  });

  it.each(['confirmed', 'missing'] as const)(
    'reoffers restored bytes on native resume with a %s prior receipt',
    async (receipt) => {
      const h = await fixture([
        { text: tool('read', { path: 'image.png' }) },
        { text: 'First turn.', receipt: receipt === 'missing' ? 'missing' : undefined },
        { text: 'Resumed.' },
      ]);
      expect(await h.run()).toMatchObject({ success: true });
      const seed = h.start.mock.calls[0][0].backendSessionSeedId;
      const image = h.start.mock.calls[1][0].contextImages![0];
      expect(await h.run()).toMatchObject({ success: true });
      const resumed = h.start.mock.calls[2][0];
      expect(resumed.backendSessionId).toBe(seed);
      expect(resumed.backendSessionSeedId).toBeUndefined();
      expect(resumed.contextImages).toEqual([image]);
      // A descriptor and backend marker are not a durable per-image delivery receipt.
    }
  );

  it.each(['missing', 'corrupt', 'quota'] as const)(
    '%s retention leaves live delivery intact and an honest fresh-seed note',
    async (failure) => {
      const h = await fixture(
        [
          { text: tool('view_image', { path: 'image.png' }) },
          { text: 'Live image arrived.' },
          { text: tool('evict_context', { source: 'server' }) },
          { text: 'No image on fresh seed.' },
          { text: tool('evict_context', { source: 'local-tool' }) },
          { text: 'Evicted placeholder.' },
          { text: tool('evict_context', { source: 'server' }) },
          { text: 'Still evicted.' },
        ],
        128,
        failure === 'quota' ? { maxBytes: 1 } : undefined
      );
      expect(await h.run()).toMatchObject({ success: true });
      expect(h.start.mock.calls[1][0].contextImages).toHaveLength(1);
      const image = h.start.mock.calls[1][0].contextImages![0];
      expect(image).toBeDefined(); // quota is NOT a live-delivery limit
      if (failure !== 'quota') await expect(readFile(image.path)).resolves.toEqual(h.bytes);
      if (failure === 'missing') await rm(image.path);
      if (failure === 'corrupt') await writeFile(image.path, Buffer.alloc(h.bytes.length));
      if (failure === 'quota')
        await expect(readFile(image.path)).rejects.toMatchObject({ code: 'ENOENT' });
      // The valid original remains, but replay must never reread it.
      expect(await readFile(join(h.cwd, 'image.png'))).toEqual(h.bytes);
      expect(await h.run()).toMatchObject({ success: true });
      const fresh = h.start.mock.calls[3][0];
      expect(fresh.backendSessionSeedId).toBeDefined();
      expect(fresh.contextImages).toBeUndefined();
      expect(fresh.prompt).toContain('unavailable: an image was here');
      expect(await h.run()).toMatchObject({ success: true });
      expect(await h.run()).toMatchObject({ success: true });
      expect(h.start.mock.calls[7][0].contextImages).toBeUndefined();
      expect(h.start.mock.calls[7][0].prompt).not.toContain('unavailable: an image was here');
    }
  );

  it('overlapping sessions deliver only their own image bytes', async () => {
    const a = await fixture(
      [{ text: tool('read', { path: 'image.png' }) }, { text: 'A done.' }],
      32
    );
    const b = await fixture(
      [{ text: tool('read', { path: 'image.png' }) }, { text: 'B done.' }],
      224
    );
    const outcomes = await Promise.all([a.run(), b.run()]);
    expect(outcomes.every((o) => o.success)).toBe(true);
    expect(a.start.mock.calls[1][0].contextImages?.[0].path).not.toBe(
      b.start.mock.calls[1][0].contextImages?.[0].path
    );
    expect(a.closes[0]).toHaveBeenCalledOnce();
    expect(b.closes[0]).toHaveBeenCalledOnce();
  });
});
