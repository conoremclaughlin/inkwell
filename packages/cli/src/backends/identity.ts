/**
 * Shared Identity Resolution
 *
 * Resolves agent identity for a CLI invocation. The identity prompt the
 * adapters hand a provider is built in @inklabs/shared/providers and
 * re-exported at the end of this file.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { lookupAgentBackend } from './agent-backend.js';

interface InkUserConfig {
  userId?: string;
  email?: string;
  sbMapping?: Record<string, string>;
  /** Pre-rename name for sbMapping. Still read; ~/.ink/config.json is the user's file. */
  agentMapping?: Record<string, string>;
}

export interface RuntimePreferences {
  toolRouting?: 'backend' | 'local';
  strictTools?: boolean;
  backendTimeoutSeconds?: number;
  approvalMode?: 'interactive' | 'jsonl' | 'auto-approve';
}

export interface IdentityJson {
  sbSlug: string;
  /**
   * Pre-rename name for sbSlug. Every .ink/identity.json on disk today carries
   * it, and nothing rewrites those files on upgrade, so it is read forever (or
   * until we decide to stop). readIdentityJson() normalizes it away, so no
   * caller downstream should ever look at this field.
   */
  agentId?: string;
  sbId?: string;
  context?: string;
  backend?: string;
  role?: string;
  studioId?: string;
  studio?: string;
  /** Persisted runtime preferences for ink chat */
  runtime?: RuntimePreferences;
}

/**
 * Fill sbSlug from the pre-rename agentId key, in place of nothing.
 *
 * .ink/identity.json is not rewritten on upgrade, and readIdentityJson is NOT
 * the only reader: studio, doctor, the studio list and the branch-rename
 * planner each parse the file themselves. Assuming a single funnel is what let
 * those four keep reading a key that legacy files do not have (Lumen, PR #635).
 * Exported so a raw parse can be made safe without being rerouted.
 */
export function normalizeIdentityJson<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as { sbSlug?: unknown; agentId?: unknown };
  return r.sbSlug === undefined && typeof r.agentId === 'string'
    ? ({ ...(raw as object), sbSlug: r.agentId } as T)
    : raw;
}

/**
 * Read .ink/identity.json from a directory. Returns null if not found/unparseable.
 */
