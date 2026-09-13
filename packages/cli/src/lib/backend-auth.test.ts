import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mocked so no test ever probes a real provider. Each test decides how the
// fake `claude auth status` behaves: hang (timeout), or answer.
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('./sb-debug.js', () => ({ sbDebugLog: vi.fn() }));

const {
  parseClaudeAuthStatusOutput,
  parseCodexLoginStatusOutput,
  getBackendAuthStatus,
  ensureBackendAuthReady,
} = await import('./backend-auth.js');

describe('backend auth parsing', () => {
  it('parses claude logged in json', () => {
    const parsed = parseClaudeAuthStatusOutput(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'oauthAccount',
      })
    );
    expect(parsed.authenticated).toBe(true);
    expect(parsed.detail).toContain('logged in');
  });

  it('parses claude logged out json', () => {
    const parsed = parseClaudeAuthStatusOutput(
      JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
      })
    );
    expect(parsed.authenticated).toBe(false);
    expect(parsed.detail).toContain('not logged in');
  });

  it('parses codex logged in text output', () => {
    const parsed = parseCodexLoginStatusOutput('Logged in using ChatGPT');
    expect(parsed.authenticated).toBe(true);
    expect(parsed.detail).toContain('Logged in');
  });

  it('parses codex logged out text output', () => {
    const parsed = parseCodexLoginStatusOutput('Not logged in');
    expect(parsed.authenticated).toBe(false);
    expect(parsed.detail).toContain('Not logged in');
  });
});

// ═══════════════════════════════════════════════════════════════════
// An inconclusive probe is not a logout (2026-09-11)
//
// getBackendAuthStatus returned `authenticated: false` both when the provider
// said it was logged out AND when the probe timed out, and
// ensureBackendAuthReady threw on either in non-interactive mode. So a slow
// keychain read killed a heartbeat exactly the way a real logout does, and
// the two were indistinguishable afterwards — they share a file:line.
// ═══════════════════════════════════════════════════════════════════
describe('inconclusive auth probes', () => {
  /** A child process that never answers — the probe will time out on it. */
  function spawnHangs() {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      (child.stdout as EventEmitter & { setEncoding?: unknown }).setEncoding = vi.fn();
      (child.stderr as EventEmitter & { setEncoding?: unknown }).setEncoding = vi.fn();
      child.kill = vi.fn();
      return child;
    });
  }

  /** A child process that answers immediately with `output`, then exits `code`. */
  function spawnAnswers(output: string, code = 0) {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new EventEmitter() as EventEmitter & { setEncoding?: unknown };
      const stderr = new EventEmitter() as EventEmitter & { setEncoding?: unknown };
      stdout.setEncoding = vi.fn();
      stderr.setEncoding = vi.fn();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = vi.fn();
      setImmediate(() => {
        stdout.emit('data', output);
        child.emit('close', code);
      });
      return child;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reach ensureBackendAuthReady's body — it bails on VITEST otherwise.
    process.env.SB_TEST_BACKEND_AUTH = '1';
    // Keep the timeout tests fast.
    process.env.INK_AUTH_CHECK_TIMEOUT_MS = '20';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.SB_TEST_BACKEND_AUTH;
    delete process.env.INK_AUTH_CHECK_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('marks a timed-out claude probe inconclusive, not logged out', async () => {
    spawnHangs();

    const status = await getBackendAuthStatus('claude');

    expect(status.inconclusive).toBe(true);
    expect(status.detail).toContain('timed out');
  });

  it('does not mark a genuine logout inconclusive', async () => {
    spawnAnswers(JSON.stringify({ loggedIn: false, authMethod: 'none' }));

    const status = await getBackendAuthStatus('claude');

    expect(status.authenticated).toBe(false);
    expect(status.inconclusive).toBeFalsy();
  });

  it('proceeds instead of killing a non-interactive turn when the probe will not answer', async () => {
    spawnHangs();

    // Before: this threw "Backend claude is not authenticated (auth status
    // check timed out)" and the turn died. A probe that did not answer is not
    // a refusal.
    await expect(
      ensureBackendAuthReady('claude', { nonInteractive: true, hasMessage: true, verbose: false })
    ).resolves.toBeUndefined();
  });

  it('retries once before giving up on an inconclusive probe', async () => {
    spawnHangs();

    await ensureBackendAuthReady('claude', {
      nonInteractive: true,
      hasMessage: true,
      verbose: false,
    });

    // One slow read should not cost a turn, so the probe is re-run once.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('proceeds on the retry when the second probe answers', async () => {
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call += 1;
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new EventEmitter() as EventEmitter & { setEncoding?: unknown };
      const stderr = new EventEmitter() as EventEmitter & { setEncoding?: unknown };
      stdout.setEncoding = vi.fn();
      stderr.setEncoding = vi.fn();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = vi.fn();
      if (call > 1) {
        setImmediate(() => {
          stdout.emit('data', JSON.stringify({ loggedIn: true, authMethod: 'oauthAccount' }));
          child.emit('close', 0);
        });
      }
      return child;
    });

    await expect(
      ensureBackendAuthReady('claude', { nonInteractive: true, hasMessage: true, verbose: false })
    ).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('STILL throws in non-interactive mode on a genuine logout', async () => {
    spawnAnswers(JSON.stringify({ loggedIn: false, authMethod: 'none' }));

    // The control. Treating "unknown" as "proceed" must not also make a real
    // logout proceed — that is the whole reason the gate exists.
    await expect(
      ensureBackendAuthReady('claude', { nonInteractive: true, hasMessage: true, verbose: false })
    ).rejects.toThrow(/not authenticated/i);
  });
});
