import { readConfig, validateInput, LIMITS } from './config.js';
import { claudeArgs, ClaudeSearchStream, verifyCapabilities } from './claude.js';
import { staticError, WebSearchError } from './errors.js';
import { assertUnmanagedHost, createSandbox, resolveExecutable } from './isolation.js';
import { runBounded } from './process.js';
import type { WebSearchInput, WebSearchOutput } from './types.js';
import { searchAdmission } from './admission.js';

export { WebSearchError } from './errors.js';
export type { WebSearchReason } from './errors.js';
export type { WebSearchInput, WebSearchOutput } from './types.js';

/**
 * Dark by default, operator-only config. Caller input cannot select a provider,
 * executable, model, credential, settings, permission mode, or environment.
 * Deliberately separate from session runners: no identity, DB, MCP, or resume.
 * The caller must record its required audit BEFORE invoking this function.
 */
export async function searchWeb(input: WebSearchInput): Promise<WebSearchOutput> {
  let launched = false;
  try {
    const config = readConfig(process.env);
    const request = validateInput(input);
    const admission = searchAdmission.acquire();
    try {
      await assertUnmanagedHost();
      const executable = await resolveExecutable(config.executable);
      const sandbox = await createSandbox();
      try {
        const started = Date.now();
        const remaining = () => {
          if (request.signal?.aborted) throw new WebSearchError('cancelled');
          const ms = LIMITS.timeoutMs - (Date.now() - started);
          if (ms <= 0) throw new WebSearchError('timeout');
          return ms;
        };
        const probe = (flag: string) =>
          runBounded({
            executable,
            args: ['--bare', flag],
            cwd: sandbox.cwd,
            env: { ...sandbox.env, CLAUDE_CODE_SIMPLE: '1' },
            stdin: '',
            signal: request.signal,
            timeoutMs: Math.min(LIMITS.probeTimeoutMs, remaining()),
            stdoutBytes: 64 * 1024,
          });
        // No credentials or query reach even the capability probes.
        const version = await probe('--version');
        const help = await probe('--help');
        verifyCapabilities(version, help);
        remaining(); // A cancellation during either capability probe stays credential-free.
        await assertUnmanagedHost();
        const timeoutMs = remaining(); // Recheck after the final asynchronous preflight.
        const stream = new ClaudeSearchStream(config.model, request.maxResults);
        const args = claudeArgs(config, sandbox);
        // From this call onward, failures (including cleanup) may follow an
        // external search. Credential-free probes above never set this bit.
        launched = true;
        await runBounded({
          executable,
          args,
          cwd: sandbox.cwd,
          // This pinned CLI treats an explicitly empty secure-storage selector
          // as the default macOS keychain namespace, independent of fresh config.
          // The file fallback remains in the disposable HOME. Do not inherit or
          // extract tokens, or retry with the caller's actual config directory.
          env: { ...sandbox.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
          stdin: JSON.stringify({ query: request.query, maxResults: request.maxResults }) + '\n',
          signal: request.signal,
          timeoutMs,
          onLine: (line) => stream.accept(line),
        });
        return stream.output();
      } catch (error) {
        // Set the latch BEFORE cleanup, which can itself fail. No caller can
        // release this capacity or admit another child after an uncertain stop.
        if (error instanceof WebSearchError && error.reason === 'stop_unconfirmed') {
          admission.quarantine();
        }
        throw error;
      } finally {
        await sandbox.cleanup();
      }
    } finally {
      admission.release();
    }
  } catch (error) {
    throw new WebSearchError(staticError(error).reason, launched);
  }
}
