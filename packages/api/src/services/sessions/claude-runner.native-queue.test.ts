/** Real runner and mailbox, inert transport. No child, filesystem, database or provider IO. */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeSteeringBinding } from './native-steering-binding.js';
import type { ClaudeRunnerConfig } from './types.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn(async () => '/synthetic/claude'),
  buildSpawnPath: () => '/synthetic/bin',
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./context-builder.js', () => ({ formatInjectedContext: () => 'Synthetic context' }));
vi.mock('../studio-paths.js', () => ({
  ensureInkStudiosRoot: vi.fn(async () => {}),
  inkStudiosRoot: () => '/synthetic/studios',
}));
vi.mock('../studio-settings.js', () => ({ applyPermissionOverlay: vi.fn(async () => null) }));
vi.mock('./launch-settings.js', () => ({
  prepareLaunchSettings: vi.fn(),
  readMcpServerNames: vi.fn(),
}));
vi.mock('../uploads/runner-media.js', () => ({ uploadMediaForRunner: () => ({ grantDirs: [] }) }));
vi.mock('../uploads/runtime.js', () => ({ uploadsRoot: () => '/synthetic/uploads' }));
vi.mock('./spawn-permission-warning.js', () => ({ warnBeforeClaudeSpawn: vi.fn() }));
vi.mock('@inklabs/shared/providers', () => ({
  PARENT_OWNED_TURN_ENV: { INK_TURN_OWNER: 'parent' },
}));
vi.mock('@inklabs/shared', () => ({
  injectSessionHeaders: () => null,
  buildSessionEnv: () => ({ INK_CONTEXT: 'synthetic-headless-context' }),
  writeRuntimeSessionHint: vi.fn(),
  resolveSpawnTarget: (target: unknown) => target,
  PRINT_MODE_CHANNEL_ENV: { INK_PRINT_MODE: '1' },
  CONTAINER_RUNNER_FILES: '/synthetic/container',
}));
vi.mock('./stop-process.js', () => ({
  stopProcessAndWait: vi.fn(),
  probeGroup: vi.fn(() => 'empty'),
  isGroupId: (pid: number) => pid > 1,
}));

import { spawn } from 'child_process';
import { stopProcessAndWait, probeGroup } from './stop-process.js';
import { applyPermissionOverlay } from '../studio-settings.js';
import { prepareLaunchSettings } from './launch-settings.js';
import { ClaudeRunner } from './claude-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeGroup).mockReturnValue('empty');
});
afterEach(() => vi.useRealTimers());

