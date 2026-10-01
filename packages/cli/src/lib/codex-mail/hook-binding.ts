import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCodexMailHookScope } from './hook-scope.js';

export const CODEX_MAIL_BINDING_ENV = 'INK_CODEX_INKMAIL_BINDING';

type Scope = { sessionId: string; studioId: string; sbSlug: string };

/** A fresh per-wrapper file, never a guessed thread or a reusable studio marker.
 * Before the native start/resume response there is no binding: SessionStart
 * stays inert and the wrapper's startup injection/onBound owns the linkage. */
export function createCodexMailHookBinding({ sessionId, studioId, sbSlug }: Scope) {
  const directory = mkdtempSync(join(tmpdir(), 'ink-mail-hooks-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'binding.json');
  let bound: string | undefined;
  let revoked = false;
  return {
    env: { [CODEX_MAIL_BINDING_ENV]: path },
    bind(threadId: string) {
      if (revoked) throw new Error('Codex hook binding is revoked');
      if (bound === threadId) return;
      if (bound || !threadId) throw new Error('Codex hook binding cannot change threads');
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          sessionId,
          studioId,
          sbSlug,
          threadId,
          ownerPid: process.pid,
        }),
        {
          flag: 'wx',
          mode: 0o600,
        }
      );
      bound = threadId;
    },
    revoke() {
      revoked = true;
      rmSync(path, { force: true });
    },
    dispose() {
      revoked = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Environment alone is inherited by tool children and in-process subagents.
 * Admit only the exact thread in the hook payload, before reconciling any IDs.
 * Like the context token, this is routing evidence, not adversarial auth. */
export function admitsCodexMailHook(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isCodexMailHookScope(env) || typeof payload?.session_id !== 'string') return false;
  // Measured on 0.159.2: subagent UserPromptSubmit reuses the parent's
  // session_id, but carries agent_id/agent_type. Thread equality alone admits
  // it and would claim the parent's epoch. Never admit subagent payloads.
  if ('agent_id' in payload || 'agent_type' in payload || 'agent_transcript_path' in payload)
    return false;
  const path = env[CODEX_MAIL_BINDING_ENV];
  if (!path) return false;
  try {
    const binding = JSON.parse(readFileSync(path, 'utf8'));
    if (
      binding.version !== 1 ||
      binding.threadId !== payload.session_id ||
      binding.sessionId !== env.INK_SESSION_ID ||
      binding.studioId !== env.INK_STUDIO_ID ||
      binding.sbSlug !== env.SB_SLUG ||
      !Number.isSafeInteger(binding.ownerPid) ||
      binding.ownerPid <= 0
    )
      return false;
    // Abrupt wrapper death may leave a file, never a live hook authorization.
    process.kill(binding.ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}
