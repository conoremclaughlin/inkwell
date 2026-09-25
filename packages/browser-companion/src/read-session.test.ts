import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSnapshot } from './protocol';
import {
  MAX_READ_LIVENESS_MS,
  MAX_READ_OPERATIONS,
  MAX_READ_SESSION_MS,
  PageReadSession,
  type ReadGrant,
  type ReadTarget,
} from './read-session';

const WALL = 1_800_000_000_000;
const target = (): ReadTarget => ({
  tabId: 7,
  documentId: 'synthetic-document',
  navigationId: 'nav-1',
  origin: 'https://fixture.test',
});
const grant = (changes: Partial<ReadGrant> = {}): ReadGrant => ({
  id: 'synthetic-grant',
  controllerSessionId: 'synthetic-controller',
  expiresAt: WALL + MAX_READ_SESSION_MS,
  maxReads: MAX_READ_OPERATIONS,
  ...changes,
});
function fixture(changes: Partial<ReadGrant> = {}) {
  const time = { wall: WALL, monotonic: 0 };
  const session = new PageReadSession(grant(changes), target(), {
    wall: () => time.wall,
    monotonic: () => time.monotonic,
  });
  const snapshot = (): BrowserSnapshot => ({
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    capturedAt: time.wall,
    url: 'https://fixture.test/article',
    title: 'Synthetic article',
    mode: 'page',
    text: 'Synthetic page text',
    truncated: false,
    fields: [],
  });
  const verify = vi.fn(async () => MAX_READ_LIVENESS_MS);
  const capture = vi.fn(async () => ({ target: target(), snapshot: snapshot() }));
  const advance = (ms: number) => {
    time.wall += ms;
    time.monotonic += ms;
  };
  return { session, time, snapshot, adapter: { verify, capture }, advance };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('read discussion local authority (no real executor or network)', () => {
  it('verifies every read and captures again rather than replaying the initial snapshot', async () => {
    const f = fixture();
    const first = await f.session.read('page', f.adapter);
    f.advance(1);
    f.adapter.capture.mockResolvedValueOnce({
      target: target(),
      snapshot: { ...f.snapshot(), text: 'Changed page' },
    });
    const next = await f.session.read('page', f.adapter);
    expect(first.text).toBe('Synthetic page text');
    expect(next.text).toBe('Changed page');
    expect(f.adapter.verify).toHaveBeenCalledTimes(2);
    expect(f.adapter.capture).toHaveBeenCalledTimes(2);
    expect(f.session.status()).toEqual({
      state: 'ready',
      reason: undefined,
      readsUsed: 2,
      readLimit: 60,
    });
  });

  it('gives adapters detached immutable authority, and returns detached observations', async () => {
    const g = grant();
    const t = target();
    const s = new PageReadSession(g, t, { wall: () => WALL, monotonic: () => 0 });
    g.maxReads = 10000;
    g.controllerSessionId = 'different-controller';
    t.tabId = 99;
    const f = fixture();
    const snapshot = f.snapshot();
    const capture = vi.fn(async (source: Readonly<ReadTarget>) => {
      expect(Object.isFrozen(source)).toBe(true);
      expect(source).toEqual(target());
      return { target: target(), snapshot };
    });
    const verify = vi.fn(async (bound: Readonly<ReadGrant>) => {
      expect(Object.isFrozen(bound)).toBe(true);
      expect(bound.controllerSessionId).toBe('synthetic-controller');
      return 1000;
    });
    const observation = await s.read('page', { verify, capture });
    snapshot.text = 'Mutated later';
    expect(observation.text).toBe('Synthetic page text');
  });

  it('reserves budget and prevents concurrent reads before awaiting verification', async () => {
    const f = fixture({ maxReads: 1 });
    const check = deferred<number>();
    f.adapter.verify.mockReturnValueOnce(check.promise);
    const reading = f.session.read('page', f.adapter);
    expect(f.session.status().state).toBe('reading');
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('already in progress');
    expect(f.adapter.verify).toHaveBeenCalledTimes(1);
    check.resolve(1000);
    await reading;
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('budget exhausted');
    expect(f.adapter.verify).toHaveBeenCalledTimes(1);
  });

  it('spends failed attempts too and does not leak adapter error details', async () => {
    const f = fixture({ maxReads: 1 });
    f.adapter.verify.mockRejectedValueOnce(new Error('private synthetic diagnostic'));
    await expect(f.session.read('page', f.adapter)).rejects.toThrow(
      'Page-read authorization failed.'
    );
    expect(f.adapter.capture).not.toHaveBeenCalled();
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('budget exhausted');
  });

  it('Stop rejects immediately even if authorization never answers; late success cannot restart it', async () => {
    const f = fixture();
    const check = deferred<number>();
    f.adapter.verify.mockReturnValueOnce(check.promise);
    const reading = f.session.read('page', f.adapter);
    const rejected = expect(reading).rejects.toThrow('interrupted');
    f.session.stop();
    await rejected;
    check.resolve(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.adapter.capture).not.toHaveBeenCalled();
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: user');
    expect(f.session.status().reason).toBe('user');
  });

  it('Stop also suppresses a late capture and aborts the local adapter signal', async () => {
    const f = fixture();
    const observation = deferred<{ target: ReadTarget; snapshot: BrowserSnapshot }>();
    let signal!: AbortSignal;
    const capture = vi.fn(
      (_target: Readonly<ReadTarget>, _mode: BrowserSnapshot['mode'], s: AbortSignal) => {
        signal = s;
        return observation.promise;
      }
    );
    const reading = f.session.read('page', { verify: f.adapter.verify, capture });
    const rejected = expect(reading).rejects.toThrow('interrupted');
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    f.session.stop();
    await rejected;
    expect(signal.aborted).toBe(true);
    observation.resolve({ target: target(), snapshot: f.snapshot() });
    await Promise.resolve();
    expect(f.session.status().state).toBe('stopped');
  });

  it('rechecks Stop at the observation handoff, after capture resolves but before read returns', async () => {
    const f = fixture();
    const reading = f.session.read('page', f.adapter);
    await Promise.resolve(); // Verification resolves; capture starts.
    await Promise.resolve(); // Capture resolves; the result handoff is still queued.
    expect(f.adapter.capture).toHaveBeenCalledTimes(1);
    f.session.stop();
    await expect(reading).rejects.toThrow();
  });

  it('rechecks liveness at that same observation handoff without relying on the timeout', async () => {
    const f = fixture();
    f.adapter.verify.mockResolvedValueOnce(1000);
    const reading = f.session.read('page', f.adapter);
    await Promise.resolve();
    await Promise.resolve();
    f.advance(1000);
    await expect(reading).rejects.toThrow('liveness expired');
  });

  it.each([
    { tabId: 8 },
    { documentId: 'replacement-document' },
    { navigationId: 'nav-2' },
    { origin: 'https://other.test' },
  ])('invalidates authority on attachment change %j', async (change) => {
    const f = fixture();
    f.session.observeTarget(target());
    await f.session.read('page', f.adapter);
    f.session.observeTarget({ ...target(), ...change });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: navigation');
    expect(f.adapter.verify).toHaveBeenCalledTimes(1);
  });

  it('refuses a capture from a different trusted document without returning its data', async () => {
    const f = fixture();
    f.adapter.capture.mockResolvedValueOnce({
      target: { ...target(), documentId: 'wrong-document' },
      snapshot: f.snapshot(),
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow();
    expect(f.session.status().reason).toBe('navigation');
  });

  it.each([0, -1, NaN, Infinity])('refuses invalid liveness %s', async (duration) => {
    const f = fixture();
    f.adapter.verify.mockResolvedValueOnce(duration);
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('Invalid page-read liveness');
    expect(f.adapter.capture).not.toHaveBeenCalled();
  });

  it('deducts verification latency and expires at the boundary without a sweep', async () => {
    const f = fixture();
    f.adapter.verify.mockImplementationOnce(async () => {
      f.advance(1000);
      return 1000;
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('liveness expired');
    expect(f.adapter.capture).not.toHaveBeenCalled();
  });

  it('a fresh server response cannot expand the local liveness ceiling', async () => {
    const f = fixture();
    f.adapter.verify.mockImplementationOnce(async () => {
      f.advance(MAX_READ_LIVENESS_MS);
      return MAX_READ_SESSION_MS;
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('liveness expired');
    expect(f.adapter.capture).not.toHaveBeenCalled();
  });

  it('times out a silent authority channel; late success never triggers capture', async () => {
    const f = fixture();
    const check = deferred<number>();
    f.adapter.verify.mockReturnValueOnce(check.promise);
    const reading = f.session.read('page', f.adapter);
    const rejected = expect(reading).rejects.toThrow('interrupted');
    await vi.advanceTimersByTimeAsync(MAX_READ_LIVENESS_MS);
    await rejected;
    check.resolve(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.adapter.capture).not.toHaveBeenCalled();
  });

  it('times out a hung capture at the remaining—not freshly extended—deadline', async () => {
    const f = fixture();
    const observation = deferred<{ target: ReadTarget; snapshot: BrowserSnapshot }>();
    f.adapter.verify.mockImplementationOnce(async () => {
      f.advance(900);
      return 1000;
    });
    f.adapter.capture.mockReturnValueOnce(observation.promise);
    const reading = f.session.read('page', f.adapter);
    const rejected = expect(reading).rejects.toThrow('interrupted');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    observation.resolve({ target: target(), snapshot: f.snapshot() });
  });

  it.each(['wall', 'monotonic'] as const)(
    'independently enforces the session ceiling on %s time',
    async (which) => {
      const f = fixture({ expiresAt: WALL + MAX_READ_SESSION_MS * 2 });
      await f.session.read('page', f.adapter);
      f.time[which] += MAX_READ_SESSION_MS;
      await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: expired');
      expect(f.adapter.verify).toHaveBeenCalledTimes(1);
    }
  );

  it('uses the shorter grant deadline and never renews it after successful reads', async () => {
    const f = fixture({ expiresAt: WALL + 1000 });
    await f.session.read('page', f.adapter);
    f.advance(1000);
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: expired');
  });

  it.each(['wall', 'monotonic'] as const)(
    'fails closed if the %s clock moves backwards',
    async (which) => {
      const f = fixture();
      f.advance(100);
      await f.session.read('page', f.adapter);
      f.time[which]--;
      await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: clock-changed');
    }
  );

  it.each([NaN, Infinity])('fails closed on invalid clock readings %s', async (value) => {
    const f = fixture();
    f.time.wall = value;
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: clock-changed');
  });

  it('checks the session deadline again after capture, even if timers were suspended', async () => {
    const f = fixture({ expiresAt: WALL + 1000 });
    f.adapter.capture.mockImplementationOnce(async () => {
      f.advance(1000);
      return { target: target(), snapshot: f.snapshot() };
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow();
    expect(f.session.status().reason).toBe('expired');
  });

  it.each([
    { capturedAt: WALL - 1 },
    { capturedAt: WALL + 1 },
    { mode: 'selection' as const },
    { text: 'x'.repeat(12_001) },
  ])('rejects stale/mismatched/oversized snapshots', async (change) => {
    const f = fixture();
    f.adapter.capture.mockResolvedValueOnce({
      target: target(),
      snapshot: { ...f.snapshot(), ...change },
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow();
  });

  it('supports explicitly selected text as a separate mode', async () => {
    const f = fixture();
    f.adapter.capture.mockResolvedValueOnce({
      target: target(),
      snapshot: { ...f.snapshot(), mode: 'selection' },
    });
    expect((await f.session.read('selection', f.adapter)).mode).toBe('selection');
  });

  it.each(['wall', 'monotonic'] as const)(
    'expires a read when only the %s clock advances during capture',
    async (which) => {
      const f = fixture();
      f.adapter.verify.mockResolvedValueOnce(1000);
      f.adapter.capture.mockImplementationOnce(async () => {
        const snapshot = f.snapshot();
        f.time[which] += 1000;
        return { target: target(), snapshot };
      });
      await expect(f.session.read('page', f.adapter)).rejects.toThrow('liveness expired');
    }
  );

  it.each(['wall', 'monotonic'] as const)(
    'the %s session deadline independently shortens the hung-read timer',
    async (which) => {
      const f = fixture({ expiresAt: WALL + 1000 });
      // Move just one clock before the read: the two session terms must differ.
      f.time[which] += 500;
      f.adapter.capture.mockReturnValueOnce(new Promise(() => {}));
      const rejected = vi.fn();
      const reading = f.session.read('page', f.adapter).catch(rejected);
      try {
        await vi.advanceTimersByTimeAsync(499);
        expect(rejected).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        expect(rejected.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining('interrupted'),
        });
      } finally {
        f.session.stop();
        await reading;
      }
    }
  );

  it('rejects an unknown mode before reserving budget or calling either adapter', async () => {
    const f = fixture();
    await expect(
      f.session.read('screenshot' as BrowserSnapshot['mode'], f.adapter)
    ).rejects.toThrow('Unsupported read mode');
    expect(f.session.status().readsUsed).toBe(0);
    expect(f.adapter.verify).not.toHaveBeenCalled();
    expect(f.adapter.capture).not.toHaveBeenCalled();
  });

  it('preserves the first Stop reason when later observations notice expiry', () => {
    const f = fixture();
    f.session.stop('user');
    f.advance(MAX_READ_SESSION_MS);
    expect(f.session.status().reason).toBe('user');
    f.session.stop('disconnected');
    expect(f.session.status().reason).toBe('user');
  });

  it.each([
    'https://fixture.test.evil.test/article',
    'https://fixture.test:444/article',
    'http://fixture.test/article',
    'https://other.test/article',
  ])('rejects a snapshot outside the exact trusted origin: %s', async (url) => {
    const f = fixture();
    f.adapter.capture.mockResolvedValueOnce({
      target: target(),
      snapshot: { ...f.snapshot(), url },
    });
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('does not belong');
  });

  it('allows a different path on the bound origin; document/navigation remain adapter checks', async () => {
    const f = fixture();
    f.adapter.capture.mockResolvedValueOnce({
      target: target(),
      snapshot: { ...f.snapshot(), url: 'https://fixture.test/other-path' },
    });
    expect((await f.session.read('page', f.adapter)).url).toBe('https://fixture.test/other-path');
  });

  it.each([
    '',
    'not a URL',
    'null',
    'file://',
    'https://fixture.test/',
    'https://fixture.test/path',
    'https://fixture.test?query=synthetic',
    'https://fixture.test#fragment',
    'https://synthetic@fixture.test',
  ])('rejects non-canonical attachment origins: %s', (origin) => {
    expect(
      () =>
        new PageReadSession(
          grant(),
          { ...target(), origin },
          {
            wall: () => WALL,
            monotonic: () => 0,
          }
        )
    ).toThrow('Invalid page-read');
  });

  it('clamps a larger server budget locally and validates construction', () => {
    expect(fixture({ maxReads: 1000 }).session.status().readLimit).toBe(MAX_READ_OPERATIONS);
    for (const change of [
      { maxReads: 0 },
      { maxReads: 1.5 },
      { expiresAt: WALL },
      { expiresAt: NaN },
      { id: '' },
      { controllerSessionId: '' },
    ])
      expect(() => fixture(change)).toThrow('Invalid page-read');
  });

  it('never reauthorizes a stopped instance, even if a fresh server check could succeed', async () => {
    const f = fixture();
    f.session.stop();
    f.advance(1000);
    await expect(f.session.read('page', f.adapter)).rejects.toThrow('stopped: user');
    expect(f.adapter.verify).not.toHaveBeenCalled();
    expect(f.adapter.capture).not.toHaveBeenCalled();
    expect(f.session.status().state).toBe('stopped');
  });
});
