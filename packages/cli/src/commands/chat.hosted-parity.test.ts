/** Script both actual compositions, not two copies of an expected event list. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  composeInkSession,
  createSessionToolHost,
  type SessionCompositionPorts,
  type CodingTool,
} from '@inklabs/shared/node-host';
import { SessionLog, ToolPolicyState, applyLaunchProfile } from '@inklabs/shared/runtime';
import type { BackendHost, BackendRunRequest, BackendRunResult } from '@inklabs/shared/providers';
const fixture = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  replies: [] as BackendRunResult[],
  loadSecrets: vi.fn(async () => ({ FIXTURE_SECRET: 'private-fixture-secret' })),
}));
const callInk = async (name: string, args: Record<string, unknown> = {}) => {
  fixture.calls.push({ name, args });
  if (name === 'bootstrap')
    return { user: { timezone: 'America/Los_Angeles' }, identityFiles: { soul: 'Parity fixture' } };
  if (name === 'recall') return { success: true, memories: [] };
  if (name === 'list_sessions') return { sessions: [] };
  return { success: true };
};
const start = (request: BackendRunRequest) => ({
  abort: () => {},
  result: Promise.resolve().then(() => {
    const next = fixture.replies.shift();
    if (!next) throw new Error('Unscripted provider');
    request.onEvent?.({ kind: 'text', text: next.stdout });
    return next;
  }),
});
vi.mock('../backends/identity.js', async (original) => ({
  ...(await original<typeof import('../backends/identity.js')>()),
  resolveSlug: () => 'echo',
  readIdentityJson: () => ({ studioId: 'fixture-studio' }),
}));
vi.mock('../lib/ink-client.js', () => ({
  InkClient: class {
    callTool(name: string, args: Record<string, unknown>) {
      return callInk(name, args);
    }
  },
}));
vi.mock('../repl/backend-runner.js', () => ({
  withholdProviderToolsForThisProcess: () => {},
  startBackendTurn: (request: BackendRunRequest) => start(request),
  runBackendTurn: (request: BackendRunRequest) => start(request).result,
}));
vi.mock('../repl/credential-resolver.js', async (original) => ({
  ...(await original<typeof import('../repl/credential-resolver.js')>()),
  loadKeychainCredentials: () => fixture.loadSecrets(),
}));
vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
  loadSkillInstruction: () => undefined,
}));
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
  InkExitSignal: class extends Error {},
}));
import { runChat } from './chat.js';

const tool = (name: string, args: Record<string, unknown>) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const reply = (stdout: string, failure = false): BackendRunResult => ({
  success: !failure,
  stdout,
  responseText: stdout,
  stderr: failure ? 'Authentication failed: invalid API key' : '',
  exitCode: failure ? 1 : 0,
  durationMs: 1,
  command: 'scripted fixture',
  childExited: true,
  usage: { backend: 'claude', source: 'json', inputTokens: 20, outputTokens: 2 },
});
function semanticEvents(events: Record<string, unknown>[]) {
  // Host lifecycle/presentation differs. Compare all shared dialogue/effect
  // events, normalizing only timestamps and independently minted identifiers.
  return events
    .filter((e) => ['user', 'assistant', 'tool_intent', 'local_tool_call'].includes(String(e.type)))
    .map((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([k]) => !['ts', 'eid', 'invocationId', 'durationMs'].includes(k))
      )
    );
}
function effectCalls(calls: typeof fixture.calls) {
  return calls.filter((c) =>
    ['bootstrap', 'recall', 'send_to_inbox', 'log_activity'].includes(c.name)
  );
}

describe('CLI and hosted composition parity', () => {
  const cwd = process.cwd();
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-host-parity-')));
    mkdirSync(join(root, 'home'));
    process.chdir(root);
    vi.stubEnv('INK_TOOL_POLICY_PATH', join(root, 'policy.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected real network');
      })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.calls = [];
    fixture.replies = [];
    fixture.loadSecrets.mockClear();
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  it.each(['read', 'auth-failure', 'tools-secret'] as const)(
    '%s has the same ledger and activity/tool calls',
    async (scenario) => {
      const profile = scenario === 'tools-secret' ? 'tools' : 'safe';
      const message = 'Run the fixture';
      const script =
        scenario === 'auth-failure'
          ? [reply('', true)]
          : scenario === 'read'
            ? [reply(tool('read', { path: 'fixture.txt' })), reply('Fixture read.')]
            : [
                reply(
                  tool('send_to_inbox', {
                    recipientSlug: 'fixture-recipient',
                    content: '$FIXTURE_SECRET',
                  })
                ),
                reply('Sent literal.'),
              ];
      writeFileSync(join(root, 'fixture.txt'), 'harmless fixture');
      fixture.replies = [...script];
      await runChat({
        agent: 'echo',
        backend: 'claude',
        model: 'fixture-model',
        sessionId: 'fixture-session',
        nonInteractive: true,
        message,
        maxTurns: '1',
        toolRouting: 'local',
        profile,
        pollSeconds: '999',
      });
      expect(fixture.replies).toEqual([]);
      const dir = join(root, '.ink', 'runtime', 'repl');
      const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
      const cliEvents = readFileSync(join(dir, file), 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      const cliCalls = [...fixture.calls];
      if (profile === 'tools') {
        expect(fixture.loadSecrets).not.toHaveBeenCalled();
        expect(cliCalls.find((c) => c.name === 'send_to_inbox')?.args.content).toBe(
          '$FIXTURE_SECRET'
        );
      }
      fixture.calls = [];
      fixture.replies = [...script];
      const events: Record<string, unknown>[] = [];
      const log = new SessionLog({
        path: join(root, 'hosted.jsonl'),
        sink: {
          write: async (line) => {
            events.push(JSON.parse(line));
          },
        },
      });
      const policy = new ToolPolicyState('backend');
      applyLaunchProfile(policy, profile);
      const pi = await import('@mariozechner/pi-coding-agent');
      const toolHost = createSessionToolHost({
        cwd: root,
        home: join(root, 'home'),
        tempDir: root,
        imageRoots: [root],
        credentials: {},
        coding: {
          load: async (path) =>
            new Map([['read', pi.createReadTool(path) as unknown as CodingTool]]),
          readDocument: async () => null,
        },
      });
      const noop = () => {};
      const ports: SessionCompositionPorts = {
        sbSlug: 'echo',
        cwd: root,
        cliAttached: false,
        contextBudgetAuto: false,
        history: [],
        log,
        policy,
        toolHost,
        runtime: {
          sessionId: 'fixture-session',
          studioId: 'fixture-studio',
          backend: 'claude',
          model: 'fixture-model',
          backendTokenWindow: 200_000,
          maxContextTokens: 100_000,
          verbose: false,
          strictTools: true,
          toolMode: policy.getMode(),
          toolRouting: 'local',
          activeSkills: [],
          userTimezone: 'UTC',
        },
        callInk,
        logActivity: async (activity) => {
          await callInk('log_activity', activity);
        },
        prepareHost: async () => {},
        unavailable: (reason) => {
          throw new Error(reason);
        },
        mintId: () => `fixture-${events.length}`,
        startTurn: start,
        spawnContext: () => ({
          workingDirectory: root,
          inkSessionId: 'fixture-session',
          studioId: 'fixture-studio',
          host: {} as BackendHost,
        }),
        cloneLog: (path) => new SessionLog({ path, sink: { write: async () => {} } }),
        approve: async () => false,
        approveClone: async () => false,
        presentation: {
          ui: { printLine: noop, printEvent: noop, startWaiting: () => noop },
          render: noop,
          progress: noop,
          toolStarted: noop,
          modelReported: noop,
          toolResult: noop,
          compacted: noop,
          notice: noop,
        },
      };
      const hosted = await composeInkSession(ports);
      try {
        await hosted.run({ raw: message, source: 'user' }, { continueOnFailure: true });
        await log.flush();
        expect(fixture.replies).toEqual([]);
        expect(semanticEvents(events)).toEqual(semanticEvents(cliEvents));
        expect(effectCalls(fixture.calls)).toEqual(effectCalls(cliCalls));
        const activities = fixture.calls.filter((c) => c.name === 'log_activity');
        expect(activities).toHaveLength(1); // never one per provider continuation
        expect(activities[0].args.status).toBe(
          scenario === 'auth-failure' ? 'failed' : 'completed'
        );
        if (scenario === 'auth-failure')
          expect(activities[0].args.payload).toMatchObject({
            errorCategory: 'auth',
            retryable: false,
            stderr: 'Authentication failed: invalid API key',
          });
      } finally {
        await hosted.clones.drain();
        await toolHost.close();
      }
    }
  );
});
