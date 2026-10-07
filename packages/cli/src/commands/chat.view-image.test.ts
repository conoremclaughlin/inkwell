import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32, deflateSync } from 'zlib';

/**
 * An image a tool returns reaches the model as an image, end to end.
 *
 * Driven through runChat with only the backend spawn and the Inkwell client
 * stubbed: Pi's `read`, `view_image`, the capture step, the ledger and the
 * agent loop's relay all run for real, and each assertion reads the request
 * the backend would have been spawned with. That request is the whole of what
 * the model receives — its prompt text and the image blocks beside it.
 *
 * The first test is the regression: before this change, `read` on a PNG put
 * its base64 into the continuation prompt, where the relay cut it at 200 KB.
 */

const testState = vi.hoisted(() => ({
  inputs: [] as string[],
  runBackendImpl: vi.fn(),
}));

vi.mock('../backends/identity.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backends/identity.js')>();
  return {
    ...original,
    resolveSlug: (agent?: string) => agent || 'myra',
    readIdentityJson: () => ({ studioId: 'studio-test' }),
  };
});

vi.mock('../lib/ink-client.js', () => ({
  InkClient: class MockInkClient {
    public async callTool(tool: string): Promise<unknown> {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'start_session':
          return { session: { id: 'sess-1' } };
        case 'get_inbox':
          return { messages: [] };
        default:
          return { success: true };
      }
    }
  },
}));

vi.mock('../repl/backend-runner.js', () => ({
  runBackendTurn: (request: Record<string, unknown>) => testState.runBackendImpl(request),
  startBackendTurn: (request: Record<string, unknown>) => ({
    result: testState.runBackendImpl(request),
    abort: () => {},
  }),
}));

vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
  loadSkillInstruction: (skill: Record<string, unknown>) => ({ ...skill, content: '' }),
}));

vi.mock('../repl/turn-signal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../repl/turn-signal.js')>();
  return {
    ...original,
    createTurnSignal: () => ({
      open: async () => true,
      close: async () => true,
      detach: async () => true,
    }),
  };
});

vi.mock('../repl/ink/index.js', () => ({
  renderInkChat: async () => null,
  InkExitSignal: class InkExitSignal extends Error {},
}));

vi.mock('readline/promises', () => ({
  createInterface: () => ({
    question: async () => {
      const next = testState.inputs.shift();
      if (next === undefined) throw new Error('No scripted input left for readline question');
      return next;
    },
    on: () => undefined,
    close: () => undefined,
  }),
}));

import { runChat } from './chat.js';

/** A real, decodable RGB PNG: valid CRCs, one deflated IDAT. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // Varied bytes, so the base64 is not one repeated character a substring
  // check could match anywhere.
  const raw = Buffer.concat(
    Array.from({ length: height }, (_, y) => {
      const row = Buffer.alloc(1 + width * 3);
      for (let x = 0; x < width * 3; x++) row[1 + x] = (x * 7 + y * 13) & 0xff;
      return row;
    })
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface SpawnRequest {
  prompt: string;
  contextImages?: Array<{
    ref: string;
    path: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
  backendSessionId?: string;
  backendSessionSeedId?: string;
}

const toolCall = (tool: string, args: Record<string, unknown>) =>
  '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```';

/**
 * Script the backend: one reply per spawn, in order; 'done' once they run out.
 *
 * Like a real adapter, it reports which offered images its input carried.
 * `carry` picks them (default: all); the host must record only those.
 */
function scriptBackend(
  replies: string[],
  carry: (offered: NonNullable<SpawnRequest['contextImages']>, spawn: number) => unknown[] = (
    offered
  ) => offered
): void {
  let spawn = 0;
  testState.runBackendImpl.mockImplementation(async (request: SpawnRequest) => {
    const carried = request.contextImages ? carry(request.contextImages, spawn) : [];
    spawn += 1;
    return {
      success: true,
      stdout: replies.shift() ?? 'done',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      command: 'mock',
      ...(carried.length > 0 ? { contextImagesDelivered: carried } : {}),
    };
  });
}

const spawns = (): SpawnRequest[] =>
  testState.runBackendImpl.mock.calls.map((call) => call[0] as SpawnRequest);

