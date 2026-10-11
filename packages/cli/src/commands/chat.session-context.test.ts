import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Set HOME before importing the runtime: configuration readers may capture it
// at module initialization. This also protects ordinary repository test runs.
const isolatedHome = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const previous = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-context-home-'));
  process.env.HOME = home;
  return { home, previous };
});
afterAll(() => {
  if (isolatedHome.previous === undefined) delete process.env.HOME;
  else process.env.HOME = isolatedHome.previous;
  rmSync(isolatedHome.home, { recursive: true, force: true });
});

const state = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  run: vi.fn(),
  context: vi.fn(),
}));

// Import the actual API schema, but do not import its configuration, logger,
// identity/authentication or database effects. No handler is called here.
vi.mock('../../../api/src/utils/logger', () => ({ logger: {} }));
vi.mock('../../../api/src/auth/enforce-identity', () => ({ getEffectiveSlug: vi.fn() }));
vi.mock('../../../api/src/services/user-resolver', () => ({ resolveUserOrThrow: vi.fn() }));
import { getSessionContextSchema } from '../../../api/src/mcp/tools/activity-stream-handlers.js';

// Failure-first: no provider, OS credential store, network or real executor can
// be reached even if a recovery assertion fails. All filesystem writes below
// belong to an isolated test cwd; the runner also starts with an isolated HOME.
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  fork: () => {
    throw new Error('Unexpected process fork');
  },
  spawnSync: () => {
    throw new Error('Unexpected process spawnSync');
  },
  spawn: () => {
    throw new Error('Unexpected process spawn');
  },
  exec: () => {
    throw new Error('Unexpected process exec');
  },
  execSync: () => {
    throw new Error('Unexpected process execSync');
  },
  execFile: () => {
    throw new Error('Unexpected process execFile');
  },
  execFileSync: () => {
    throw new Error('Unexpected process execFileSync');
  },
}));
vi.mock('../backends/identity.js', () => ({
  resolveSlug: () => 'lumen',
  readIdentityJson: () => ({}),
  saveRuntimePreferences: vi.fn(),
}));
vi.mock('../lib/backend-auth.js', () => ({
  ensureBackendAuthReady: async () => true,
  isBackendAuthBackend: () => false,
  getBackendAuthStatus: vi.fn(),
  runBackendInteractiveLogin: vi.fn(),
}));
vi.mock('../repl/credential-resolver.js', () => ({
  loadKeychainCredentials: async () => ({}),
  buildResolverEnv: () => ({}),
  resolveCredentialRefs: (args: unknown) => ({ args, resolutions: [] }),
}));
vi.mock('../lib/ink-client.js', () => ({
  InkClient: class {
    async callTool(tool: string, args: Record<string, unknown> = {}) {
      state.calls.push({ tool, args });
      if (tool === 'get_session_context') {
        getSessionContextSchema.parse(args);
        return state.context();
      }
      if (tool === 'bootstrap') return { user: { timezone: 'America/Los_Angeles' } };
      if (tool === 'get_inbox') return { messages: [] };
      return { success: true };
    }
  },
}));
vi.mock('../repl/backend-runner.js', () => ({
  withholdProviderToolsForThisProcess: vi.fn(),
  runBackendTurn: (request: unknown) => state.run(request),
  startBackendTurn: (request: unknown) => ({ result: state.run(request), abort() {} }),
}));
vi.mock('../repl/skills.js', () => ({ discoverSkills: () => [], loadSkillInstruction: vi.fn() }));
vi.mock('../repl/session-event-stream.js', () => ({ startSessionEventStream: () => () => {} }));
vi.mock('../repl/turn-signal.js', async (original) => ({
  ...(await original<typeof import('../repl/turn-signal.js')>()),
  createTurnSignal: () => ({
    open: async () => true,
    close: async () => true,
    detach: async () => true,
  }),
}));
vi.mock('../repl/ink/index.js', () => ({
  renderInkChat: async () => null,
  renderSessionPicker: async () => null,
  InkExitSignal: class extends Error {},
}));
vi.mock('../repl/pi-tools.js', () => ({
  isPiTool: () => false,
  callPiTool: () => {
    throw new Error('Unexpected local tool');
  },
}));

import { runChat, hydrateLedgerFromTranscript, keptEntriesForCompaction } from './chat.js';
import { ContextLedger } from '../repl/context-ledger.js';
import { SessionLog } from '../session/session-log.js';
import { SESSION_CONTEXT_SOURCE } from '../repl/session-context.js';

