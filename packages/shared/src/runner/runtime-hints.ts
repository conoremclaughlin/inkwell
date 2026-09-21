/**
 * Runtime Session Hints
 *
 * Writes session state to .ink/runtime/sessions.json so the on-session-start
 * hook can find the correct Inkwell session ID for server-spawned runs.
 *
 * Without these hints, the hook picks up the last sb-launched session (wrong)
 * instead of the server-triggered one.
 *
 * Used by both API server runners (claude-runner, codex-runner) and
 * potentially CLI flows that need to seed session identity before spawning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface RuntimeSessionState {
  version: 1;
  current?: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
}

/**
 * Write a runtime session hint so the on-session-start hook can resolve
 * the correct Inkwell session ID for a spawned backend process.
 *
 * Best-effort: silently catches errors since the hook has fallbacks.
 */
export function writeRuntimeSessionHint(
  workingDirectory: string,
  inkSessionId: string,
  sbSlug: string,
  backend: string,
  runtimeLinkId: string,
  studioId?: string
): void {
  try {
    const runtimeDir = join(workingDirectory, '.ink', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });

    const sessionsPath = join(runtimeDir, 'sessions.json');
    let state: RuntimeSessionState = { version: 1, sessions: [] };

    if (existsSync(sessionsPath)) {
      try {
        const raw = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as RuntimeSessionState;
        if (raw.version === 1 && Array.isArray(raw.sessions)) {
          // Independent raw reader of the same file as the CLI's
          // readRuntimeState, with the same defect: records written before the
          // rename carry `agentId`, the match below keys on sbSlug, and an
          // un-normalized record is duplicated rather than merged
          // (Lumen, PR #635).
          //
          // #659 renamed pcpSessionId -> inkSessionId and reproduced that
          // defect one field over: rows on disk key the session id under the
          // old name, so the match below misses them and the reader's type
          // guard drops them outright — losing backend lineage on the next
          // upsert. Both migrations live in one table now, so the next rename
          // adds a row here rather than a third copy of this shape.
          const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
            ['agentId', 'sbSlug'],
            ['pcpSessionId', 'inkSessionId'],
          ];
          const withSlug = (row: Record<string, unknown>): Record<string, unknown> => {
            if (!row || typeof row !== 'object') return row;
            let out = row;
            for (const [legacy, current] of LEGACY_KEYS) {
              if (out[current] === undefined && typeof out[legacy] === 'string') {
                out = { ...out, [current]: out[legacy] };
              }
            }
            return out;
          };
          state = {
            ...raw,
            sessions: raw.sessions.map((s) =>
              withSlug(s as Record<string, unknown>)
            ) as typeof raw.sessions,
            ...(raw.current
              ? {
                  current: withSlug(
                    raw.current as unknown as Record<string, unknown>
                  ) as typeof raw.current,
                }
              : {}),
          };
        }
      } catch {
        // Corrupt file — start fresh.
      }
    }

    const now = new Date().toISOString();
    const record: Record<string, unknown> = {
      inkSessionId,
      backend,
      sbSlug,
      runtimeLinkId,
      ...(studioId ? { studioId } : {}),
      updatedAt: now,
      startedAt: now,
    };

    const idx = state.sessions.findIndex(
      (s) =>
        s['inkSessionId'] === inkSessionId && s['backend'] === backend && s['sbSlug'] === sbSlug
    );
    if (idx >= 0) {
      state.sessions[idx] = { ...state.sessions[idx], ...record };
    } else {
      state.sessions.push(record);
    }

    state.current = {
      inkSessionId,
      backend,
      sbSlug,
      ...(studioId ? { studioId } : {}),
      updatedAt: now,
    };
    writeFileSync(sessionsPath, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort only — hook will fall back to sessions.json current pointer.
  }
}
