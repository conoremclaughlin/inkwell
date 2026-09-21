import { describe, expect, it } from 'vitest';
import { classifyError, isPreAcceptanceRefusal, type ErrorCategory } from './classify-error.js';

/**
 * What CodexRunner handed session-service on 2026-09-21, minus the ANSI
 * escapes the logger recorded and with the thread handle replaced by a
 * synthetic UUID — a live session identifier does not belong in a tracked
 * file, and the matcher never reads the digits. Four resumes into a Codex
 * thread whose owner was mid-work were refused exactly this way, and every one
 * of them wrote `lifecycle='failed', cli_attached=false` onto the owner's live
 * row. The UUID's position (between "thread" and "already has an active
 * writer") is the shape the rule has to survive.
 */
const CODEX_WRITER_CONFLICT = [
  'Codex exited with code 1: 2026-09-21T07:51:45.685237Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread 01900000-0000-7000-8000-00000000beef already has an active writer',
  '2026-09-21T07:51:45.685380Z ERROR codex_core::session: Failed to create session: thread-store conflict: thread 01900000-0000-7000-8000-00000000beef already has an active writer',
  'Error: thread/resume: thread/resume failed: thread 01900000-0000-7000-8000-00000000beef already has an active writer (code -32600)',
  '',
  'exitCode=1 signal=none stdoutBytes=0 stderrBytes=575',
].join('\n');