const sessionId = '00000000-0000-4000-8000-000000000123';
const records = [
  {
    id: 'synthetic-activity-1',
    type: 'message_in',
    content: 'Remember the fictional amber kite.',
    createdAt: '2026-01-01T00:00:00.000Z',
    platform: 'synthetic',
  },
  {
    id: 'synthetic-activity-2',
    type: 'message_out',
    sbSlug: 'synthetic-helper',
    content: 'The fictional kite is amber.',
    createdAt: '2026-01-01T00:00:01.000Z',
  },
];

describe('ink chat bounded session-context recovery', () => {
  const cwd = process.cwd();
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir =
      process.env.INK_TEST_CONTEXT_PROCESS_DIR ||
      mkdtempSync(join(tmpdir(), 'ink-context-recovery-'));
    process.chdir(dir);
    vi.stubEnv('INK_TOOL_POLICY_PATH', join(dir, 'policy.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected network');
      })
    );
    state.calls = [];
    state.run.mockReset().mockResolvedValue({
      success: true,
      stdout: 'Synthetic reply.',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      command: 'synthetic',
    });
    state.context.mockReset().mockResolvedValue({ success: true, context: records });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.chdir(cwd);
    if (!process.env.INK_TEST_CONTEXT_PROCESS_DIR) rmSync(dir, { recursive: true, force: true });
  });
  const turn = (message: string, backend = 'codex') =>
    runChat({
      agent: 'lumen',
      backend,
      sessionId,
      nonInteractive: true,
      message,
      pollSeconds: '999',
    });
  const transcriptPath = () => {
    const base = join(dir, '.ink', 'runtime', 'repl');
    return join(base, readdirSync(base).find((p) => p.startsWith(sessionId))!);
  };

  it('uses the actual API input contract and carries quoted activity into the first prompt', async () => {
    await turn('What fictional kite?');
    expect(state.context).toHaveBeenCalledOnce(); // Schema validation must reach the response.
    expect(state.calls.find((c) => c.tool === 'get_session_context')?.args).toEqual({
      sessionId,
      limit: 50,
    });
    const prompt = state.run.mock.calls[0][0].prompt;
    expect(prompt).toContain('fictional amber kite');
    expect(prompt).toContain('not a complete conversation');
    expect(prompt).toContain('<untrusted-session-activity>');
    expect(prompt).toContain('synthetic-helper');
    const events = readFileSync(transcriptPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const notes = events.filter(
      (event) => event.type === 'context_note' && event.source === SESSION_CONTEXT_SOURCE
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].activityContext).toEqual({ status: 'loaded', count: 2 });
    expect(events.filter((e) => e.type === 'user')).toHaveLength(1); // Only the actual new turn.
  });

  it('replays the persisted note into a fresh runtime and stateless provider without a second lookup', async () => {
    await turn('First synthetic turn.');
    const path = transcriptPath();
    const firstNote = new ContextLedger();
    const firstReplay = hydrateLedgerFromTranscript(firstNote, path);
    expect(state.run.mock.calls[0][0].prompt).toContain('fictional amber kite');
    state.context.mockRejectedValue(new Error('The next process cannot fetch the old tail.'));
    await turn('Second synthetic turn.');
    expect(state.context).toHaveBeenCalledOnce();
    const nextPrompt = state.run.mock.calls[1][0].prompt;
    expect(nextPrompt).toContain('fictional amber kite');
    expect(nextPrompt).toContain('First synthetic turn.');
    expect(firstReplay.activityContext).toEqual({ status: 'loaded', count: 2 });
    expect(firstNote.listEntries().filter((e) => e.source === SESSION_CONTEXT_SOURCE)).toHaveLength(
      1
    );
    expect(nextPrompt.split('<untrusted-session-activity>')).toHaveLength(2);
    expect(readFileSync(path, 'utf8').split('"source":"ink-session-context"')).toHaveLength(2);
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('synthetic transport failure'))],
    ['MCP failure', () => Promise.resolve({ isError: true, context: [] })],
    ['declared failure', () => Promise.resolve({ success: false, context: [] })],
    ['malformed response', () => Promise.resolve({ success: true })],
    ['malformed row', () => Promise.resolve({ success: true, context: [null] })],
  ])(
    'distinguishes %s from an empty operational tail, including replay',
    async (_name, response) => {
      state.context.mockImplementation(response);
      await turn('Synthetic request.');
      expect(state.run.mock.calls[0][0].prompt).toContain(
        'activity context unavailable; prior history is unknown'
      );
      const replay = new ContextLedger();
      expect(hydrateLedgerFromTranscript(replay, transcriptPath()).activityContext?.status).toBe(
        'unavailable'
      );
      expect(replay.listEntries().some((e) => e.content.includes('prior history is unknown'))).toBe(
        true
      );
      expect(log.mock.calls.flat().join('\n')).not.toContain('no entries returned');
    }
  );

  it('does not run a provider if persisting recovery context fails', async () => {
    const failure = vi
      .spyOn(SessionLog.prototype, 'flush')
      .mockRejectedValueOnce(new Error('synthetic disk failure'));
    try {
      await expect(turn('Synthetic request.')).rejects.toThrow('synthetic disk failure');
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      failure.mockRestore();
    }
  });

  it('reports an empty successful lookup without claiming the conversation was empty', async () => {
    state.context.mockResolvedValue({ success: true, context: [] });
    await turn('Synthetic request.');
    expect(state.run.mock.calls[0][0].prompt).toContain(
      'no entries returned; this does not establish empty history'
    );
  });

  it.each(['codex', 'claude'])(
    'persists a visible oversized-tail refusal and reopens %s without retry or partial records',
    async (backend) => {
      state.context.mockResolvedValue({
        success: true,
        context: [...records, { type: 'message_in', content: 'x'.repeat(256 * 1024) }],
      });
      await turn('Oversized recovery fixture turn.', backend);
      const path = transcriptPath();
      const ledger = new ContextLedger();
      const hydrated = hydrateLedgerFromTranscript(ledger, path);
      expect(hydrated.activityContext).toEqual({
        status: 'unavailable',
        count: 0,
        reason: 'size_limit',
      });
      const notes = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => {
          const event = JSON.parse(line);
          return event.type === 'context_note' && event.source === SESSION_CONTEXT_SOURCE;
        });
      expect(notes).toHaveLength(1);
      expect(new TextEncoder().encode(notes[0] + '\n').byteLength).toBeLessThan(1024);
      expect(notes[0]).not.toContain('fictional amber kite');

      if (backend === 'claude') {
        const writer = new SessionLog({ path });
        writer.seed(hydrated.maxEid);
        writer.append({
          type: 'backend_session_invalidated',
          reason: 'synthetic-size-refusal-reseed',
        });
        await writer.flush();
        expect(state.run.mock.calls[0][0].backendSessionSeedId).toEqual(expect.any(String));
      }
      state.context.mockRejectedValue(new Error('No retry after the original refusal.'));
      await turn('Reopen oversized recovery fixture.', backend);
      if (backend === 'claude') {
        const request = state.run.mock.calls[1][0];
        expect(request.backendSessionId).toBeUndefined();
        expect(request.backendSessionSeedId).toEqual(expect.any(String));
        expect(request.backendSessionSeedId).not.toBe(
          state.run.mock.calls[0][0].backendSessionSeedId
        );
      }
      expect(state.context).toHaveBeenCalledOnce();
      for (const [request] of state.run.mock.calls) {
        expect(request.prompt).toContain('exceeded the 256 KiB recovery budget');
        expect(request.prompt).toContain('no activity records imported');
        expect(request.prompt).toContain('prior history is unknown');
        expect(request.prompt).not.toContain('fictional amber kite');
        expect(request.prompt).not.toContain('<untrusted-session-activity>');
      }
      expect(log.mock.calls.flat().join('\n')).toContain(
        'original recovery: activity context unavailable: operational tail exceeded the 256 KiB recovery budget'
      );
      const replayed = readFileSync(path, 'utf8');
      expect(replayed.split('"source":"ink-session-context"')).toHaveLength(2);
      expect(replayed).not.toContain('fictional amber kite');
    }
  );

  it('reseeds a provider from the persisted note after an explicit native-session invalidation', async () => {
    await turn('First native fixture turn.', 'claude');
    const initial = state.run.mock.calls[0][0];
    const initialSeed = initial.backendSessionSeedId;
    expect(initialSeed).toEqual(expect.any(String));
    expect(initialSeed.length).toBeGreaterThan(0);
    expect(initial.backendSessionId).toBeUndefined();
    state.context.mockRejectedValue(new Error('No second import.'));

    // Positive control: the persisted seed really is eligible for native
    // resume before the invalidation, rather than this harness always reseeding.
    await turn('Resume control fixture turn.', 'claude');
    const control = state.run.mock.calls[1][0];
    expect(control.backendSessionId).toBe(initialSeed);
    expect(control.backendSessionSeedId).toBeUndefined();

    const path = transcriptPath();
    const ledger = new ContextLedger();
    const hydrated = hydrateLedgerFromTranscript(ledger, path);
    const writer = new SessionLog({ path });
    writer.seed(hydrated.maxEid);
    writer.append({ type: 'backend_session_invalidated', reason: 'synthetic-reseed' });
    await writer.flush();
    await turn('Reseed fixture turn.', 'claude');
    const request = state.run.mock.calls[2][0];
    expect(request.backendSessionId).toBeUndefined();
    expect(request.backendSessionSeedId).toEqual(expect.any(String));
    expect(request.backendSessionSeedId.length).toBeGreaterThan(0);
    expect(request.backendSessionSeedId).not.toBe(initialSeed);
    expect(request.prompt).toContain('fictional amber kite');
    expect(request.prompt.split('<untrusted-session-activity>')).toHaveLength(2);
    expect(state.context).toHaveBeenCalledOnce();
  });

  it('recovers the activity note in a second OS process with no server lookup', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const config = join(dir, 'process-vitest.config.mjs');
    const home = join(dir, 'home');
    const temp = join(dir, 'tmp');
    mkdirSync(home);
    mkdirSync(temp);
    writeFileSync(
      config,
      'export default ' +
        JSON.stringify({
          root,
          cacheDir: join(dir, 'vite-cache'),
          resolve: {
            alias: {
              '@inklabs/shared/runtime': join(root, 'packages/shared/src/runtime/index.ts'),
              '@inklabs/shared': join(root, 'packages/shared/src/index.ts'),
            },
          },
          test: {
            include: ['packages/cli/src/commands/chat.session-context.test.ts'],
            fileParallelism: false,
          },
        })
    );
    // The only real child processes in this test are two isolated Node/Vitest
    // runs of the inert fixture below. The fixture still mocks every provider,
    // process executor and keychain operation, and rejects all network calls.
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    for (const stage of ['seed', 'replay']) {
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          config,
          '-t',
          'isolated process fixture',
        ],
        {
          cwd: root,
          env: {
            HOME: home,
            TMPDIR: temp,
            NODE_ENV: 'test',
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            INK_TEST_CONTEXT_PROCESS_DIR: dir,
            INK_TEST_CONTEXT_PROCESS_STAGE: stage,
          },
          timeout: 30_000,
          stdio: 'pipe',
        }
      );
    }
    const seed = JSON.parse(readFileSync(join(dir, 'seed-result.json'), 'utf8'));
    const replay = JSON.parse(readFileSync(join(dir, 'replay-result.json'), 'utf8'));
    expect(seed.pid).not.toBe(replay.pid);
    expect(seed.pid).not.toBe(process.pid);
    expect(replay.pid).not.toBe(process.pid);
    expect(replay.contextCalls).toBe(0);
  }, 60_000);

  it.skipIf(!process.env.INK_TEST_CONTEXT_PROCESS_STAGE)('isolated process fixture', async () => {
    const replay = process.env.INK_TEST_CONTEXT_PROCESS_STAGE === 'replay';
    if (replay)
      state.context.mockRejectedValue(new Error('No old activity available in this process.'));
    await turn(replay ? 'Process two synthetic request.' : 'Process one synthetic request.');
    const prompt = state.run.mock.calls[0][0].prompt;
    expect(prompt).toContain('fictional amber kite');
    expect(prompt.split('<untrusted-session-activity>')).toHaveLength(2);
    if (replay) {
      expect(state.context).not.toHaveBeenCalled();
      expect(prompt).toContain('Process one synthetic request.');
    } else expect(state.context).toHaveBeenCalledOnce();
    writeFileSync(
      join(dir, `${process.env.INK_TEST_CONTEXT_PROCESS_STAGE}-result.json`),
      JSON.stringify({ pid: process.pid, contextCalls: state.context.mock.calls.length })
    );
  });

  it('keeps the note and boundary in a compaction kept tail, and honors later eviction', async () => {
    await turn('Synthetic request.');
    const path = transcriptPath();
    const ledger = new ContextLedger();
    const hydrated = hydrateLedgerFromTranscript(ledger, path);
    const note = ledger.listEntries().find((e) => e.source === SESSION_CONTEXT_SOURCE)!;
    const writer = new SessionLog({ path });
    writer.seed(hydrated.maxEid);
    const compacted = new ContextLedger();
    compacted.addEntry('system', 'Synthetic summary.', 'compaction');
    compacted.addEntry(note.role, note.content, note.source, note.eid);
    writer.append({
      type: 'compaction',
      summary: 'Synthetic summary.',
      keptEntries: keptEntriesForCompaction(compacted),
      summaryIndex: 0,
    });
    const replay = new ContextLedger();
    hydrateLedgerFromTranscript(replay, path);
    expect(
      replay
        .listEntries()
        .filter((e) => e.source === SESSION_CONTEXT_SOURCE)
        .map((e) => e.content)
    ).toEqual([note.content]);
    writer.append({ type: 'context_evict', refs: [{ eid: note.eid }] });
    const evicted = new ContextLedger();
    hydrateLedgerFromTranscript(evicted, path);
    expect(evicted.listEntries().some((e) => e.source === SESSION_CONTEXT_SOURCE)).toBe(false);
  });
});
