/** All filesystem effects stay under owned temporary roots; no live data or provider. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock('../../auth/ink-tokens', () => ({ verifyInkAccessToken: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openNativeSteeringLog, type NativeSteeringLog } from './native-steering-log';
import {
  createNativeSteeringBinding,
  type NativeSteeringAdmission,
} from './native-steering-binding';
import { verifyInkAccessToken } from '../../auth/ink-tokens';
import { registerActiveRun, resetActiveRuns } from './active-runs';
let cwd: string;
const logs: NativeSteeringLog[] = [];
const sessionId = 'synthetic-session';
const turnEpoch = 'synthetic-epoch';
const event = {
  type: 'native_steering_request',
  version: 1,
  turnEpoch,
  messageId: 'synthetic-message',
  text: 'Revised fixture.',
};
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'ink-native-steering-test-')));
  vi.mocked(open).mockClear();
  resetActiveRuns();
});
afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close().catch(() => undefined)));
  resetActiveRuns();
  await rm(cwd, { recursive: true, force: true });
});
async function createLog() {
  const log = await openNativeSteeringLog({ cwd, sessionId, turnEpoch });
  logs.push(log);
  return log;
}
function admission(): NativeSteeringAdmission {
  registerActiveRun({
    sessionId,
    turnEpoch,
    userId: 'synthetic-user',
    sbSlug: 'echo',
    backend: 'codex-cli',
    startedAt: Date.now(),
  });
  vi.mocked(verifyInkAccessToken).mockReturnValue({
    type: 'mcp_access',
    sub: 'synthetic-user',
    email: 'fixture@example.invalid',
    scope: 'mcp:tools',
    sbSlug: 'echo',
    sbId: 'synthetic-sb',
    sessionId,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return {
    sessionId,
    turnEpoch,
    userId: 'synthetic-user',
    sbSlug: 'echo',
    sbId: 'synthetic-sb',
    contactId: null,
    cliAttached: false,
    identityMetadata: {},
    executionTier: 'full',
    workingDirectory: cwd,
    inkAccessToken: 'synthetic-token',
  };
}

describe('generation-local private native journal', () => {
  it('uses private directories and an exclusive file, flushes native evidence, and closes permanently', async () => {
    const log = await createLog();
    expect((await stat(dirname(log.path))).mode & 0o777).toBe(0o700);
    expect((await stat(join(cwd, '.ink/runtime/native-steering'))).mode & 0o777).toBe(0o700);
    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
    expect(open).toHaveBeenCalledWith(log.path, 'wx', 0o600);
    expect(log.append({ ...event, eid: 900, ts: 'wrong', extraneous: 'not-journaled' })).toBe(1);
    expect(
      log.append({
        type: 'native_steering_observation',
        version: 1,
        turnEpoch,
        messageId: event.messageId,
      })
    ).toBe(2);
    await log.flush();
    const entries = (await readFile(log.path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      { ...event, eid: 1, ts: expect.any(String) },
      {
        type: 'native_steering_observation',
        version: 1,
        turnEpoch,
        messageId: event.messageId,
        eid: 2,
        ts: expect.any(String),
      },
    ]);
    const closed = log.close();
    expect(log.close()).toBe(closed);
    expect(() => log.append(event)).toThrow('closed');
    await closed;
  });

  it('always creates a fresh journal and does not replay a previous intent', async () => {
    const first = await createLog();
    first.append(event);
    await first.close();
    const second = await createLog();
    expect(second.path).not.toBe(first.path);
    expect(await readFile(second.path, 'utf8')).toBe('');
    expect(second.append(event)).toBe(1);
    expect(second).not.toHaveProperty('read');
    expect(second).not.toHaveProperty('seed');
  });

  it.each([
    { type: 'steering_request' },
    { type: 'user' },
    { type: 'toString' },
    { version: 2 },
    { turnEpoch: 'synthetic-other-epoch' },
  ])('refuses non-native or foreign-generation evidence: %j', async (change) => {
    const log = await createLog();
    expect(() => log.append({ ...event, ...change })).toThrow('Invalid native');
    await log.flush();
    expect(await readFile(log.path, 'utf8')).toBe('');
  });

  it.each(['sessionId', 'turnEpoch', 'cwd'])(
    'refuses unsafe %s before opening a file',
    async (field) => {
      await expect(
        openNativeSteeringLog({ cwd, sessionId, turnEpoch, [field]: '../escape' })
      ).rejects.toThrow('Invalid native');
      expect(open).not.toHaveBeenCalled();
    }
  );

  it('refuses a symlink in the journal directory rather than writing through it', async () => {
    const elsewhere = join(cwd, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(cwd, '.ink'));
    await expect(createLog()).rejects.toThrow('real directories');
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an existing public journal root rather than storing private text there', async () => {
    await mkdir(join(cwd, '.ink/runtime/native-steering'), { recursive: true, mode: 0o755 });
    await expect(createLog()).rejects.toThrow('not private');
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['appendFile', 'sync'] as const)(
    'makes an asynchronous %s error sticky, does not write later records, and still closes',
    async (method) => {
      const error = new Error('Synthetic disk failure');
      const file = {
        appendFile: vi.fn(async () => undefined),
        sync: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      file[method].mockRejectedValueOnce(error);
      vi.mocked(open).mockResolvedValueOnce(file as unknown as Awaited<ReturnType<typeof open>>);
      const log = await createLog();
      log.append(event);
      log.append(event);
      await expect(log.flush()).rejects.toBe(error);
      expect(file.appendFile).toHaveBeenCalledOnce();
      expect(() => log.append(event)).toThrow(error);
      await expect(log.close()).rejects.toBe(error);
      await expect(log.close()).rejects.toBe(error);
      expect(file.close).toHaveBeenCalledOnce();
    }
  );

  it('opens once per admitted binding and does not recreate a closed log', async () => {
    const binding = createNativeSteeringBinding(admission())!;
    const first = binding.openLog();
    expect(binding.openLog()).toBe(first);
    const log = await first;
    logs.push(log);
    await log.close();
    expect(await binding.openLog()).toBe(log);
    expect(() => log.append(event)).toThrow('closed');
  });

  it('keeps open failures sticky rather than creating a second journal', async () => {
    const error = new Error('Synthetic open failure');
    vi.mocked(open).mockRejectedValueOnce(error);
    const binding = createNativeSteeringBinding(admission())!;
    await expect(binding.openLog()).rejects.toBe(error);
    await expect(binding.openLog()).rejects.toBe(error);
    expect(open).toHaveBeenCalledOnce();
  });

  it('closes an opened journal if ownership is lost during its async open', async () => {
    const file = { appendFile: vi.fn(), sync: vi.fn(), close: vi.fn(async () => undefined) };
    vi.mocked(open).mockImplementationOnce(async () => {
      resetActiveRuns();
      return file as unknown as Awaited<ReturnType<typeof open>>;
    });
    const binding = createNativeSteeringBinding(admission())!;
    await expect(binding.openLog()).rejects.toThrow('no longer admitted');
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.appendFile).not.toHaveBeenCalled();
  });

  it('does not open when already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      openNativeSteeringLog({ cwd, sessionId, turnEpoch, signal: abort.signal })
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('captures the journal generation before asynchronous directory creation', async () => {
    const input = { cwd, sessionId, turnEpoch };
    const opening = openNativeSteeringLog(input);
    input.turnEpoch = 'synthetic-other-epoch';
    const log = await opening;
    logs.push(log);
    log.append(event);
    await log.flush();
    expect(JSON.parse((await readFile(log.path, 'utf8')).trim()).turnEpoch).toBe(turnEpoch);
  });

  it('preserves the sticky write error when closing the file also fails', async () => {
    const writeError = new Error('Synthetic write failure');
    const file = {
      appendFile: vi.fn(async () => {
        throw writeError;
      }),
      sync: vi.fn(),
      close: vi.fn(async () => {
        throw new Error('Synthetic close failure');
      }),
    };
    vi.mocked(open).mockResolvedValueOnce(file as unknown as Awaited<ReturnType<typeof open>>);
    const log = await createLog();
    log.append(event);
    await expect(log.close()).rejects.toBe(writeError);
    expect(file.close).toHaveBeenCalledOnce();
  });
});
