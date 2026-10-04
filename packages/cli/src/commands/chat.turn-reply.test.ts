/**
 * A spawned `ink chat` reports each outer turn's reply as the turn ends.
 *
 * One process runs several outer turns: the delivered message, then
 * continuation prompts until the SB signals. The result line carries only the
 * last turn's text, so a reply written as turn-1 text was replaced by later
 * turns and never forwarded (task 0eb376e5: Myra's reply to a Telegram
 * message, 2026-10-03). The server now forwards each `turn_reply` line as it
 * arrives.
 *
 * These run the real runChat with a scripted backend, one reply per outer turn.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// This file's own HOME, set before any module computes a path from it. A
// write that escapes the per-test paths lands here, where afterEach sees it,
// instead of in the developer's real ~/.ink.
const sentinel = await vi.hoisted(async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-chat-turn-reply-home-'));
  process.env.HOME = home;
  return { home, originalHome };
});

const testState = vi.hoisted(() => ({
  callToolImpl: vi.fn(),
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
    public async callTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return testState.callToolImpl(tool, args);
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

// The turn marker is a direct fetch outside InkClient; unmocked it would post
// to whatever server this machine's config names. The gate decision stays real.
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

import { runChat } from './chat.js';

const reply = (stdout: string) => ({
  success: true,
  stdout,
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  command: 'mock',
});

/** One backend reply per outer turn; the last turn ends on a tool call. */
const SCRIPTED_TURNS = [
  'Here is your answer, written as text.',
  'Still working; nothing new for you.',
  '```ink-tool\n{"tool":"signal_status","args":{"status":"completed","reason":"done"}}\n```',
];

const FORWARDED_NOTE = 'sent to the user as a message';

describe('spawned ink chat: per-turn replies', () => {
  const originalCwd = process.cwd();
  let testCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-27T00:00:00.000Z'));
    testState.callToolImpl.mockReset();
    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'start_session':
          return { session: { id: 'sess-1' } };
        case 'get_inbox':
          return { success: true, messages: [] };
        default:
          return { success: true };
      }
    });
    testState.runBackendImpl.mockReset();
    let call = 0;
    testState.runBackendImpl.mockImplementation(async () => {
      const stdout = SCRIPTED_TURNS[Math.min(call, SCRIPTED_TURNS.length - 1)]!;
      call += 1;
      return reply(stdout);
    });
    testCwd = mkdtempSync(join(tmpdir(), 'ink-chat-turn-reply-'));
    process.chdir(testCwd);
    vi.stubEnv('INK_TOOL_POLICY_PATH', join(testCwd, 'tool-policy.json'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(testCwd, { recursive: true, force: true });
    // Cleared before the assertion, so a leak is charged to the test that
    // made it and not to every test after.
    const inkHome = join(sentinel.home, '.ink');
    const leaked = existsSync(inkHome) ? readdirSync(inkHome, { recursive: true }) : [];
    rmSync(inkHome, { recursive: true, force: true });
    expect(leaked).toEqual([]);
  });

  afterAll(() => {
    if (sentinel.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = sentinel.originalHome;
    rmSync(sentinel.home, { recursive: true, force: true });
  });

  const runThreeTurns = () =>
    runChat({
      agent: 'myra',
      backend: 'claude',
      nonInteractive: true,
      message: 'a message from the channel',
      messageLabel: 'telegram',
      maxTurns: '3',
      pollSeconds: '999',
    });

  const jsonLines = (): Array<Record<string, unknown>> =>
    (logSpy.mock.calls as unknown[][])
      .map((args) => String(args[0] ?? ''))
      .filter((line) => line.trim().startsWith('{'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

  const prompts = () =>
    testState.runBackendImpl.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);

  it('prints one turn_reply per outer turn, each before the result line', async () => {
    await runThreeTurns();

    const lines = jsonLines();
    const replies = lines.filter((line) => line.type === 'turn_reply');
    expect(replies).toEqual([
      {
        type: 'turn_reply',
        turn: 1,
        label: 'telegram',
        text: 'Here is your answer, written as text.',
      },
      {
        type: 'turn_reply',
        turn: 2,
        label: 'continuation',
        text: 'Still working; nothing new for you.',
      },
      // Ended on a tool call: the placeholder the loop stores is not a reply.
      { type: 'turn_reply', turn: 3, label: 'continuation', text: null },
    ]);

    const result = lines.find((line) => line.type === 'result');
    expect(result?.turnsCompleted).toBe(3);
    expect(lines.indexOf(result!)).toBeGreaterThan(lines.indexOf(replies[2]!));
  });

  /**
   * A failed backend's text is whatever it printed before failing. The server
   * never forwarded a failed run's text, and a failed turn's is no different.
   */
  it('reports no reply for a turn whose backend failed', async () => {
    let call = 0;
    testState.runBackendImpl.mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        return { ...reply('partial output before the failure'), success: false, exitCode: 1 };
      }
      return reply(call === 1 ? 'turn one reply' : SCRIPTED_TURNS[2]!);
    });
    await runThreeTurns();

    const replies = jsonLines().filter((line) => line.type === 'turn_reply');
    expect(replies[0]).toMatchObject({ turn: 1, text: 'turn one reply' });
    expect(replies[1]).toMatchObject({ turn: 2, text: null });
    expect(JSON.stringify(replies)).not.toContain('partial output');
  });

  it('tells continuation turns their text reaches the user only when the server forwards it', async () => {
    await runThreeTurns();
    expect(prompts()[1]).toContain('Continue working.');
    expect(prompts()[1]).not.toContain(FORWARDED_NOTE);
  });

  it('with forwarding on, continuation prompts carry the note and turn 1 does not', async () => {
    vi.stubEnv('INK_TURN_REPLIES_FORWARDED', '1');
    await runThreeTurns();
    expect(prompts()[1]).toContain(FORWARDED_NOTE);
    expect(prompts()[2]).toContain(FORWARDED_NOTE);
    // Turn 1 is the delivered message, whose own prompt already says how
    // replies are routed; the note is for continuations.
    expect(prompts()[0]).not.toContain(FORWARDED_NOTE);
  });
});