export function readIdentityJson(cwd: string): IdentityJson | null {
  const identityPath = join(cwd, '.ink', 'identity.json');
  if (!existsSync(identityPath)) return null;
  try {
    const parsed: IdentityJson = JSON.parse(readFileSync(identityPath, 'utf-8'));
    // NOT the only reader of this file — studio (list, default CLI name,
    // branch-rename planning), doctor and the channel plugin each parse it
    // themselves. They call normalizeIdentityJson instead. Treating this as the
    // single funnel is what let those keep reading a key legacy files lack.
    if (!parsed.sbSlug && parsed.agentId) {
      return { ...parsed, sbSlug: parsed.agentId };
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save runtime preferences to .ink/identity.json.
 * Merges with existing content — only updates the `runtime` field.
 */
export function saveRuntimePreferences(cwd: string, prefs: RuntimePreferences): boolean {
  const identityPath = join(cwd, '.ink', 'identity.json');
  try {
    const existing = readIdentityJson(cwd) || ({} as Record<string, unknown>);
    const merged = { ...existing, runtime: { ...(existing.runtime || {}), ...prefs } };
    writeFileSync(identityPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read .ink/ROLE.md from a directory. Returns null if not found.
 * ROLE.md defines the studio's situational focus — what the agent is doing
 * in this context (e.g., reviewing, building, product thinking).
 */
export function readRoleMd(cwd: string): string | null {
  const rolePath = join(cwd, '.ink', 'ROLE.md');
  if (!existsSync(rolePath)) return null;
  try {
    const content = readFileSync(rolePath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Resolve an SB's slug from multiple sources:
 * 1. CLI --agent flag (if provided)
 * 2. SB_SLUG env var, or the pre-rename AGENT_ID (propagated by the ink
 *    launcher into backend/hook subprocesses)
 * 3. .ink/identity.json in current directory
 * 4. ~/.ink/config.json sbMapping (backend-aware when possible)
 * 5. null (no identity configured)
 */
export function resolveSlug(cliAgent?: string, backendHint?: string): string | null {
  if (cliAgent) {
    return cliAgent;
  }

  // AGENT_ID is still read because long-running processes started before the
  // rename (the main server among them) hold it in their environment, and a
  // subprocess they spawn inherits it.
  const envSlug = process.env.SB_SLUG?.trim() || process.env.AGENT_ID?.trim();
  if (envSlug) {
    return envSlug;
  }

  // process.cwd() throws ENOENT if the working directory has been deleted
  // (e.g., git worktree removed while a session was open)
  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    console.warn(
      'warning: could not read current directory — you may be in an orphan directory.\n' +
        '  Try: cd .. && cd -\n'
    );
  }

  if (cwd) {
    // Goes through readIdentityJson so the legacy `agentId` key is normalized
    // here too — this path used to parse the file itself and would have missed it.
    const identity = readIdentityJson(cwd);
    if (identity?.sbSlug) return identity.sbSlug;
  }

  const configPath = join(homedir(), '.ink', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config: InkUserConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      // ~/.ink/config.json belongs to the user and nothing rewrites it, so the
      // pre-rename key keeps working indefinitely.
      const mapping = config.sbMapping || config.agentMapping || {};

      const normalized = (backendHint || process.env.SB_BACKEND || process.env.INK_BACKEND || '')
        .toLowerCase()
        .trim();
      const backendKeyCandidates: string[] =
        normalized === 'claude' || normalized === 'claude-code'
          ? ['claude-code', 'claude']
          : normalized === 'codex' || normalized === 'codex-cli'
            ? ['codex-cli', 'codex']
            : normalized === 'gemini' || normalized === 'gemini-cli'
              ? ['gemini-cli', 'gemini']
              : [];

      for (const key of backendKeyCandidates) {
        if (mapping[key]) return mapping[key];
      }

      // Back-compat fallback for legacy single-agent setups.
      const fallbackKeys = ['claude-code', 'codex-cli', 'gemini-cli', 'claude', 'codex', 'gemini'];
      for (const key of fallbackKeys) {
        if (mapping[key]) return mapping[key];
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

export interface BackendResolution {
  backend: string;
  source: 'flag' | 'agent' | 'identity-json' | 'default';
  /** A line worth showing the user — currently only the unrunnable case. */
  note?: string;
}

/**
 * Resolve backend from multiple sources, most explicit first:
 * 1. CLI --backend flag
 * 2. The named agent's own backend, from their identity record
 * 3. .ink/identity.json → backend field
 * 4. Default: 'claude'
 *
 * The agent sits ABOVE identity.json deliberately. `-a lumen` is an explicit
 * request for Lumen; the directory's recorded backend describes whichever agent
 * that studio was made for, so letting it win would leave `ink -a lumen` inside
 * a wren studio starting claude — which is the bug this ordering fixes.
 */
export async function resolveBackend(options: {
  cliBackend?: string;
  agentSlug?: string;
}): Promise<BackendResolution> {
  if (options.cliBackend) {
    return { backend: options.cliBackend, source: 'flag' };
  }

  let note: string | undefined;
  if (options.agentSlug) {
    const lookup = await lookupAgentBackend(options.agentSlug);
    if (lookup.backend) {
      return { backend: lookup.backend, source: 'agent' };
    }
    if (lookup.unrunnable) {
      // Say it rather than quietly starting them on something else. Aster's
      // record says 'antigravity', which this CLI has no adapter for.
      note =
        `${options.agentSlug}'s identity record says backend '${lookup.unrunnable}', ` +
        `which this CLI cannot launch — falling back. Use -b to choose one.`;
    } else if (lookup.ambiguous) {
      // A slug is unique within one workspace, not globally. Picking one of
      // several identities would be a guess, and a silent one.
      note =
        `'${options.agentSlug}' names more than one identity, so their backend ` +
        `is ambiguous — falling back. Use -b to choose one.`;
    }
  }

  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    // Fall through to default
  }

  if (cwd) {
    const identity = readIdentityJson(cwd);
    if (identity?.backend) return { backend: identity.backend, source: 'identity-json', note };
  }

  return { backend: 'claude', source: 'default', note };
}

// The prompt itself belongs to every host that spawns a provider, so it lives
// with the providers; resolving which SB and backend a CLI invocation means
// stays here.
export { buildIdentityPrompt, createIdentityPromptFile } from '@inklabs/shared/providers';
