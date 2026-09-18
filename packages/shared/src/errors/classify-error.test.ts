import { describe, expect, it } from 'vitest';
import { classifyError } from './classify-error.js';

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
});
