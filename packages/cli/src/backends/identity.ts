/**
 * Shared Identity Resolution
 *
 * Resolves agent identity and builds the identity prompt.
 * Used by all backend adapters.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
}

export interface IdentityJson {
  agentId: string;
  identityId?: string;
  context?: string;
  backend?: string;
  role?: string;
  studioId?: string;
  studio?: string;
  /** @deprecated Use studioId */
  workspaceId?: string;
  /** @deprecated Use studio */
  workspace?: string;
}

/**
 * Read .pcp/identity.json from a directory. Returns null if not found/unparseable.
 */
export function readIdentityJson(cwd: string): IdentityJson | null {
  const identityPath = join(cwd, '.pcp', 'identity.json');
  if (!existsSync(identityPath)) return null;
  try {
    return JSON.parse(readFileSync(identityPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Read .pcp/ROLE.md from a directory. Returns null if not found.
 * ROLE.md defines the studio's situational focus — what the agent is doing
 * in this context (e.g., reviewing, building, product thinking).
 */
export function readRoleMd(cwd: string): string | null {
  const rolePath = join(cwd, '.pcp', 'ROLE.md');
  if (!existsSync(rolePath)) return null;
  try {
    const content = readFileSync(rolePath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Resolve agent ID from multiple sources:
 * 1. CLI --agent flag (if provided)
 * 2. AGENT_ID env var (propagated by sb launcher into backend/hook subprocesses)
 * 3. .pcp/identity.json in current directory
 * 4. ~/.pcp/config.json agentMapping (backend-aware when possible)
 * 5. null (no identity configured)
 */
export function resolveAgentId(cliAgent?: string, backendHint?: string): string | null {
  if (cliAgent) {
    return cliAgent;
  }

  const envAgent = process.env.AGENT_ID?.trim();
  if (envAgent) {
    return envAgent;
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
    const localIdentity = join(cwd, '.pcp', 'identity.json');
    if (existsSync(localIdentity)) {
      try {
        const identity: IdentityJson = JSON.parse(readFileSync(localIdentity, 'utf-8'));
        if (identity.agentId) return identity.agentId;
      } catch {
        /* ignore */
      }
    }
  }

  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config: PcpConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      const mapping = config.agentMapping || {};

      const normalized = (backendHint || process.env.SB_BACKEND || process.env.PCP_BACKEND || '')
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

/**
 * Resolve backend from multiple sources:
 * 1. CLI --backend flag (if provided)
 * 2. .pcp/identity.json → backend field
 * 3. Default: 'claude'
 */
export function resolveBackend(cliBackend?: string): string {
  if (cliBackend) {
    return cliBackend;
  }

  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    // Fall through to default
  }

  if (cwd) {
    const identity = readIdentityJson(cwd);
    if (identity?.backend) return identity.backend;
  }

  return 'claude';
}

/**
 * Build the identity prompt content. Same across all backends.
 */
export function buildIdentityPrompt(agentId: string, startupContextBlock?: string): string {
  const basePrompt = `## Identity Override (CRITICAL)

**You are ${agentId}. Your agent ID is \`${agentId}\`.**

When calling PCP tools (bootstrap, remember, recall, update_session_phase, etc.), use \`agentId: "${agentId}"\`.
Do NOT read \`.pcp/identity.json\` — your identity is set by this system prompt.
Do NOT run \`echo $AGENT_ID\` — use the agentId provided above.

Skip directly to loading user config from ~/.pcp/config.json and bootstrap as "${agentId}".

## Tool Priority (IMPORTANT)

Always use **PCP cloud tools** (mcp__pcp__*) over file reads or Claude Code builtins:
- Identity: use mcp__pcp__bootstrap, not file reads
- Tasks: use mcp__pcp__create_task, not TaskCreate
- Memory: use mcp__pcp__remember, not local notes
- Sessions: use mcp__pcp__update_session_phase/get_session/list_sessions

PCP tools persist across sessions and are shared with the user and other agents.`;

  const injectedContext = startupContextBlock?.trim();
  if (!injectedContext) return basePrompt;

  return `${basePrompt}

## Bootstrapped Startup Context (PCP)

${injectedContext}`;
}

/**
 * Write the identity prompt to a temp file.
 * Returns the file path and a cleanup function.
 */
export function createIdentityPromptFile(
  agentId: string,
  startupContextBlock?: string
): {
  promptFile: string;
  cleanup: () => void;
} {
  const content = buildIdentityPrompt(agentId, startupContextBlock);
  const tempDir = mkdtempSync(join(tmpdir(), 'sb-'));
  const promptFile = join(tempDir, 'identity-prompt.md');
  writeFileSync(promptFile, content);

  return {
    promptFile,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true });
      } catch {
        /* ignore */
      }
    },
  };
}
