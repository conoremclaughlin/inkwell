/**
 * Claude Command
 *
 * Wraps Claude Code CLI with PCP integration:
 * - Identity injection via --append-system-prompt
 * - Session tracking via PCP API
 * - Passthrough of all Claude Code args
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import chalk from 'chalk';

interface ClaudeOptions {
  agent: string;
  model: string;
  session: boolean;
  verbose: boolean;
}

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
 * 1. CLI --agent flag
 * 2. .pcp/identity.json in current directory
 * 3. ~/.pcp/config.json agentMapping
 * 4. Default: 'wren'
 */
function resolveAgentId(cliAgent?: string): string {
  // 1. CLI flag takes precedence
  if (cliAgent && cliAgent !== 'wren') {
    return cliAgent;
  }

  // 2. Check local .pcp/identity.json
  const localIdentity = join(process.cwd(), '.pcp', 'identity.json');
  if (existsSync(localIdentity)) {
    try {
      const identity: IdentityJson = JSON.parse(readFileSync(localIdentity, 'utf-8'));
      if (identity.agentId) {
        return identity.agentId;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 3. Check ~/.pcp/config.json
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config: PcpConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.agentMapping?.['claude-code']) {
        return config.agentMapping['claude-code'];
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 4. Default
  return cliAgent || 'wren';
}

/**
 * Build the identity prompt for Claude
 */
function buildIdentityPrompt(agentId: string): string {
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
 * Run Claude Code with PCP integration
 */
export async function runClaude(prompt: string, options: ClaudeOptions): Promise<void> {
  const agentId = resolveAgentId(options.agent);

  if (options.verbose) {
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
    console.log(chalk.dim(`Session tracking: ${options.session}`));
  }

  // Build identity prompt and write to temp file
  const identityPrompt = buildIdentityPrompt(agentId);
  const tempDir = mkdtempSync(join(tmpdir(), 'pcp-'));
  const promptFile = join(tempDir, 'identity-prompt.md');
  writeFileSync(promptFile, identityPrompt);

  // Build Claude Code args
  const args: string[] = [
    '-p',
    '--model', options.model,
    '--append-system-prompt', promptFile,
  ];

  // Find MCP config
  const mcpConfig = join(process.cwd(), '.mcp.json');
  if (existsSync(mcpConfig)) {
    args.push('--mcp-config', mcpConfig);
  }

  // Add prompt
  args.push(prompt);

  if (options.verbose) {
    console.log(chalk.dim(`Running: claude ${args.join(' ')}`));
  }

  // Spawn Claude Code
  const claude = spawn('claude', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_ID: agentId,
    },
  });

  // Cleanup on exit
  claude.on('close', (code) => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    if (code !== 0) {
      process.exit(code || 1);
    }
  });

  // Handle signals
  process.on('SIGINT', () => {
    claude.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    claude.kill('SIGTERM');
  });
}

/**
 * Run Claude Code interactively (no -p flag)
 */
export async function runClaudeInteractive(options: ClaudeOptions): Promise<void> {
  const agentId = resolveAgentId(options.agent);

  if (options.verbose) {
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
  }

  // Build identity prompt and write to temp file
  const identityPrompt = buildIdentityPrompt(agentId);
  const tempDir = mkdtempSync(join(tmpdir(), 'pcp-'));
  const promptFile = join(tempDir, 'identity-prompt.md');
  writeFileSync(promptFile, identityPrompt);

  // Build Claude Code args (no -p for interactive)
  const args: string[] = [
    '--model', options.model,
    '--append-system-prompt', promptFile,
  ];

  // Find MCP config
  const mcpConfig = join(process.cwd(), '.mcp.json');
  if (existsSync(mcpConfig)) {
    args.push('--mcp-config', mcpConfig);
  }

  if (options.verbose) {
    console.log(chalk.dim(`Running: claude ${args.join(' ')}`));
  }

  // Spawn Claude Code interactively
  const claude = spawn('claude', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_ID: agentId,
    },
  });

  // Cleanup on exit
  claude.on('close', (code) => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    process.exit(code || 0);
  });
}