describe('classifyError', () => {
  // ── capacity ──────────────────────────────────────────────────
  it('Gemini "high demand" → capacity', () => {
    const r = classifyError({
      errorText: 'We are currently experiencing high demand. Please try again later.',
    });
    expect(r.category).toBe('capacity');
    expect(r.retryable).toBe(true);
  });

  it('RESOURCE_EXHAUSTED → capacity', () => {
    const r = classifyError({
      errorText: '[RESOURCE_EXHAUSTED] quota exceeded',
      backend: 'gemini',
    });
    expect(r.category).toBe('capacity');
  });

  it('Claude overloaded_error → capacity', () => {
    const r = classifyError({ errorText: 'error: overloaded_error', backend: 'claude' });
    expect(r.category).toBe('capacity');
    expect(r.retryable).toBe(true);
  });

  it('503 status → capacity', () => {
    const r = classifyError({ errorText: 'HTTP 503 Service Unavailable' });
    expect(r.category).toBe('capacity');
  });

  it('529 → capacity', () => {
    const r = classifyError({ errorText: 'Error 529: API overloaded' });
    expect(r.category).toBe('capacity');
  });

  it('Gemini 429 "No capacity available" → capacity (not quota)', () => {
    const r = classifyError({
      errorText:
        'Attempt 1 failed with status 429. Retrying with backoff... GaxiosError: No capacity available for model gemini-3-pro-preview',
      backend: 'gemini',
      exitCode: 1,
    });
    expect(r.category).toBe('capacity');
    expect(r.retryable).toBe(true);
  });

  // ── quota ─────────────────────────────────────────────────────
  it('TerminalQuotaError → quota', () => {
    const r = classifyError({
      errorText: 'TerminalQuotaError: You have exceeded your quota',
      backend: 'gemini',
    });
    expect(r.category).toBe('quota');
    expect(r.retryable).toBe(false);
  });

  it('rate_limit_error → quota', () => {
    const r = classifyError({
      errorText: 'rate_limit_error: too many requests',
      backend: 'claude',
    });
    expect(r.category).toBe('quota');
  });

  it('429 → quota', () => {
    const r = classifyError({ errorText: 'HTTP 429 Too Many Requests' });
    expect(r.category).toBe('quota');
  });

  it('usage limit → quota', () => {
    const r = classifyError({ errorText: 'You have exceeded your usage limit' });
    expect(r.category).toBe('quota');
  });

  it('Claude Code session limit → quota', () => {
    const r = classifyError({
      errorText: "You've hit your session limit · resets 7:10pm (America/Los_Angeles)",
      backend: 'claude',
      exitCode: 1,
    });
    expect(r.category).toBe('quota');
    expect(r.retryable).toBe(false);
  });

  // ── timeout ───────────────────────────────────────────────────
  it('"timed out" → timeout', () => {
    const r = classifyError({ errorText: 'Process timed out after 300s idle' });
    expect(r.category).toBe('timeout');
    expect(r.retryable).toBe(true);
  });

  it('"timeout" → timeout', () => {
    const r = classifyError({ errorText: 'Connection timeout' });
    expect(r.category).toBe('timeout');
  });

  it('idle + kill → timeout', () => {
    const r = classifyError({ errorText: 'Process idle too long, kill sent' });
    expect(r.category).toBe('timeout');
  });

  it('exit code 124 → timeout', () => {
    const r = classifyError({ errorText: 'command terminated', exitCode: 124 });
    expect(r.category).toBe('timeout');
  });

  // ── network (transient) ───────────────────────────────────────
  it('codex models-refresh timeout → timeout (retryable)', () => {
    const r = classifyError({
      errorText: 'failed to refresh available models: timeout waiting for child process',
    });
    // Contains the word "timeout" so the timeout rule wins — still retryable.
    expect(r.category).toBe('timeout');
    expect(r.retryable).toBe(true);
  });

  it('codex exit 1 with stdin banner + models-refresh timeout → retryable', () => {
    const r = classifyError({
      errorText:
        'Codex exited with code 1: Reading additional input from stdin; press Ctrl-D to submit it.\n' +
        'failed to refresh available models: timeout waiting for child process\n\n' +
        'exitCode=1 signal=none stdoutBytes=0 stderrBytes=142',
    });
    expect(r.retryable).toBe(true);
  });

  it('codex stream disconnect → network', () => {
    const r = classifyError({
      errorText:
        'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
    });
    expect(r.category).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('undici fetch failed → network', () => {
    const r = classifyError({ errorText: 'TypeError: fetch failed' });
    expect(r.category).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('UND_ERR_CONNECT_TIMEOUT → retryable transient', () => {
    const r = classifyError({
      errorText: 'ConnectTimeoutError: Connect Timeout Error (code: UND_ERR_CONNECT_TIMEOUT)',
    });
    // "Timeout" word matches the timeout rule first; UND_ERR_CONNECT alone maps to network.
    expect(['timeout', 'network']).toContain(r.category);
    expect(r.retryable).toBe(true);
  });

  it('bare UND_ERR_CONNECT (no timeout word) → network', () => {
    const r = classifyError({ errorText: 'request failed: UND_ERR_CONNECT refused' });
    expect(r.category).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('ECONNRESET → network', () => {
    const r = classifyError({ errorText: 'Error: read ECONNRESET' });
    expect(r.category).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('socket hang up → network', () => {
    const r = classifyError({ errorText: 'Error: socket hang up' });
    expect(r.category).toBe('network');
  });

  it('EAI_AGAIN (DNS) → network', () => {
    const r = classifyError({ errorText: 'getaddrinfo EAI_AGAIN chatgpt.com' });
    expect(r.category).toBe('network');
    expect(r.retryable).toBe(true);
  });

  // ── auth ──────────────────────────────────────────────────────
  it('authentication_error → auth', () => {
    const r = classifyError({ errorText: 'authentication_error: invalid API key' });
    expect(r.category).toBe('auth');
    expect(r.retryable).toBe(false);
  });

  it('UNAUTHENTICATED → auth', () => {
    const r = classifyError({ errorText: 'UNAUTHENTICATED: request had invalid credentials' });
    expect(r.category).toBe('auth');
  });

  it('401 → auth', () => {
    const r = classifyError({ errorText: 'HTTP 401 Unauthorized' });
    expect(r.category).toBe('auth');
  });

  // ── config ────────────────────────────────────────────────────
  it('ModelNotFoundError → config', () => {
    const r = classifyError({ errorText: 'ModelNotFoundError: model xyz not available' });
    expect(r.category).toBe('config');
    expect(r.retryable).toBe(false);
  });

  it('ENOENT → config', () => {
    const r = classifyError({ errorText: 'spawn gemini ENOENT' });
    expect(r.category).toBe('config');
  });

  it('command not found → config', () => {
    const r = classifyError({ errorText: 'gemini: command not found' });
    expect(r.category).toBe('config');
  });

  it('model not found → config', () => {
    const r = classifyError({ errorText: 'The model "gpt-5" was not found' });
    expect(r.category).toBe('config');
  });

  // ── crash ─────────────────────────────────────────────────────
  it('exit code 1 with no other pattern → crash', () => {
    const r = classifyError({ errorText: 'something went wrong', exitCode: 1 });
    expect(r.category).toBe('crash');
    expect(r.retryable).toBe(false);
  });

  it('segfault → crash', () => {
    const r = classifyError({ errorText: 'segfault at address 0x0' });
    expect(r.category).toBe('crash');
  });

  it('OOM → crash', () => {
    const r = classifyError({ errorText: 'OOM: JavaScript heap out of memory' });
    expect(r.category).toBe('crash');
  });

  // ── unknown ───────────────────────────────────────────────────
  it('empty string → unknown', () => {
    const r = classifyError({ errorText: '' });
    expect(r.category).toBe('unknown');
    expect(r.retryable).toBe(false);
  });

  it('no matching pattern, exit code 0 → unknown', () => {
    const r = classifyError({ errorText: 'some random log', exitCode: 0 });
    expect(r.category).toBe('unknown');
  });

  // ── summary truncation ────────────────────────────────────────
  it('truncates long summaries to 200 chars', () => {
    const long = 'A'.repeat(300);
    const r = classifyError({ errorText: long });
    expect(r.summary.length).toBe(200);
    expect(r.summary.endsWith('...')).toBe(true);
  });

  it('preserves short summaries as-is', () => {
    const r = classifyError({ errorText: 'short error' });
    expect(r.summary).toBe('short error');
  });

  // ── owner_conflict ────────────────────────────────────────────
  describe('owner_conflict — the backend refused before accepting the run', () => {
    it('the measured Codex writer conflict → owner_conflict', () => {
      const r = classifyError({ errorText: CODEX_WRITER_CONFLICT, backend: 'codex-cli' });
      expect(r.category).toBe('owner_conflict');
      expect(isPreAcceptanceRefusal(r.category)).toBe(true);
    });

    // Not a behaviour change: this text already classified `retryable: false`
    // (as `unknown`), so the retry scheduler sees what it saw before. Pinning
    // it because flipping it to true would re-resume a thread we have just
    // been told is held.
    it('is not retryable', () => {
      const r = classifyError({ errorText: CODEX_WRITER_CONFLICT, backend: 'codex-cli' });
      expect(r.retryable).toBe(false);
    });

    // The rule sits FIRST in the chain, ahead of `crash`. Without an explicit
    // exitCode the old chain fell through to `unknown`; with one it would have
    // been `crash`. Both readings said "this session died". Neither is true.
    it('wins over the exit-code crash rule', () => {
      const r = classifyError({
        errorText: CODEX_WRITER_CONFLICT,
        backend: 'codex-cli',
        exitCode: 1,
      });
      expect(r.category).toBe('owner_conflict');
    });

    it('matches the JSON-RPC resume refusal on its own', () => {
      const r = classifyError({
        errorText:
          'Error: thread/resume: thread/resume failed: thread 019d0180 already has an active writer (code -32600)',
      });
      expect(r.category).toBe('owner_conflict');
    });

    // Control: the new first-in-chain rule must not capture failures that
    // belong to other categories. Each of these would be misrouted — a
    // capacity failure classified as an owner conflict stops being retried,
    // and a genuine crash stops being recorded on the session it crashed.
    const untouched: Array<[string, ErrorCategory]> = [
      ['We are currently experiencing high demand.', 'capacity'],
      ['error: rate_limit_error — usage limit reached', 'quota'],
      ['[Process timed out after 300s idle]', 'timeout'],
      ['stream disconnected before completion: error sending request', 'network'],
      ['authentication_error: invalid api key', 'auth'],
      ['spawn codex ENOENT', 'config'],
      ['Killed: 9', 'crash'],
      ['some random log', 'unknown'],
    ];
    it.each(untouched)('leaves %j classified as %s', (errorText, expected) => {
      const r = classifyError({ errorText });
      expect(r.category).toBe(expected);
      expect(isPreAcceptanceRefusal(r.category)).toBe(false);
    });

    // "writer" in prose is not a refusal. The rule keys on the backend's own
    // signature, and a session that merely mentions the word must not be
    // treated as having refused the run.
    it('does not fire on incidental prose about writers or conflicts', () => {
      expect(
        classifyError({ errorText: 'the active writer role was reassigned in the doc' }).category
      ).not.toBe('owner_conflict');
      expect(classifyError({ errorText: 'merge conflict in thread-store.ts' }).category).not.toBe(
        'owner_conflict'
      );
    });
  });
});
