/** Production wiring, synthetic dependencies: no process, filesystem, keychain, or network IO. */
import { EventEmitter } from 'events';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
  type MockInstance,
} from 'vitest';

// Every imported IO boundary is replaced before SessionService/CodexRunner load.
// Keep the service, repository mapper, token signer/verifier, registry, binding,
// and CodexRunner.run real; stop at the transport seam instead of a provider.
vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'synthetic-native-wiring-key-only', MCP_HTTP_PORT: 1 },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('No process permitted');
  }),
}));
vi.mock('fs', () => ({
  mkdtempSync: vi.fn(() => {
    throw new Error('No filesystem permitted');
  }),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(() => {
    throw new Error('No filesystem permitted');
  }),
}));
vi.mock('fs/promises', () => ({
  access: vi.fn(() => {
    throw new Error('No filesystem permitted');
  }),
  readFile: vi.fn(() => {
    throw new Error('No filesystem permitted');
  }),
  stat: vi.fn(() => {
    throw new Error('No filesystem permitted');
  }),
  mkdir: vi.fn(),
  lstat: vi.fn(),
  mkdtemp: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    throw new Error('No database permitted');
  }),
}));
vi.mock('@inklabs/shared', async () => ({
  ...(await import('../../../../shared/src/errors/classify-error.js')),
  // The runner-credential checks classify the token's scope with these.
  ...(await import('../../../../shared/src/security/token-scope.js')),
  isPathWithinWorkspaceAsync: vi.fn(),
  studioPermissionProfile: vi.fn(),
  buildSessionEnv: vi.fn(() => ({})),
  writeRuntimeSessionHint: vi.fn(),
  resolveSpawnTarget: vi.fn((input) => input),
  CONTAINER_RUNNER_FILES: '/synthetic/container',
}));
vi.mock('./native-steering-log.js', () => ({
  openNativeSteeringLog: vi.fn(async () => ({
    path: '/synthetic/journal',
    append: vi.fn(() => 1),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('./stop-process.js', () => ({
  stopProcessAndWait: vi.fn(async () => ({ exited: true, group: 'empty' })),
  isGroupId: (id: unknown) => typeof id === 'number' && Number.isInteger(id) && id > 1,
  probeGroup: vi.fn(() => 'alive'),
}));
vi.mock('../graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));
vi.mock('./context-builder.js', () => ({
  ContextBuilder: class {},
  formatInjectedContext: vi.fn(() => 'Synthetic context'),
}));
vi.mock('./claude-runner.js', () => ({
  ClaudeRunner: class {},
  buildIdentityPrompt: vi.fn(() => 'Synthetic identity'),
}));
vi.mock('./gemini-runner.js', () => ({ GeminiRunner: class {} }));
vi.mock('./antigravity-runner.js', () => ({ AntigravityRunner: class {} }));
vi.mock('./ink-runner.js', () => ({ InkRunner: class {} }));
vi.mock('./launched-processes.js', () => ({
  launchHoldFor: vi.fn(),
  reserveLaunch: vi.fn(async () => undefined),
}));
vi.mock('./finalize-turn.js', () => ({
  retryTurnFinalization: vi.fn(async () => undefined),
  supersedePendingFinalization: vi.fn(),
  hasPendingFinalizationFor: vi.fn(() => false),
  TurnSupersededError: class extends Error {},
}));
vi.mock('../uploads/runner-media.js', () => ({
  uploadMediaForRunner: vi.fn(() => ({ attachments: [], dropped: [], note: '' })),
  uploadDirsToGrant: vi.fn(() => []),
}));
vi.mock('../uploads/runtime.js', () => ({ uploadsRoot: vi.fn(() => '/synthetic/uploads') }));
vi.mock('./hosted-ink-session.js', () => ({ selectInkRunner: vi.fn() }));
vi.mock('../../data/repositories/activity-stream.repository.js', () => ({
  ActivityStreamRepository: class {},
}));
vi.mock('../task-group-resolver.js', () => ({ resolveTaskGroupForThreadKey: vi.fn() }));
vi.mock('../sandbox/orchestrator.js', () => ({
  getRunnerFilesDir: vi.fn(() => '/synthetic/container'),
}));
vi.mock('../studio-lease.service.js', () => ({
  StudioLeaseService: class {},
  isLeaseStale: vi.fn(),
  leaseThreadKeys: vi.fn(),
}));
vi.mock('../thread-key/thread-key.service.js', () => ({ ThreadKeyService: class {} }));
vi.mock('../studio-overflow.service.js', () => ({ StudioOverflowService: class {} }));
vi.mock('../studio-complete.js', () => ({
  ensureStudioComplete: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
}));
vi.mock('../../data/repositories/studios.repository.js', () => ({ StudiosRepository: class {} }));
vi.mock('../principals.js', () => ({ personalWorkspaceOf: vi.fn(), workspaceOfSb: vi.fn() }));
vi.mock('../inklings/inkling-folder.js', () => ({
  ensureInklingFolder: vi.fn(),
  inklingToolPolicyPath: vi.fn(),
  inklingsRoot: vi.fn(),
}));
vi.mock('../inklings/inkling-turns.js', () => ({ trackInklingTurn: vi.fn() }));
vi.mock('../inklings/inkling-stop-fence.js', () => ({
  INKLING_FENCE_REASON: 'Synthetic fence',
  fenceInkling: vi.fn(),
  inklingFenceHolds: vi.fn(() => false),
}));
vi.mock('../inklings/inkling-runtime.js', () => ({ inklingRuntime: vi.fn() }));
vi.mock('../../config/inkling-flags.js', () => ({
  inklingOwnerTestUserIds: vi.fn(() => new Set()),
  inklingTurnTimeoutMs: vi.fn(),
  isInklingOwnerTestUser: vi.fn(() => false),
}));
vi.mock('../inklings/inkling-service.js', () => ({
  INKLING_CLIENT: 'inkling-mobile',
  isUuid: vi.fn(() => true),
}));
vi.mock('../inklings/inkling-heartbeat.js', () => ({ isOwnersHeartbeat: vi.fn() }));
vi.mock('../studio-paths.js', () => ({
  inkStudiosRoot: vi.fn(() => '/synthetic/studios'),
  ensureInkStudiosRoot: vi.fn(async () => undefined),
}));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn(() => {
    throw new Error('No executable lookup permitted');
  }),
  buildSpawnPath: vi.fn(),
}));
vi.mock('./codex-app-server.js', () => ({
  buildCodexAppServerArgs: vi.fn(() => ['app-server']),
  runOwnedCodexAppServer: vi.fn(),
}));

import { SessionService } from './session-service.js';
import { SessionRepository } from './session-repository.js';
import { CodexRunner } from './codex-runner.js';
import { verifyInkAccessToken } from '../../auth/ink-tokens.js';
import {
  getActiveRun,
  registerActiveRun,
  resetActiveRuns,
  submitRunSteering,
  listOwnedChildren,
  mayGenerationProceed,
  closeIntakeAndDrain,
  stopOwnedChildren,
} from './active-runs.js';
import { runOwnedCodexAppServer } from './codex-app-server.js';
import { spaceTurnIsLive } from '../../mcp/space-turn-liveness';
import { ensureStudioComplete } from '../studio-complete.js';
import { spawn } from 'child_process';
import { resolveBinaryPath } from './resolve-binary.js';
import { releaseGraphClaimsForSession } from '../graph-executor.service';
import { logger } from '../../utils/logger.js';
import { stopProcessAndWait, probeGroup } from './stop-process.js';
import type {
  ChannelResponse,
  ClaudeRunnerConfig,
  IRunner,
  Session,
  SessionRequest,
  SessionResult,
  ToolCall,
} from './types.js';

/** Only the private seams replaced by this wiring fixture, with their inert result shapes. */
interface CodexRunnerTestPorts {
  createIdentityPromptTempFile(
    content: string,
    runtimeDir?: string
  ): {
    promptPath: string;
    containerPath?: string;
    cleanup(): void;
  };
  spawnProcess(
    args: string[],
    config: ClaudeRunnerConfig
  ): Promise<{
    responses: ChannelResponse[];
    toolCalls: ToolCall[];
    sessionId?: string;
    finalTextResponse?: string;
  }>;
}

interface SessionServiceTestPorts {
  releaseLeaseIfSessionTerminal(sessionId: string, expectedTurnEpoch?: string): Promise<void>;
  processMessage(request: SessionRequest, session: Session, epoch: string): Promise<SessionResult>;
}

type Row = Record<string, unknown>;
let row: Row;
let identity: Row;
let seenConfigs: ClaudeRunnerConfig[];
let dbWrites: Row[];
let native: MockedFunction<typeof runOwnedCodexAppServer>;
let legacy: MockInstance<CodexRunnerTestPorts['spawnProcess']>;
let repository: SessionRepository;
let service: SessionService;
let claude: MockedFunction<IRunner['run']>;
const sessionId = 'synthetic-session';
const sbId = '00000000-0000-4000-8000-000000000001';
const userId = 'synthetic-user';
const success = {
  success: true,
  backendSessionId: 'synthetic-thread',
  responses: [],
  finalTextResponse: 'Synthetic response',
};
const request: SessionRequest = {
  userId,
  sbSlug: 'echo',
  channel: 'agent',
  conversationId: 'synthetic-conversation',
  sender: { id: 'synthetic-sender', name: 'Fixture' },
  content: 'Synthetic work.',
  metadata: {},
};

// This deliberately implements only the query operations exercised here.
// Unexpected tables or query shapes fail instead of reaching a real client.
const client = {
  from(table: string) {
    if (table !== 'sessions' && table !== 'agent_identities')
      throw new Error(`Unexpected synthetic table: ${table}`);
    const filters: Array<[string, unknown]> = [];
    let patch: Row | undefined;
    const execute = () => {
      const target = table === 'sessions' ? row : identity;
      if (!filters.every(([key, value]) => target[key] === value)) return [];
      if (patch) {
        Object.assign(target, patch);
        dbWrites.push(structuredClone(patch));
      }
      return [structuredClone(target)];
    };
    const chain = {
      select: (_fields?: string) => chain,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return chain;
      },
      update: (value: Row) => {
        patch = value;
        return chain;
      },
      single: async () => ({ data: execute()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
      then: <T>(resolve: (value: { data: Row[]; error: null }) => T) =>
        Promise.resolve({ data: execute(), error: null }).then(resolve),
    };
    return chain;
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetActiveRuns();
  vi.stubEnv('JWT_SECRET', 'synthetic-native-wiring-key-only');
  vi.stubEnv('INK_EXECUTION_TIER', 'full');
  vi.stubEnv('INK_EXECUTION_TIER_CLIENTS', '');
  vi.stubEnv('INK_EXECUTION_TIER_SBS', '');
  vi.stubEnv('INK_CLAUDE_NATIVE_QUEUE_SB_IDS', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network permitted');
    })
  );
  row = {
    id: sessionId,
    user_id: userId,
    agent_id: 'echo',
    sb_id: sbId,
    contact_id: null,
    cli_attached: false,
    backend: 'codex-cli',
    backend_session_id: 'synthetic-thread',
    lifecycle: 'idle',
    status: 'active',
    metadata: {},
    started_at: '2026-01-01T00:00:00Z',
  };
  identity = { id: sbId, user_id: userId, agent_id: 'echo', metadata: {}, sandbox_bypass: false };
  seenConfigs = [];
  dbWrites = [];
  native = vi.mocked(runOwnedCodexAppServer).mockImplementation(async (input) => {
    const binding = input.config.nativeSteering!;
    expect(binding).toBeDefined();
    binding.assertCurrent();
    expect(row.lifecycle).toBe('running');
    expect(row.turn_epoch).toBe(binding.turnEpoch);
    expect(getActiveRun(sessionId)?.turnEpoch).toBe(binding.turnEpoch);
    seenConfigs.push(input.config);
    const release = binding.bind(async (message) => ({
      messageId: message.messageId,
      status: 'pending',
    }));
    expect(
      await submitRunSteering(sessionId, binding.turnEpoch, {
        messageId: 'synthetic-steer',
        text: 'Revised synthetic work.',
      })
    ).toMatchObject({ status: 'pending' });
    release();
    return success;
  });
  const runner = new CodexRunner();
  const runnerTestPorts = runner as unknown as CodexRunnerTestPorts;
  vi.spyOn(runnerTestPorts, 'createIdentityPromptTempFile').mockReturnValue({
    promptPath: '/synthetic/prompt',
    cleanup: vi.fn(),
  });
  legacy = vi.spyOn(runnerTestPorts, 'spawnProcess').mockImplementation(async (_args, config) => {
    seenConfigs.push(config);
    return {
      responses: [],
      toolCalls: [],
      sessionId: 'synthetic-thread',
      finalTextResponse: 'Synthetic legacy response',
    };
  });
  repository = new SessionRepository(client as never);
  const unusedRunner: IRunner = {
    uploadMedia: 'refuse',
    run: vi.fn(async () => {
      throw new Error('Unexpected backend');
    }),
  };
  const context = {
    agent: { sbSlug: 'echo', name: 'Echo', backend: 'codex', values: [] },
    user: { id: userId, email: 'fixture@example.invalid', timezone: 'America/Los_Angeles' },
  };
  claude = vi.fn(async (_message, options) => {
    seenConfigs.push(options.config);
    options.config.nativeSteering?.assertCurrent();
    return success;
  });
  service = new SessionService(
    repository,
    { buildContext: vi.fn(async () => context) } as never,
    { uploadMedia: 'refuse', run: claude },
    {
      logActivity: vi.fn(async () => ({ id: 'synthetic-activity' })),
      logMessage: vi.fn(async () => ({ id: 'synthetic-message' })),
    },
    {
      defaultWorkingDirectory: '/synthetic/unused',
      mcpConfigPath: '/synthetic/mcp',
      inkMcpUrl: 'http://127.0.0.1:1/mcp',
      compactionEnabled: false,
    },
    runner,
    client as never,
    unusedRunner,
    unusedRunner,
    unusedRunner
  );
  vi.spyOn(
    service as unknown as SessionServiceTestPorts,
    'releaseLeaseIfSessionTerminal'
  ).mockResolvedValue(undefined);
});
afterEach(() => {
  resetActiveRuns();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function run(metadata: Row = {}, epoch = 'synthetic-epoch') {
  const session = (await repository.findById(sessionId))!;
  return (service as unknown as SessionServiceTestPorts).processMessage(
    { ...request, metadata },
    session,
    epoch
  );
}

/** Real protocol/runner, inert child transport: all IO remains replaced above. */
async function realNativeTransport(
  refusal?: { method: string; message: string; close?: boolean },
  killGroup = false
) {
  const implementation =
    await vi.importActual<typeof import('./codex-app-server.js')>('./codex-app-server.js');
  native.mockImplementation((input) =>
    implementation.runOwnedCodexAppServer({
      ...input,
      config: { ...input.config, killProcessGroup: killGroup },
    })
  );
  vi.mocked(resolveBinaryPath).mockResolvedValue('/synthetic/codex');
  const sent: Array<{ id?: number; method: string }> = [];
  const proc = Object.assign(new EventEmitter(), {
    pid: 222222,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(),
      end: vi.fn(),
    }),
    exitCode: null as number | null,
    signalCode: null,
  });
  const receive = (value: unknown) =>
    proc.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  proc.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line);
    sent.push(message);
    if (message.id === undefined) return true;
    if (refusal && message.method === refusal.method) {
      // A concurrent owner changed attachment/lifecycle while our rejected resume ran.
      row.cli_attached = true;
      row.lifecycle = 'idle';
      queueMicrotask(() => {
        receive({ id: message.id, error: { code: -32600, message: refusal.message } });
        if (refusal.close) {
          proc.exitCode = 1;
          proc.emit('exit', 1);
          proc.emit('close', 1);
        }
      });
    } else {
      const result = message.method.startsWith('thread/')
        ? { thread: { id: 'synthetic-thread' } }
        : message.method === 'turn/start'
          ? { turn: { id: 'synthetic-turn' } }
          : {};
      queueMicrotask(() => receive({ id: message.id, result }));
    }
    return true;
  });
  proc.stdin.end.mockImplementation(() => {
    proc.stdin.writableEnded = true;
    queueMicrotask(() => {
      proc.exitCode = 0;
      proc.emit('exit', 0);
      proc.emit('close', 0);
    });
  });
  vi.mocked(spawn).mockReturnValue(proc as never);
  return { proc, receive, sent };
}

