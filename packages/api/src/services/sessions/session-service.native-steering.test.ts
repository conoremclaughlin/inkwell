/** Production wiring, synthetic dependencies: no process, filesystem, keychain, or network IO. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@inklabs/shared', () => ({
  classifyError: vi.fn(() => ({
    category: 'unknown',
    summary: 'Synthetic failure',
    retryable: false,
  })),
  isPathWithinWorkspaceAsync: vi.fn(),
  isPreAcceptanceRefusal: vi.fn(() => false),
  studioPermissionProfile: vi.fn(),
  buildSessionEnv: vi.fn(),
  writeRuntimeSessionHint: vi.fn(),
  resolveSpawnTarget: vi.fn(),
  CONTAINER_RUNNER_FILES: '/synthetic/container',
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
vi.mock('../studio-complete.js', () => ({ ensureStudioComplete: vi.fn(async () => undefined) }));
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
import { getActiveRun, resetActiveRuns, submitRunSteering } from './active-runs.js';
import { runOwnedCodexAppServer } from './codex-app-server.js';
import { ensureStudioComplete } from '../studio-complete.js';
import { spawn } from 'child_process';
import type { ClaudeRunnerConfig, Session, SessionRequest, SessionResult } from './types.js';

type Row = Record<string, unknown>;
let row: Row;
let identity: Row;
let seenConfigs: ClaudeRunnerConfig[];
let dbWrites: Row[];
let native: ReturnType<typeof vi.mocked<typeof runOwnedCodexAppServer>>;
let legacy: ReturnType<typeof vi.spyOn>;
let repository: SessionRepository;
let service: SessionService;
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
  vi.spyOn(runner as never, 'createIdentityPromptTempFile' as never).mockReturnValue({
    promptPath: '/synthetic/prompt',
    cleanup: vi.fn(),
  } as never);
  legacy = vi
    .spyOn(runner as never, 'spawnProcess' as never)
    .mockImplementation(async (_args: unknown, config: ClaudeRunnerConfig) => {
      seenConfigs.push(config);
      return {
        responses: [],
        sessionId: 'synthetic-thread',
        finalTextResponse: 'Synthetic legacy response',
      };
    });
  repository = new SessionRepository(client as never);
  const unusedRunner = {
    run: vi.fn(async () => {
      throw new Error('Unexpected backend');
    }),
  };
  const context = {
    agent: { sbSlug: 'echo', name: 'Echo', backend: 'codex', values: [] },
    user: { id: userId, email: 'fixture@example.invalid', timezone: 'America/Los_Angeles' },
  };
  service = new SessionService(
    repository,
    { buildContext: vi.fn(async () => context) } as never,
    unusedRunner,
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
  vi.spyOn(service as never, 'releaseLeaseIfSessionTerminal' as never).mockResolvedValue(
    undefined as never
  );
});
afterEach(() => {
  resetActiveRuns();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function run(metadata: Row = {}) {
  const session = (await repository.findById(sessionId))!;
  return (
    service as unknown as {
      processMessage(
        request: SessionRequest,
        session: Session,
        epoch: string
      ): Promise<SessionResult>;
    }
  ).processMessage({ ...request, metadata }, session, 'synthetic-epoch');
}

describe('production native steering selection', () => {
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

  it('never falls back to exec after an app-server failure', async () => {
    native.mockRejectedValueOnce(new Error('Synthetic app-server failure'));
    expect((await run()).success).toBe(false);
    expect(native).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
