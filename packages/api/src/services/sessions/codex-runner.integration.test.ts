/**
 * CodexRunner E2E Integration Test
 *
 * This test invokes the real Codex CLI and therefore requires:
 * - codex installed
 * - codex login (or API-key login) configured
 *
 * It is gated behind RUN_CODEX_E2E=1 to avoid accidental usage/cost.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { CodexRunner } from './codex-runner.js';

let shouldRun = false;
let skipReason = '';

describe('CodexRunner E2E (real codex cli)', () => {
  beforeAll(() => {
    if (process.env.RUN_CODEX_E2E !== '1') {
      skipReason = 'Set RUN_CODEX_E2E=1 to run real Codex E2E tests';
      // eslint-disable-next-line no-console
      console.warn(`[codex-e2e] Skipping: ${skipReason}`);
      return;
    }

    try {
      execSync('codex --version', { stdio: 'pipe' });
    } catch {
      skipReason = 'codex binary is not installed';
      // eslint-disable-next-line no-console
      console.warn(`[codex-e2e] Skipping: ${skipReason}`);
      return;
    }

    try {
      // codex currently prints login status to stderr, so capture both streams
      const status = execSync('codex login status 2>&1', { stdio: 'pipe', encoding: 'utf-8' });
      const loggedIn = /logged in/i.test(status);
      if (!loggedIn) {
        skipReason = 'codex login is required (run `codex login` or `codex login --with-api-key`)';
        // eslint-disable-next-line no-console
        console.warn(`[codex-e2e] Skipping: ${skipReason}`);
        return;
      }
    } catch {
      skipReason = 'codex login status check failed';
      // eslint-disable-next-line no-console
      console.warn(`[codex-e2e] Skipping: ${skipReason}`);
      return;
    }

    shouldRun = true;
  });

  it('can run a simple prompt via real codex exec --json', async () => {
    if (!shouldRun) {
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }

    const runner = new CodexRunner();
    const result = await runner.run('Reply with exactly: CODEX_E2E_OK', {
      config: {
        workingDirectory: process.cwd(),
        mcpConfigPath: '',
        model: process.env.CODEX_E2E_MODEL || 'gpt-5-codex',
        appendSystemPrompt: 'You are running an integration test. Keep responses brief.',
      },
    });

    expect(result.success).toBe(true);
    expect(typeof result.backendSessionId).toBe('string');
    expect(result.backendSessionId.length).toBeGreaterThan(0);
    expect(result.finalTextResponse).toBeTruthy();
  });
});
