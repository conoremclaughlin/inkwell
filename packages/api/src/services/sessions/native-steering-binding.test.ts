/** Synthetic registry and token claims only: no DB, provider, subprocess, or credentials. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../auth/ink-tokens', () => ({ verifyInkAccessToken: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { verifyInkAccessToken, type InkTokenPayload } from '../../auth/ink-tokens';
import {
  getActiveRun,
  registerActiveRun,
  resetActiveRuns,
  submitRunSteering,
  markRunnerSettled,
  closeIntakeAndDrain,
} from './active-runs';
import {
  createNativeSteeringBinding,
  type NativeSteeringAdmission,
} from './native-steering-binding';
import type { SessionSteeringReceipt } from '@inklabs/shared/runtime';

const request = { messageId: 'synthetic-correction', text: 'Use the revised fixture.' };
let snapshot: NativeSteeringAdmission;
let claims: InkTokenPayload;
let abort: AbortController;
beforeEach(() => {
  resetActiveRuns();
  abort = new AbortController();
  snapshot = {
    sessionId: 'synthetic-session',
    turnEpoch: 'synthetic-epoch',
    userId: 'synthetic-user',
    sbId: 'synthetic-sb',
    sbSlug: 'echo',
    contactId: null,
    cliAttached: false,
    identityMetadata: {},
    executionTier: 'full',
    workingDirectory: '/synthetic-unused-directory',
    inkAccessToken: 'synthetic-token',
    signal: abort.signal,
  };
  claims = {
    type: 'mcp_access',
    sub: snapshot.userId,
    email: 'fixture@example.invalid',
    scope: 'mcp:tools',
    sessionId: snapshot.sessionId,
    sbId: snapshot.sbId!,
    sbSlug: snapshot.sbSlug,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  vi.mocked(verifyInkAccessToken).mockReset().mockReturnValue(claims);
  registerActiveRun({
    sessionId: snapshot.sessionId,
    turnEpoch: snapshot.turnEpoch,
    userId: snapshot.userId,
    sbSlug: snapshot.sbSlug,
    backend: 'codex-cli',
    startedAt: Date.now(),
  });
});
afterEach(() => {
  abort.abort();
  resetActiveRuns();
  vi.useRealTimers();
});
const submit = () => submitRunSteering(snapshot.sessionId, snapshot.turnEpoch, request);

describe('native steering admission', () => {
  it.each(['codex-cli', 'claude-code'])(
    'binds one %s owner generation, then retires permanently',
    async (backend) => {
      getActiveRun(snapshot.sessionId)!.backend = backend;
      const binding = createNativeSteeringBinding(snapshot)!;
      expect(binding.turnEpoch).toBe(snapshot.turnEpoch);
      expect(verifyInkAccessToken).toHaveBeenCalledWith('synthetic-token', 'mcp_access');
      expect(await submit()).toMatchObject({ status: 'refused' });
      const enqueue = vi.fn(async () => ({
        messageId: request.messageId,
        status: 'pending' as const,
      }));
      const release = binding.bind(enqueue);
      expect(await submit()).toEqual({ messageId: request.messageId, status: 'pending' });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(() => binding.bind(enqueue)).toThrow('already has a mailbox');
      release();
      release();
      expect(getActiveRun(snapshot.sessionId)!.hostedSteering).toBeUndefined();
      expect(() => binding.bind(enqueue)).toThrow('no longer admitted');
      expect(await submit()).toMatchObject({ status: 'refused' });
      expect(enqueue).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['tools-only tier', { executionTier: 'tools' }],
    ['unknown tier', { executionTier: undefined }],
    ['Inkling', { identityMetadata: { client: 'inkling-mobile' } }],
    ['missing metadata', { identityMetadata: undefined }],
    ['null metadata', { identityMetadata: null }],
    ['array metadata', { identityMetadata: [] }],
    ['string metadata', { identityMetadata: 'ordinary' }],
    ['contact scope', { contactId: 'synthetic-contact' }],
    ['unknown contact scope', { contactId: undefined }],
    ['interactive session', { cliAttached: true }],
    ['unknown attachment', { cliAttached: undefined }],
    ['missing canonical identity', { sbId: undefined }],
    ['relative directory', { workingDirectory: 'relative' }],
    ['path-like session', { sessionId: '../escape' }],
    ['path-like epoch', { turnEpoch: '../escape' }],
    ['container', { container: {} }],
  ])('withholds the port for %s', (_label, change) => {
    Object.assign(snapshot, change);
    expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
    expect(verifyInkAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong credential class', { type: 'pcp_admin' }],
    ['wrong owner', { sub: 'synthetic-other-user' }],
    ['wrong session', { sessionId: 'synthetic-other-session' }],
    ['wrong slug', { sbSlug: 'other' }],
    ['wrong canonical identity', { sbId: 'synthetic-other-sb' }],
    ['missing canonical identity', { sbId: undefined }],
    ['conflicting identity claim', { identityId: 'synthetic-other-sb' }],
    ['contact-scoped token', { contactId: 'synthetic-contact' }],
    ['empty contact claim', { contactId: '' }],
    ['wrong scope', { scope: 'mcp:observe' }],
    ['malformed scope', { scope: null }],
    ['missing expiry', { exp: undefined }],
    ['malformed expiry', { exp: '9999999999' }],
    ['nonfinite expiry', { exp: Number.POSITIVE_INFINITY }],
    ['expired credential', { exp: 1 }],
  ])('withholds the port for %s', (_label, change) => {
    Object.assign(claims, change);
    expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
  });

  it('does not accept a missing or unverifiable credential', () => {
    snapshot.inkAccessToken = undefined;
    expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
    snapshot.inkAccessToken = 'synthetic-token';
    vi.mocked(verifyInkAccessToken).mockReturnValue(null);
    expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
  });

  it('requires the canonical backend name rather than an unresolved alias', () => {
    getActiveRun(snapshot.sessionId)!.backend = 'codex';
    expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
  });

  it.each(['absent', 'owner', 'slug', 'epoch', 'settled', 'backend', 'aborted', 'spawn-refused'])(
    'requires an admitted active run: %s',
    (kind) => {
      const run = getActiveRun(snapshot.sessionId)!;
      if (kind === 'absent') resetActiveRuns();
      if (kind === 'owner') run.userId = 'synthetic-other-user';
      if (kind === 'slug') run.sbSlug = 'other';
      if (kind === 'epoch') run.turnEpoch = 'synthetic-other-epoch';
      if (kind === 'settled') markRunnerSettled(snapshot.sessionId, 'succeeded');
      if (kind === 'backend') run.backend = 'ink';
      if (kind === 'aborted') abort.abort();
      if (kind === 'spawn-refused') snapshot.admitSpawn = () => 'Synthetic refusal';
      expect(createNativeSteeringBinding(snapshot)).toBeUndefined();
    }
  );

  it('captures admitted primitives rather than the mutable input object', async () => {
    const binding = createNativeSteeringBinding(snapshot)!;
    snapshot.turnEpoch = 'synthetic-other-epoch';
    snapshot.userId = 'synthetic-other-user';
    snapshot.signal = new AbortController().signal;
    claims.exp = 1;
    const release = binding.bind(async (input) => ({
      messageId: input.messageId,
      status: 'pending',
    }));
    expect(await submitRunSteering('synthetic-session', 'synthetic-epoch', request)).toMatchObject({
      status: 'pending',
    });
    abort.abort();
    expect(getActiveRun('synthetic-session')!.hostedSteering).toBeUndefined();
    expect(() => binding.assertCurrent()).toThrow();
    release();
  });

  it('fences a replacement run even if its epoch and owner fields are identical', async () => {
    const oldRun = getActiveRun(snapshot.sessionId)!;
    const binding = createNativeSteeringBinding(snapshot)!;
    const release = binding.bind(async (input) => ({
      messageId: input.messageId,
      status: 'pending',
    }));
    registerActiveRun({ ...oldRun, hostedSteering: undefined });
    expect(() => binding.assertCurrent()).toThrow('no longer admitted');
    expect(await submit()).toMatchObject({ status: 'refused' });
    const fresh = createNativeSteeringBinding(snapshot)!;
    const releaseFresh = fresh.bind(async (input) => ({
      messageId: input.messageId,
      status: 'pending',
    }));
    release();
    expect(await submit()).toMatchObject({ status: 'pending' });
    releaseFresh();
  });

  it('detaches immediately on abort before any more delivery', async () => {
    const binding = createNativeSteeringBinding(snapshot)!;
    const enqueue = vi.fn(async () => ({
      messageId: request.messageId,
      status: 'pending' as const,
    }));
    binding.bind(enqueue);
    abort.abort();
    expect(getActiveRun(snapshot.sessionId)!.hostedSteering).toBeUndefined();
    expect(await submit()).toMatchObject({ status: 'refused' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['pending', 'inserted', 'refused', 'unknown'] as const)(
    'rechecks after asynchronous %s admission without inventing certainty',
    async (status) => {
      const binding = createNativeSteeringBinding(snapshot)!;
      let finish!: (value: SessionSteeringReceipt) => void;
      binding.bind(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const receipt = submit();
      abort.abort();
      finish({ messageId: request.messageId, status, reason: 'synthetic-reason', eid: 7 });
      expect(await receipt).toMatchObject({
        messageId: request.messageId,
        status: status === 'refused' || status === 'unknown' ? status : 'unknown',
        eid: 7,
      });
    }
  );

  it('checks credential expiry again at dispatch time', async () => {
    vi.useFakeTimers();
    const binding = createNativeSteeringBinding(snapshot)!;
    const enqueue = vi.fn(async () => ({
      messageId: request.messageId,
      status: 'pending' as const,
    }));
    const release = binding.bind(enqueue);
    vi.setSystemTime((claims.exp! + 1) * 1000);
    expect(await submit()).toMatchObject({ status: 'refused' });
    expect(enqueue).not.toHaveBeenCalled();
    release();
  });

  it('refuses an owner after shutdown intake closes', async () => {
    const binding = createNativeSteeringBinding(snapshot)!;
    await closeIntakeAndDrain();
    expect(() => binding.assertCurrent()).toThrow('no longer admitted');
  });
});
