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

interface IdentityJson {
  agentId: string;
  context?: string;
}

/**
 * Resolve agent ID from multiple sources:
 * 1. CLI --agent flag (if explicitly changed from default)
 * 2. .pcp/identity.json in current directory
 * 3. ~/.pcp/config.json agentMapping
 * 4. Default: 'wren'
 */
export function resolveAgentId(cliAgent?: string): string {
  if (cliAgent && cliAgent !== 'wren') {
    return cliAgent;
  }

  const localIdentity = join(process.cwd(), '.pcp', 'identity.json');
  if (existsSync(localIdentity)) {
    try {
      const identity: IdentityJson = JSON.parse(readFileSync(localIdentity, 'utf-8'));
      if (identity.agentId) return identity.agentId;
    } catch { /* ignore */ }
  }

  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config: PcpConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.agentMapping?.['claude-code']) return config.agentMapping['claude-code'];
    } catch { /* ignore */ }
  }

  return cliAgent || 'wren';
}

/**
 * Build the identity prompt content. Same across all backends.
 */
export function buildIdentityPrompt(agentId: string): string {
  return `## Identity Override (CRITICAL)

**You are ${agentId}. Your agent ID is \`${agentId}\`.**

When calling PCP tools (bootstrap, remember, recall, start_session, etc.), use \`agentId: "${agentId}"\`.
Do NOT read \`.pcp/identity.json\` — your identity is set by this system prompt.
Do NOT run \`echo $AGENT_ID\` — use the agentId provided above.

Skip directly to loading user config from ~/.pcp/config.json and bootstrap as "${agentId}".

## Tool Priority (IMPORTANT)

Always use **PCP cloud tools** (mcp__pcp__*) over file reads or Claude Code builtins:
- Identity: use mcp__pcp__bootstrap, not file reads
- Tasks: use mcp__pcp__create_task, not TaskCreate
- Memory: use mcp__pcp__remember, not local notes
- Sessions: use mcp__pcp__start_session/log_session/end_session

PCP tools persist across sessions and are shared with the user and other agents.`;
}

/**
 * Write the identity prompt to a temp file.
 * Returns the file path and a cleanup function.
 */
export function createIdentityPromptFile(agentId: string): { promptFile: string; cleanup: () => void } {
  const content = buildIdentityPrompt(agentId);
  const tempDir = mkdtempSync(join(tmpdir(), 'sb-'));
  const promptFile = join(tempDir, 'identity-prompt.md');
  writeFileSync(promptFile, content);

  return {
    promptFile,
    cleanup: () => {
      try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    },
  };
}