describe('production native steering selection', () => {
  it.each(['', 'echo', '00000000-0000-4000-8000-000000000002', '*'])(
    'keeps Claude on its existing transport without exact opt-in: %s',
    async (allowed) => {
      row.backend = 'claude-code';
      vi.stubEnv('INK_CLAUDE_NATIVE_QUEUE_SB_IDS', allowed);
      await run({ nativeSteering: {}, nativeQueueEnabled: true });
      expect(claude).toHaveBeenCalledOnce();
      expect(seenConfigs[0].nativeSteering).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('selects the Claude input queue with the same owner-bound credential', async () => {
    row.backend = 'claude-code';
    vi.stubEnv('INK_CLAUDE_NATIVE_QUEUE_SB_IDS', ` ${sbId} `);
    expect((await run()).success).toBe(true);
    expect(claude).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
    expect(seenConfigs[0].nativeSteering?.turnEpoch).toBe('synthetic-epoch');
    expect(verifyInkAccessToken(seenConfigs[0].inkAccessToken!, 'mcp_access')).toMatchObject({
      sub: userId,
      sbId,
      sbSlug: 'echo',
      sessionId,
      scope: 'mcp:tools',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    'attached',
    'unknown-attachment',
    'contact',
    'missing-metadata',
    'malformed-metadata',
    'wrong-owner',
    'container',
  ])('keeps Claude on its existing transport for %s', async (kind) => {
    row.backend = 'claude-code';
    vi.stubEnv('INK_CLAUDE_NATIVE_QUEUE_SB_IDS', sbId);
    if (kind === 'attached') row.cli_attached = true;
    if (kind === 'unknown-attachment') row.cli_attached = null;
    if (kind === 'contact') row.contact_id = 'synthetic-contact';
    if (kind === 'missing-metadata') identity.metadata = null;
    if (kind === 'malformed-metadata') identity.metadata = [];
    if (kind === 'wrong-owner') identity.user_id = 'synthetic-other-user';
    await run({
      nativeSteering: {},
      executionTier: 'full',
      cliAttached: false,
      identityMetadata: {},
      ...(kind === 'container' ? { sandboxContainerName: 'synthetic-container' } : {}),
    });
    expect(claude).toHaveBeenCalledOnce();
    expect(seenConfigs[0].nativeSteering).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves a real thread/resume owner refusal through finalization, immediate close: %s',
    async (close) => {
      row.message_count = 7;
      const f = await realNativeTransport({
        method: 'thread/resume',
        message: 'thread synthetic-thread already has an active writer. Synthetic private detail.',
        close,
      });
      const result = await run();
      expect(result.success).toBe(false);
      expect(result.classification?.category).toBe('owner_conflict');
      expect(f.sent.map((message) => message.method)).toEqual([
        'initialize',
        'initialized',
        'thread/resume',
      ]);
      expect(legacy).not.toHaveBeenCalled();
      expect(row.message_count).toBe(7);
      expect(row.cli_attached).toBe(true);
      expect(row.lifecycle).toBe('idle');
      for (const write of dbWrites.slice(1)) {
        expect(write).not.toHaveProperty('lifecycle');
        expect(write).not.toHaveProperty('cli_attached');
        expect(write).not.toHaveProperty('message_count');
      }
      expect(releaseGraphClaimsForSession).not.toHaveBeenCalled();
      expect(
        (service as unknown as SessionServiceTestPorts).releaseLeaseIfSessionTerminal
      ).not.toHaveBeenCalled();
      expect(
        JSON.stringify([
          result,
          dbWrites,
          vi.mocked(logger.error).mock.calls,
          vi.mocked(logger.warn).mock.calls,
        ])
      ).not.toContain('Synthetic private detail');
    }
  );

  it.each([
    ['initialize', 'thread synthetic-thread already has an active writer'],
    ['turn/start', 'thread synthetic-thread already has an active writer'],
    ['thread/resume', 'Synthetic initialization failure'],
  ])(
    'does not turn an ambiguous %s error into a pre-acceptance refusal',
    async (method, message) => {
      row.message_count = 7;
      await realNativeTransport({ method, message });
      const result = await run();
      expect(result.success).toBe(false);
      expect(result.classification?.category).not.toBe('owner_conflict');
      expect(row.message_count).toBe(8);
      expect(row.lifecycle).toBe('failed');
      expect(legacy).not.toHaveBeenCalled();
    }
  );

  it.each(['leader', 'group', 'unknown-group'] as const)(
    'holds new native and exec generations after an unconfirmed %s stop until confirmed exit',
    async (kind) => {
      vi.useFakeTimers();
      const grouped = kind !== 'leader';
      const f = await realNativeTransport(undefined, grouped);
      vi.mocked(probeGroup).mockReturnValue(kind === 'unknown-group' ? 'unknown' : 'alive');
      f.proc.stdin.end.mockImplementation(() => {
        f.proc.stdin.writableEnded = true;
      });
      vi.mocked(stopProcessAndWait).mockResolvedValueOnce(
        grouped
          ? { exited: true, group: kind === 'group' ? 'alive' : 'unknown' }
          : { exited: false }
      );
      const running = run();
      await vi.waitFor(() => expect(f.sent.some((m) => m.method === 'turn/start')).toBe(true));
      if (grouped) {
        f.proc.exitCode = 0;
      }
      f.receive({
        method: 'turn/completed',
        params: {
          threadId: 'synthetic-thread',
          turn: { id: 'synthetic-turn', status: 'completed' },
        },
      });
      if (grouped) {
        f.proc.emit('exit', 0);
        f.proc.emit('close', 0);
      }
      await vi.advanceTimersByTimeAsync(501);
      expect((await running).success).toBe(false);
      expect.soft(listOwnedChildren()).toEqual([{ sessionId, turnEpoch: 'synthetic-epoch' }]);
      expect(getActiveRun(sessionId)).toBeUndefined();
      // An accidental launch returns immediately instead of hanging this safety test.
      native.mockImplementationOnce(async () => success);
      if (kind === 'unknown-group') identity.metadata = null; // No legacy escape when native is unsupported.
      expect.soft((await run({}, 'synthetic-epoch-two')).success).toBe(false);
      expect.soft(native).toHaveBeenCalledTimes(1);
      expect.soft(legacy).not.toHaveBeenCalled();
      expect.soft(spawn).toHaveBeenCalledTimes(1);
      expect.soft(mayGenerationProceed(sessionId, 'synthetic-epoch-two')).toBe(false);
      expect.soft(listOwnedChildren()).toHaveLength(1);
      // Retired input is not revived while the survivor is held.
      expect(
        (
          await submitRunSteering(sessionId, 'synthetic-epoch', {
            messageId: 'late',
            text: 'No replay',
          })
        ).status
      ).toBe('refused');
      f.proc.exitCode = 0;
      f.proc.emit('exit', 0);
      f.proc.emit('close', 0);
      vi.mocked(probeGroup).mockReturnValue('empty');
      await vi.advanceTimersByTimeAsync(1100);
      expect(listOwnedChildren()).toEqual([]);
      native.mockImplementation(async () => success);
      identity.metadata = {};
      expect((await run({}, 'synthetic-epoch-three')).success).toBe(true);
      expect(native).toHaveBeenCalledTimes(2);
      expect(legacy).not.toHaveBeenCalled();
    }
  );

  it('exposes the running native child to shutdown drain and confirms its stop', async () => {
    const f = await realNativeTransport();
    const running = run();
    await vi.waitFor(() => expect(f.sent.some((m) => m.method === 'turn/start')).toBe(true));
    const draining = closeIntakeAndDrain();
    const stopped = await stopOwnedChildren(100);
    expect.soft(stopped.confirmed).toEqual([{ sessionId, turnEpoch: 'synthetic-epoch' }]);
    expect.soft(f.proc.stdin.end).toHaveBeenCalledOnce();
    // Keep the broken-head regression bounded without a real process.
    if (!f.proc.stdin.end.mock.calls.length) {
      f.proc.exitCode = 0;
      f.proc.emit('close', 0);
    }
    expect((await running).success).toBe(false);
    expect((await draining).drained).toBe(true);
    expect(listOwnedChildren()).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('mints the real bound credential and selects app-server after owner registration and persistence', async () => {
    expect((await run()).success).toBe(true);
    expect(native).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(verifyInkAccessToken(seenConfigs[0].inkAccessToken!, 'mcp_access')).toMatchObject({
      type: 'mcp_access',
      sub: userId,
      sbId,
      sbSlug: 'echo',
      sessionId,
      scope: 'mcp:tools',
    });
    expect(row.cli_attached).toBe(false);
    expect(row.lifecycle).toBe('idle');
    expect(dbWrites[0]).toMatchObject({ lifecycle: 'running', turn_epoch: 'synthetic-epoch' });
    expect(dbWrites[0]).not.toHaveProperty('cli_attached');
    expect((await repository.findById(sessionId))?.cliAttached).toBe(false);
    expect((await run()).success).toBe(true);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it.each([
    'attached',
    'unknown-attachment',
    'contact',
    'missing-metadata',
    'malformed-metadata',
    'wrong-owner',
  ])('does not let request metadata manufacture authority for %s', async (kind) => {
    if (kind === 'attached') row.cli_attached = true;
    if (kind === 'unknown-attachment') row.cli_attached = null;
    if (kind === 'contact') row.contact_id = 'synthetic-contact';
    if (kind === 'missing-metadata') identity.metadata = null;
    if (kind === 'malformed-metadata') identity.metadata = [];
    if (kind === 'wrong-owner') identity.user_id = 'synthetic-other-user';
    await run({
      nativeSteering: { turnEpoch: 'synthetic-epoch' },
      executionTier: 'full',
      cliAttached: false,
      identityMetadata: {},
    });
    expect(native).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledOnce();
    expect(seenConfigs[0].nativeSteering).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not grow the port when an initially unreadable metadata value changes later', async () => {
    identity.metadata = null;
    vi.mocked(ensureStudioComplete).mockImplementationOnce(async () => {
      identity.metadata = {};
      return { ok: true, complete: true, missing: [] };
    });
    await run();
    expect(native).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledOnce();
  });

  it('refuses tools-only native turns before either provider transport', async () => {
    vi.stubEnv('INK_EXECUTION_TIER', 'tools');
    expect((await run({ executionTier: 'full' })).success).toBe(false);
    expect(native).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps container launches on the existing transport rather than adding native authority', async () => {
    await run({ sandboxContainerName: 'synthetic-container', nativeSteering: {} });
    expect(native).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledOnce();
    expect(seenConfigs[0].nativeSteering).toBeUndefined();
    expect(seenConfigs[0].container?.containerName).toBe('synthetic-container');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not bypass the canonical Inkling gate with ordinary-looking request metadata', async () => {
    identity.metadata = { client: 'inkling-mobile' };
    const result = await run({ identityMetadata: {}, executionTier: 'full', nativeSteering: {} });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INKLING_TURN_REFUSED');
    expect(native).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves credential freshness refusal after preparation without a legacy fallback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(ensureStudioComplete).mockImplementationOnce(async () => {
      // The one-hour credential is still valid for native admission, but is
      // inside the server's final-minute refusal window before spawn.
      vi.setSystemTime(Date.now() + 3_541_000);
      return { ok: true, complete: true, missing: [] };
    });
    const result = await run();
    expect(result.success).toBe(false);
    expect(native).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rechecks credential freshness at the native physical spawn boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await realNativeTransport();
    // If admission regresses, complete the inert fake rather than waiting for
    // the runner's timeout. The no-spawn assertion must be what fails.
    const write = f.proc.stdin.write.getMockImplementation()!;
    f.proc.stdin.write.mockImplementation((line: string) => {
      const result = write(line);
      if (JSON.parse(line).method === 'turn/start')
        queueMicrotask(() =>
          f.receive({
            method: 'turn/completed',
            params: {
              threadId: 'synthetic-thread',
              turn: { id: 'synthetic-turn', status: 'completed' },
            },
          })
        );
      return result;
    });
    vi.mocked(resolveBinaryPath).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 3_541_000);
      return '/synthetic/codex';
    });
    expect((await run()).success).toBe(false);
    expect(native).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([]);
  });

  it('never falls back to exec after an app-server failure', async () => {
    native.mockRejectedValueOnce(new Error('Synthetic app-server failure'));
    expect((await run()).success).toBe(false);
    expect(native).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

// Phase 2 gate 7 (ink://specs/inkling-multi-person-groups): a space-turn
// token works only while its turn runs. Ordinary finalization through the
// real SessionService path settles the row as idle or failed with the same
// turn_epoch and no ended_at, so session state alone would still have
// admitted the token (Lumen, PR #867 review).
describe('a space-turn token across real turn finalization', () => {
  const live = () =>
    spaceTurnIsLive(
      {
        endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
        lifecycle: row.lifecycle as string | undefined,
        turnScope: row.turn_scope as string | undefined,
        turnEpoch: row.turn_epoch as string | undefined,
      },
      { sessionId, turnEpoch: 'synthetic-epoch' }
    );
  /** Even with the generation still registered here, the settled row refuses. */
  const liveIfStillAdmitted = () => {
    registerActiveRun({
      sessionId,
      userId,
      sbSlug: 'echo',
      backend: 'codex-cli',
      startedAt: Date.now(),
      turnEpoch: 'synthetic-epoch',
    });
    try {
      return live();
    } finally {
      resetActiveRuns();
    }
  };

  beforeEach(() => {
    row.turn_scope = 'space-turn';
  });

  // The runner settles before the terminal write; with that write failing,
  // the row stays running at the same epoch and the generation stays
  // registered for finalization. The token still dies with the runner
  // (Lumen, PR #867 round 2).
  it.each([true, false])(
    'refuses a finished runner while its finalization write fails; runner succeeded = %s',
    async (succeeded) => {
      if (!succeeded)
        native.mockImplementationOnce(async () => {
          throw new Error('Synthetic runner failure');
        });
      vi.spyOn(repository, 'updateIfTurnEpoch').mockRejectedValue(
        new Error('Synthetic finalization write failure')
      );
      expect((await run()).success).toBe(succeeded);
      expect(row).toMatchObject({
        lifecycle: 'running',
        turn_epoch: 'synthetic-epoch',
        turn_scope: 'space-turn',
      });
      expect(row.ended_at ?? null).toBeNull();
      expect(getActiveRun(sessionId)).toMatchObject({
        turnEpoch: 'synthetic-epoch',
        runnerSettledAt: expect.any(Number),
        settledOutcome: succeeded ? 'succeeded' : 'failed',
      });
      expect(live()).toBe(false);
    }
  );

  it('is live while the turn runs, and refused once it settles idle', async () => {
    const turn = native.getMockImplementation()!;
    let during: boolean | undefined;
    native.mockImplementationOnce(async (input) => {
      during = live();
      return turn(input);
    });
    expect((await run()).success).toBe(true);
    expect(during).toBe(true);
    expect(row).toMatchObject({ lifecycle: 'idle', turn_epoch: 'synthetic-epoch' });
    expect(row.ended_at ?? null).toBeNull();
    expect(live()).toBe(false);
    expect(liveIfStillAdmitted()).toBe(false);
  });

  it('is live while the turn runs, and refused once it settles failed', async () => {
    let during: boolean | undefined;
    native.mockImplementationOnce(async () => {
      during = live();
      throw new Error('Synthetic app-server failure');
    });
    expect((await run()).success).toBe(false);
    expect(during).toBe(true);
    expect(row).toMatchObject({ lifecycle: 'failed', turn_epoch: 'synthetic-epoch' });
    expect(row.ended_at ?? null).toBeNull();
    expect(live()).toBe(false);
    expect(liveIfStillAdmitted()).toBe(false);
  });
});