describe('images from tools reach the model as images', () => {
  const originalCwd = process.cwd();
  const originalPolicyPath = process.env.INK_TOOL_POLICY_PATH;
  let testCwd: string;
  let png: Buffer;
  let pngBase64Head: string;

  beforeEach(() => {
    testState.inputs = [];
    testState.runBackendImpl.mockReset();
    testCwd = mkdtempSync(join(tmpdir(), 'ink-chat-view-image-'));
    process.chdir(testCwd);
    process.env.INK_TOOL_POLICY_PATH = join(testCwd, '.ink', 'security', 'tool-policy.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    png = makePng(640, 480);
    pngBase64Head = png.toString('base64').slice(0, 80);
    writeFileSync(join(testCwd, 'shot.png'), png);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPolicyPath === undefined) delete process.env.INK_TOOL_POLICY_PATH;
    else process.env.INK_TOOL_POLICY_PATH = originalPolicyPath;
    process.chdir(originalCwd);
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('read on an image: no base64 in the prompt, and the picture rides the continuation into the same session', async () => {
    scriptBackend([toolCall('read', { path: 'shot.png' }), 'A textured rectangle.']);
    testState.inputs = ['what is in shot.png?', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [opening, continuation] = spawns();
    expect(continuation).toBeDefined();
    expect(continuation!.prompt).toContain('Tool results from previous turn');
    expect(continuation!.prompt).not.toContain(pngBase64Head);
    expect(continuation!.prompt).toMatch(/"image":"img:[0-9a-f]{16}"/);

    expect(continuation!.contextImages).toHaveLength(1);
    const [image] = continuation!.contextImages!;
    expect(image).toMatchObject({ mimeType: 'image/png', width: 640, height: 480 });
    expect(readFileSync(image!.path).equals(png)).toBe(true);
    // Delivered into the session the opening spawn seeded, not a new one.
    expect(opening!.backendSessionSeedId).toBeDefined();
    expect(continuation!.backendSessionId).toBe(opening!.backendSessionSeedId);
  });

  it('view_image: the descriptor in the prompt, the image beside it, and not sent again to a session that has it', async () => {
    scriptBackend([toolCall('view_image', { path: 'shot.png' }), 'Seen.', 'Still here.']);
    testState.inputs = ['look at shot.png', 'and again?', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, continuation, nextTurn] = spawns();
    expect(continuation!.prompt).toContain('shot.png (image/png, 640x480, ~410 tokens)');
    expect(continuation!.prompt).not.toContain(pngBase64Head);
    expect(continuation!.contextImages?.map((i) => i.width)).toEqual([640]);

    // The next turn resumes the session that already holds the picture.
    expect(nextTurn!.backendSessionId).toBe(continuation!.backendSessionId);
    expect(nextTurn!.contextImages).toBeUndefined();
  });

  it('list_context shows the image and its cost; evict_context removes it from every later spawn', async () => {
    scriptBackend([
      toolCall('view_image', { path: 'shot.png' }),
      toolCall('list_context', { source: 'local-tool' }),
      toolCall('evict_context', { source: 'local-tool' }),
      'Evicted.',
    ]);
    testState.inputs = ['view, list, then evict', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, viewed, listed, afterEvict] = spawns();
    expect(viewed!.contextImages).toHaveLength(1);
    const ref = viewed!.contextImages![0]!.ref;

    // The listing's own result, relayed to the model. list_context answers with
    // JSON inside a text block, so the relay's stringify escapes its quotes.
    const listedImages = `"images":[{"image":"${ref}","width":640,"height":480,"tokens":410}]`;
    expect(listed!.prompt).toContain(JSON.stringify(listedImages).slice(1, -1));
    expect(listed!.contextImages).toBeUndefined();

    // Eviction rolled the provider session; the fresh seed carries no image.
    expect(afterEvict!.backendSessionSeedId).toBeDefined();
    expect(afterEvict!.backendSessionSeedId).not.toBe(viewed!.backendSessionId);
    expect(afterEvict!.contextImages).toBeUndefined();
  });

  // Control for the refusal case below: the same script, with the second
  // image carried, leaves nothing to offer on the next turn.
  it('an image the backend carried is not offered again (control)', async () => {
    writeFileSync(join(testCwd, 'second.png'), makePng(320, 240));
    scriptBackend([
      toolCall('view_image', { path: 'shot.png' }),
      toolCall('view_image', { path: 'second.png' }),
      'Seen both.',
      'Next turn.',
    ]);
    testState.inputs = ['look at both', 'and now?', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, afterFirst, afterSecond, nextTurn] = spawns();
    expect(afterFirst!.contextImages?.map((i) => i.width)).toEqual([640]);
    // Only the new image: the session already holds the first.
    expect(afterSecond!.contextImages?.map((i) => i.width)).toEqual([320]);
    expect(nextTurn!.backendSessionId).toBe(afterSecond!.backendSessionId);
    expect(nextTurn!.contextImages).toBeUndefined();
  });

  // Lumen, PR #708: an adapter that refuses part of what it is offered (the
  // request's media budget, a file gone from disk) must not have the refused
  // images recorded as seen. Before the fix the host marked everything it
  // offered, and a refused image was suppressed for the rest of the session.
  it('an image the backend refused is offered again on the next spawn, not recorded as seen', async () => {
    writeFileSync(join(testCwd, 'second.png'), makePng(320, 240));
    scriptBackend(
      [
        toolCall('view_image', { path: 'shot.png' }),
        toolCall('view_image', { path: 'second.png' }),
        'Seen what arrived.',
        'Next turn.',
      ],
      // The spawn after the second view refuses everything it is offered.
      (offered, spawn) => (spawn === 2 ? [] : offered)
    );
    testState.inputs = ['look at both', 'and now?', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, , refusedSpawn, nextTurn] = spawns();
    expect(refusedSpawn!.contextImages?.map((i) => i.width)).toEqual([320]);
    // Same session, and the refused image is offered again.
    expect(nextTurn!.backendSessionId).toBe(refusedSpawn!.backendSessionId);
    expect(nextTurn!.contextImages?.map((i) => i.width)).toEqual([320]);
  });

  // The other half of Lumen's case: the rejection note says to view the file
  // again, and a re-view hashes to the same ref. Before the fix that ref was
  // already marked seen, so the re-view delivered nothing either.
  it('re-viewing a refused image delivers it once, and then it counts as seen', async () => {
    writeFileSync(join(testCwd, 'second.png'), makePng(320, 240));
    scriptBackend(
      [
        toolCall('view_image', { path: 'shot.png' }),
        toolCall('view_image', { path: 'second.png' }),
        toolCall('view_image', { path: 'second.png' }),
        'Seen now.',
        'Next turn.',
      ],
      (offered, spawn) => (spawn === 2 ? [] : offered)
    );
    testState.inputs = ['look at both', 'and now?', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, , refused, afterReview, nextTurn] = spawns();
    expect(refused!.contextImages?.map((i) => i.width)).toEqual([320]);
    // Two ledger entries now name the same picture; it goes once.
    expect(afterReview!.contextImages?.map((i) => i.width)).toEqual([320]);
    expect(afterReview!.contextImages?.[0]?.ref).toBe(refused!.contextImages?.[0]?.ref);
    // Carried this time, so the next turn has nothing to add.
    expect(nextTurn!.backendSessionId).toBe(afterReview!.backendSessionId);
    expect(nextTurn!.contextImages).toBeUndefined();
  });

  it('a re-seeded session is given every image the ledger still holds', async () => {
    scriptBackend([
      toolCall('view_image', { path: 'shot.png' }),
      // Evict something else: the session rolls, and the image stays on the ledger.
      toolCall('evict_context', { role: 'user' }),
      'Reseeded.',
    ]);
    testState.inputs = ['view it, then drop my message', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, viewed, reseeded] = spawns();
    expect(reseeded!.backendSessionSeedId).toBeDefined();
    expect(reseeded!.backendSessionSeedId).not.toBe(viewed!.backendSessionId);
    expect(reseeded!.contextImages?.map((i) => i.ref)).toEqual(
      viewed!.contextImages!.map((i) => i.ref)
    );
  });

  it('a stateless backend (codex) is given the image on every spawn while it is on the ledger', async () => {
    scriptBackend([toolCall('view_image', { path: 'shot.png' }), 'Seen.', 'Again.']);
    testState.inputs = ['look', 'still there?', '/quit'];
    await runChat({ agent: 'myra', backend: 'codex', toolRouting: 'local', pollSeconds: '999' });

    const [opening, continuation, nextTurn] = spawns();
    expect(opening!.contextImages).toBeUndefined();
    expect(continuation!.prompt).not.toContain(pngBase64Head);
    expect(continuation!.contextImages).toHaveLength(1);
    expect(nextTurn!.contextImages?.map((i) => i.ref)).toEqual(
      continuation!.contextImages!.map((i) => i.ref)
    );
  });

  it('a path outside the allowed roots is refused, and nothing is attached', async () => {
    scriptBackend([toolCall('view_image', { path: '/etc/hosts' }), 'Refused, understood.']);
    testState.inputs = ['look at /etc/hosts', '/quit'];
    await runChat({ agent: 'myra', backend: 'claude', toolRouting: 'local', pollSeconds: '999' });

    const [, continuation] = spawns();
    expect(continuation!.prompt).toContain('outside the directories view_image may open');
    expect(continuation!.contextImages).toBeUndefined();
  });
});