async function fixture(overrides: Partial<ClaudeRunnerConfig> = {}) {
  const writes: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), {
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
  child.stdin.write.mockImplementation((line: string) => {
    writes.push(JSON.parse(line));
    return true;
  });
  const close = (code = 0) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  child.stdin.end.mockImplementation(() => {
    child.stdin.writableEnded = true;
    queueMicrotask(() => close());
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  vi.mocked(stopProcessAndWait).mockImplementation(async () => {
    close();
    return { exited: true, group: 'empty' };
  });
  let enqueue!: Parameters<NativeSteeringBinding['bind']>[0];
  const releaseChild = vi.fn();
  const releasePort = vi.fn();
  let eid = 0;
  const log = {
    append: vi.fn(() => ++eid),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const binding: NativeSteeringBinding = {
    turnEpoch: 'synthetic-epoch',
    assertCurrent: vi.fn(),
    ownChild: vi.fn(() => ({
      sessionId: 'synthetic-session',
      turnEpoch: 'synthetic-epoch',
      release: releaseChild,
    })),
    openLog: vi.fn(async () => log as never),
    bind: vi.fn((submit) => {
      enqueue = submit;
      return releasePort;
    }),
  };
  const config: ClaudeRunnerConfig = {
    workingDirectory: '/synthetic/studio',
    mcpConfigPath: '',
    nativeSteering: binding,
    ...overrides,
  };
  const running = new ClaudeRunner().run('Synthetic original', { config });
  await vi.waitFor(() => expect(writes).toHaveLength(2));
  const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
  const nativeId = argv[argv.indexOf('--session-id') + 1];
  const receive = (frame: Record<string, unknown>) =>
    child.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ session_id: nativeId, ...frame }) + '\n')
    );
  const init = () =>
    receive({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] });
  const original = writes[1].uuid as string;
  const complete = (uuid: string) =>
    receive({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
  const result = (
    ids: string[],
    text: string,
    input = 10,
    cumulative = { inputTokens: input, outputTokens: 2, costUSD: 0.1 }
  ) =>
    receive({
      type: 'result',
      subtype: 'success',
      result: text,
      user_message_uuids: ids,
      usage: { input_tokens: input, output_tokens: 2 },
      modelUsage: {
        'synthetic-model': {
          ...cumulative,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
  const steer = () => enqueue({ messageId: 'correction', text: 'Synthetic correction' });
  return {
    child,
    writes,
    argv,
    running,
    receive,
    init,
    original,
    complete,
    result,
    steer,
    binding,
    log,
    releaseChild,
    releasePort,
    close,
  };
}

describe('ClaudeRunner native queue integration', () => {
  it('sums per-query usage but does not double-count cumulative model totals across native queries', async () => {
    const f = await fixture();
    f.init();
    expect(f.argv).toContain('--replay-user-messages');
    expect(f.argv[f.argv.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(vi.mocked(spawn).mock.calls[0][2]?.env).toMatchObject({ INK_TURN_OWNER: 'parent' });
    expect(f.binding.ownChild).toHaveBeenCalledOnce();
    await f.steer();
    const correction = f.writes[2].uuid as string;
    f.result([f.original], 'Original', 10);
    f.complete(f.original);
    expect(f.child.stdin.end).not.toHaveBeenCalled();
    f.receive({ type: 'command_lifecycle', command_uuid: correction, state: 'started' });
    f.result([correction], 'Updated', 20, { inputTokens: 30, outputTokens: 4, costUSD: 0.2 });
    f.complete(correction);
    expect(await f.running).toMatchObject({
      success: true,
      finalTextResponse: 'Updated',
      usage: {
        inputTokens: 30,
        outputTokens: 4,
        modelUsage: { 'synthetic-model': { inputTokens: 30, outputTokens: 4, costUSD: 0.2 } },
      },
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.child.stdin.end).toHaveBeenCalledOnce();
    expect(f.releaseChild).toHaveBeenCalledOnce();
    expect(f.releasePort).toHaveBeenCalledOnce();
  });

  it('does not close when only the mid-tool correction completed', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    const correction = f.writes[2].uuid as string;
    f.receive({ type: 'command_lifecycle', command_uuid: correction, state: 'started' });
    f.complete(correction);
    expect(f.child.stdin.end).not.toHaveBeenCalled();
    f.result([f.original, correction], 'Updated');
    f.complete(f.original);
    expect((await f.running).success).toBe(true);
  });

  it('premature exit is a failure even when the first result succeeded', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    f.result([f.original], 'Original');
    f.complete(f.original);
    f.close();
    expect(await f.running).toMatchObject({
      success: false,
      error: 'Claude exited before all native inputs completed',
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.log.append).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }));
  });

  it('keeps observed partial tool work when the native process exits nonzero', async () => {
    const f = await fixture();
    f.init();
    f.receive({ type: 'tool_use', id: 'synthetic-tool-call', name: 'synthetic-read', input: {} });
    f.close(1);
    expect(await f.running).toMatchObject({
      success: false,
      toolCalls: [{ toolUseId: 'synthetic-tool-call', toolName: 'synthetic-read', input: {} }],
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('input stream failure stops the owned process and never retries it', async () => {
    const f = await fixture();
    f.init();
    await f.steer();
    f.child.stdin.emit('error', new Error('Synthetic pipe failure'));
    expect((await f.running).success).toBe(false);
    expect(stopProcessAndWait).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.releaseChild).toHaveBeenCalledOnce();
  });

  it('an unsupported lifecycle contract fails before admitting corrections', async () => {
    const f = await fixture();
    f.receive({ type: 'system', subtype: 'init', capabilities: [] });
    expect((await f.running).success).toBe(false);
    expect(f.binding.bind).not.toHaveBeenCalled();
    expect(stopProcessAndWait).toHaveBeenCalledOnce();
  });

  it('keeps child ownership after leader exit until its group is confirmed empty', async () => {
    const f = await fixture({ killProcessGroup: true });
    f.init();
    vi.useFakeTimers();
    vi.mocked(probeGroup).mockReturnValue('alive');
    f.close();
    expect(await f.running).toMatchObject({
      success: false,
      stopUnconfirmed: { leaderExited: true, group: 'alive' },
    });
    expect(f.releaseChild).not.toHaveBeenCalled();
    vi.mocked(probeGroup).mockReturnValue('empty');
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.releaseChild).toHaveBeenCalledOnce();
  });

  it('retains ownership after an uncertain group stop and never retries the input', async () => {
    const f = await fixture({ killProcessGroup: true });
    f.init();
    await f.steer();
    vi.useFakeTimers();
    vi.mocked(probeGroup).mockReturnValue('unknown');
    vi.mocked(stopProcessAndWait).mockImplementationOnce(async () => {
      f.close();
      return { exited: true, group: 'unknown' };
    });
    f.child.stdin.emit('error', new Error('Synthetic transport failure'));
    expect(await f.running).toMatchObject({
      success: false,
      stopUnconfirmed: { group: 'unknown' },
    });
    expect(f.releaseChild).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    vi.mocked(probeGroup).mockReturnValue('empty');
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.releaseChild).toHaveBeenCalledOnce();
  });

  it('cleans prepared permissions when native evidence cannot open, without spawning', async () => {
    const restore = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    vi.mocked(applyPermissionOverlay).mockResolvedValueOnce(restore);
    vi.mocked(prepareLaunchSettings).mockResolvedValueOnce({
      processPath: '/synthetic/settings',
      cleanup,
    } as never);
    const binding: NativeSteeringBinding = {
      turnEpoch: 'synthetic-epoch',
      assertCurrent: vi.fn(),
      ownChild: vi.fn(),
      bind: vi.fn(),
      openLog: vi.fn(async () => {
        throw new Error('Synthetic evidence failure');
      }),
    };
    const result = await new ClaudeRunner().run('Synthetic original', {
      config: {
        workingDirectory: '/synthetic/studio',
        mcpConfigPath: '',
        nativeSteering: binding,
        permissionOverlay: {} as never,
        launchPermissions: {} as never,
      },
    });
    expect(result.success).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
