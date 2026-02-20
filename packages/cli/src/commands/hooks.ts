/**
 * Hooks Commands
 *
 * Bridge CLI coding agents (Claude Code, Codex, Gemini) with PCP's
 * session/memory/inbox system via lifecycle hooks.
 *
 * Commands:
 *   hooks install     Install PCP hooks into the detected backend
 *   hooks uninstall   Remove PCP-managed hooks
 *   hooks status      Show installed hook status
 *   hooks pre-compact         Hook: pre-compaction reminder
 *   hooks post-compact        Hook: post-compaction bootstrap
 *   hooks on-session-start    Hook: session start bootstrap
 *   hooks on-prompt           Hook: periodic inbox check
 *   hooks on-stop             Hook: session nudge + inbox check
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { resolveAgentId, readIdentityJson } from '../backends/identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Types
// ============================================================================

interface HookCapabilities {
  name: string;
  configPath: string;
  configFormat: 'json' | 'toml';
  events: {
    sessionStart: string | null;
    preCompact: string | null;
    postCompact: string | null;
    onPrompt: string | null;
    onStop: string | null;
  };
  supportsCompaction: boolean;
  supportsPromptHook: boolean;
}

const CLAUDE_CODE: HookCapabilities = {
  name: 'claude-code',
  configPath: '.claude/settings.local.json',
  configFormat: 'json',
  events: {
    sessionStart: 'SessionStart',
    preCompact: 'PreCompact',
    postCompact: 'SessionStart', // uses "compact" matcher on SessionStart
    onPrompt: 'UserPromptSubmit',
    onStop: 'Stop',
  },
  supportsCompaction: true,
  supportsPromptHook: true,
};

const CODEX: HookCapabilities = {
  name: 'codex',
  configPath: '.codex/config.toml',
  configFormat: 'toml',
  events: {
    sessionStart: 'SessionStart',
    preCompact: null,
    postCompact: null,
    onPrompt: 'UserPromptSubmit',
    onStop: 'AfterAgent',
  },
  supportsCompaction: false,
  supportsPromptHook: true,
};

const GEMINI: HookCapabilities = {
  name: 'gemini',
  configPath: '.gemini/settings.json',
  configFormat: 'json',
  events: {
    sessionStart: 'SessionStart',
    preCompact: 'PreCompress',
    postCompact: null,
    onPrompt: null,
    onStop: 'AfterAgent',
  },
  supportsCompaction: true,
  supportsPromptHook: false,
};

interface PcpConfig {
  userId?: string;
  email?: string;
}

// ============================================================================
// Backend Detection
// ============================================================================

function detectBackend(cwd: string): HookCapabilities {
  // 1. Check .pcp/identity.json for explicit backend
  const identity = readIdentityJson(cwd);
  if (identity?.backend) {
    const fromIdentity = getBackendByName(identity.backend);
    if (fromIdentity) return fromIdentity;
  }

  // 2. Fallback to filesystem detection
  if (existsSync(join(cwd, '.claude'))) return CLAUDE_CODE;
  if (existsSync(join(cwd, '.gemini'))) return GEMINI;
  if (existsSync(join(cwd, 'codex.toml')) || existsSync(join(cwd, '.codex'))) return CODEX;
  return CLAUDE_CODE; // default
}

function getBackendByName(name: string): HookCapabilities {
  switch (name.toLowerCase()) {
    case 'claude':
    case 'claude-code':
      return CLAUDE_CODE;
    case 'codex':
      return CODEX;
    case 'gemini':
      return GEMINI;
    default:
      return CLAUDE_CODE;
  }
}

// ============================================================================
// Git Worktree Discovery
// ============================================================================

function listWorktreePaths(cwd: string): string[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  } catch {
    return [cwd]; // fallback to current directory
  }
}

// ============================================================================
// Stdin Parsing
// ============================================================================

async function readStdin(): Promise<Record<string, unknown>> {
  // If stdin is a TTY (interactive), return empty object
  if (process.stdin.isTTY) return {};

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    // Timeout after 100ms if no data
    setTimeout(() => {
      if (!data) resolve({});
    }, 100);
  });
}

// ============================================================================
// PCP Client Helper
// ============================================================================

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

let jsonRpcId = 1;

async function callPcpTool(
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${getPcpServerUrl()}/mcp`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: args },
      id: jsonRpcId++,
    }),
  });

  if (!response.ok) {
    throw new Error(`PCP call failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  // JSON-RPC error
  if (payload.error) {
    const err = payload.error as { message?: string; code?: number };
    throw new Error(`PCP tool error (${err.code}): ${err.message}`);
  }

  // Unwrap JSON-RPC result → MCP tool response → content text
  const result = payload.result as { content?: Array<{ text?: string }> } | undefined;
  const mcpText = result?.content?.[0]?.text;

  if (typeof mcpText === 'string') {
    try {
      return JSON.parse(mcpText) as Record<string, unknown>;
    } catch {
      return { text: mcpText };
    }
  }

  return (result as Record<string, unknown>) ?? payload;
}

// ============================================================================
// Runtime State Helpers
// ============================================================================

function getRuntimeDir(cwd: string): string {
  return join(cwd, '.pcp', 'runtime');
}

function ensureRuntimeDir(cwd: string): string {
  const dir = getRuntimeDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readRuntimeFile(cwd: string, filename: string): string | null {
  const filePath = join(getRuntimeDir(cwd), filename);
  if (existsSync(filePath)) {
    try {
      return readFileSync(filePath, 'utf-8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function writeRuntimeFile(cwd: string, filename: string, content: string): void {
  const dir = ensureRuntimeDir(cwd);
  writeFileSync(join(dir, filename), content);
}

// ============================================================================
// Template Loading
// ============================================================================

function loadTemplate(name: string): string {
  // Try compiled output path first
  const distPath = join(__dirname, '..', 'templates', `${name}.md`);
  if (existsSync(distPath)) return readFileSync(distPath, 'utf-8');

  // Fallback: source tree (development)
  const srcPath = join(__dirname, '..', '..', 'src', 'templates', `${name}.md`);
  if (existsSync(srcPath)) return readFileSync(srcPath, 'utf-8');

  throw new Error(`Template not found: ${name}`);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // Clean up empty placeholder lines (blocks that had no data)
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================================
// Shared Block Builders
// ============================================================================

function buildIdentityBlock(identity: unknown): string {
  if (!identity) return '';
  return `### Identity\n\`\`\`json\n${JSON.stringify(identity, null, 2)}\n\`\`\``;
}

function buildInboxBlock(messages: Array<Record<string, unknown>> | undefined): string {
  if (!messages || messages.length === 0) return '';
  const lines = [`### Inbox (${messages.length} message${messages.length === 1 ? '' : 's'})`];
  for (const msg of messages) {
    lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
  }
  return lines.join('\n');
}

function buildInboxTag(messages: Array<Record<string, unknown>> | undefined): string {
  if (!messages || messages.length === 0) return '';
  const lines = [`<pcp-inbox count="${messages.length}">`];
  for (const msg of messages) {
    lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
  }
  lines.push('</pcp-inbox>');
  return lines.join('\n');
}

function buildMemoriesBlock(memories: Array<Record<string, unknown>> | undefined): string {
  if (!memories || memories.length === 0) return '';
  const lines = ['### Recent Memories'];
  for (const mem of memories.slice(0, 5)) {
    lines.push(`- ${mem.content || mem.key || JSON.stringify(mem)}`);
  }
  return lines.join('\n');
}

function buildSessionsBlock(sessions: Array<Record<string, unknown>> | undefined): string {
  if (!sessions || sessions.length === 0) return '';
  const lines = ['### Active Sessions'];
  for (const s of sessions) {
    lines.push(
      `- ${(s.id as string)?.substring(0, 8) || 'unknown'}: ${s.summary || s.status || 'active'}`
    );
  }
  return lines.join('\n');
}

// ============================================================================
// Install / Uninstall / Status
// ============================================================================

/** Marker used to identify PCP-managed hook entries */
const PCP_MARKER = 'pcp-managed';

/**
 * Resolve absolute path to the `sb` CLI binary from the main worktree's
 * node_modules/.bin/sb. This ensures hooks work from PM2 and other
 * environments where ~/.local/bin may not be in PATH.
 */
function resolveSbBinaryPath(cwd: string): string {
  const worktrees = listWorktreePaths(cwd);
  const mainWorktree = worktrees[0] || cwd;
  const binPath = join(mainWorktree, 'node_modules', '.bin', 'sb');
  if (existsSync(binPath)) return binPath;
  // Fallback: bare `sb` (relies on PATH)
  return 'sb';
}

/** Check if a hook command is PCP-managed (handles both bare `sb` and absolute paths) */
function isPcpHookCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  // Match bare `sb hooks ...` or `/abs/path/to/sb hooks ...`
  return /\bsb hooks /.test(cmd);
}

type InstallResult = 'installed' | 'already-installed' | 'conflict';

function buildClaudeCodeHooks(sbPath: string): Record<string, unknown> {
  return {
    hooks: {
      PreCompact: [
        {
          hooks: [{ type: 'command', command: `${sbPath} hooks pre-compact` }],
        },
      ],
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [{ type: 'command', command: `${sbPath} hooks post-compact` }],
        },
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: `${sbPath} hooks on-session-start` }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: `${sbPath} hooks on-prompt` }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: `${sbPath} hooks on-stop` }],
        },
      ],
    },
  };
}

/** Check if existing Claude Code hooks already match the PCP hooks we'd write */
function claudeCodeHooksMatch(existing: Record<string, unknown>, cwd: string): boolean {
  const sbPath = resolveSbBinaryPath(cwd);
  const target = buildClaudeCodeHooks(sbPath);
  const existingHooksStr = JSON.stringify(existing.hooks);
  const targetHooksStr = JSON.stringify(target.hooks);
  return existingHooksStr === targetHooksStr;
}

function installClaudeCode(cwd: string, force: boolean): InstallResult {
  const configPath = join(cwd, CLAUDE_CODE.configPath);
  const configDir = join(cwd, '.claude');
  mkdirSync(configDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // overwrite if unparseable
    }
  }

  // Check for existing hooks
  const existingHooks = existing.hooks as Record<string, unknown> | undefined;
  if (existingHooks && !force) {
    // Check if PCP hooks already match exactly
    if (claudeCodeHooksMatch(existing, cwd)) {
      return 'already-installed';
    }

    // Check if any non-PCP hooks exist
    const hasNonPcpHooks = Object.entries(existingHooks).some(([, entries]) => {
      if (!Array.isArray(entries)) return false;
      return entries.some((entry: Record<string, unknown>) => {
        const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
        if (!hooks) return false;
        return hooks.some((h) => !isPcpHookCommand(h.command as string | undefined));
      });
    });

    if (hasNonPcpHooks) {
      return 'conflict';
    }
  }

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpHooks = buildClaudeCodeHooks(sbPath);

  // Merge: keep existing non-hooks settings, replace hooks
  const merged = { ...existing, ...pcpHooks };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return 'installed';
}

function installGemini(cwd: string, force: boolean): InstallResult {
  const configDir = join(cwd, '.gemini');
  const configPath = join(cwd, GEMINI.configPath);
  mkdirSync(configDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // overwrite
    }
  }

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpHooks: Record<string, unknown> = {
    [GEMINI.events.sessionStart!]: [{ command: `${sbPath} hooks on-session-start` }],
    [GEMINI.events.onStop!]: [{ command: `${sbPath} hooks on-stop` }],
    [GEMINI.events.preCompact!]: [{ command: `${sbPath} hooks pre-compact` }],
  };

  if (existing.hooks && !force) {
    // Check if our hooks are already there
    const hooksObj = existing.hooks as Record<string, unknown>;
    const allPresent = Object.entries(pcpHooks).every(([event, targetEntries]) => {
      const existingEntries = hooksObj[event];
      if (!Array.isArray(existingEntries)) return false;
      const targetCmd = (targetEntries as any)[0].command;
      return existingEntries.some((h: any) => h.command === targetCmd);
    });

    if (allPresent) {
      return 'already-installed';
    }

    // Check for any non-PCP hooks in these specific events
    const hasConflict = Object.keys(pcpHooks).some((event) => {
      const entries = hooksObj[event];
      if (!Array.isArray(entries)) return false;
      return entries.some((h: any) => !isPcpHookCommand(h.command));
    });

    if (hasConflict) {
      return 'conflict';
    }
  }

  const merged = {
    ...existing,
    hooks: {
      ...(existing.hooks as Record<string, unknown> || {}),
      ...pcpHooks,
    },
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return 'installed';
}

function installCodex(cwd: string, force: boolean): InstallResult {
  const configDir = join(cwd, '.codex');
  const configPath = join(cwd, CODEX.configPath);
  mkdirSync(configDir, { recursive: true });

  let existingContent = '';
  if (existsSync(configPath)) {
    existingContent = readFileSync(configPath, 'utf-8');
  }

  if (existingContent.includes(PCP_MARKER) && !force) {
    return 'already-installed';
  }

  if (existingContent.includes('[hooks]') && !existingContent.includes(PCP_MARKER) && !force) {
    return 'conflict';
  }

  // Remove existing PCP-managed hooks section if present
  const cleaned = removePcpTomlSection(existingContent);

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpSection = [
    '',
    `# ${PCP_MARKER}`,
    '[[hooks.SessionStart]]',
    `command = "${sbPath} hooks on-session-start"`,
    '',
    '[[hooks.UserPromptSubmit]]',
    `command = "${sbPath} hooks on-prompt"`,
    '',
    '[[hooks.AfterAgent]]',
    `command = "${sbPath} hooks on-stop"`,
    `# end ${PCP_MARKER}`,
    '',
  ].join('\n');

  writeFileSync(configPath, cleaned.trimEnd() + '\n' + pcpSection);
  return 'installed';
}

function removePcpTomlSection(content: string): string {
  const startMarker = `# ${PCP_MARKER}`;
  const endMarker = `# end ${PCP_MARKER}`;

  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return content;

  const endIdx = content.indexOf(endMarker);
  if (endIdx === -1) return content;

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + endMarker.length);
  return before + after;
}

/**
 * Programmatic hooks installer. Returns the result without printing.
 * Used by `sb hooks install`, `sb studio create`, and `sb init`.
 */
export function installHooks(
  cwd: string,
  options?: { backend?: string; force?: boolean }
): { result: InstallResult; backend: HookCapabilities } {
  const backend = options?.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  let result: InstallResult = 'conflict';

  switch (backend.name) {
    case 'claude-code':
      result = installClaudeCode(cwd, !!options?.force);
      break;
    case 'gemini':
      result = installGemini(cwd, !!options?.force);
      break;
    case 'codex':
      result = installCodex(cwd, !!options?.force);
      break;
  }

  return { result, backend };
}

function printInstallResult(
  targetDir: string,
  result: InstallResult,
  backend: HookCapabilities
): void {
  if (result === 'already-installed') {
    console.log(chalk.dim(`  · ${targetDir} — up to date (${backend.name})`));
    return;
  }

  if (result === 'conflict') {
    console.log(chalk.yellow(`  ○ ${targetDir} — conflict (use --force)`));
    return;
  }

  console.log(chalk.green(`  ✓ ${targetDir} — installed (${backend.name})`));
  const events = backend.events;
  if (events.preCompact)
    console.log(chalk.dim(`      ${events.preCompact} → sb hooks pre-compact`));
  if (events.postCompact)
    console.log(chalk.dim(`      ${events.postCompact} (compact) → sb hooks post-compact`));
  if (events.sessionStart)
    console.log(chalk.dim(`      ${events.sessionStart} (startup) → sb hooks on-session-start`));
  if (events.onPrompt) console.log(chalk.dim(`      ${events.onPrompt} → sb hooks on-prompt`));
  if (events.onStop) console.log(chalk.dim(`      ${events.onStop} → sb hooks on-stop`));
}

async function installCommand(options: {
  backend?: string;
  local?: boolean;
  force?: boolean;
  all?: boolean;
}): Promise<void> {
  const cwd = process.cwd();

  if (options.all) {
    const worktrees = listWorktreePaths(cwd);
    console.log(chalk.bold(`\nInstalling PCP hooks across ${worktrees.length} worktree(s):\n`));

    let hasConflict = false;
    for (const wt of worktrees) {
      const { result, backend } = installHooks(wt, options);
      printInstallResult(wt, result, backend);
      if (result === 'conflict') hasConflict = true;
    }

    console.log('');
    if (hasConflict) {
      console.log(chalk.yellow('Some worktrees had conflicts. Use --force to overwrite.'));
    } else {
      console.log(chalk.dim('Done.'));
    }
    return;
  }

  const { result, backend } = installHooks(cwd, options);

  console.log(chalk.dim(`Backend: ${backend.name}`));

  if (result === 'already-installed') {
    console.log(chalk.green('\nPCP hooks already installed and up to date.'));
    console.log(chalk.dim(`Config: ${backend.configPath}`));
    return;
  }

  if (result === 'conflict') {
    console.error(chalk.yellow('Existing non-PCP hooks detected. Use --force to overwrite.'));
    process.exit(1);
  }

  console.log(chalk.green('\nPCP hooks installed:'));

  const events = backend.events;
  if (events.preCompact) console.log(chalk.dim(`  ${events.preCompact} → sb hooks pre-compact`));
  if (events.postCompact)
    console.log(chalk.dim(`  ${events.postCompact} (compact) → sb hooks post-compact`));
  if (events.sessionStart)
    console.log(chalk.dim(`  ${events.sessionStart} (startup) → sb hooks on-session-start`));
  if (events.onPrompt) console.log(chalk.dim(`  ${events.onPrompt} → sb hooks on-prompt`));
  if (events.onStop) console.log(chalk.dim(`  ${events.onStop} → sb hooks on-stop`));

  console.log(chalk.dim(`\nConfig: ${backend.configPath}`));
}

function uninstallFromDir(targetDir: string, backendName?: string): boolean {
  const backend = backendName ? getBackendByName(backendName) : detectBackend(targetDir);
  const configPath = join(targetDir, backend.configPath);

  if (!existsSync(configPath)) return false;

  switch (backend.name) {
    case 'claude-code':
    case 'gemini': {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (!config.hooks) return false;
      delete config.hooks;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      break;
    }
    case 'codex': {
      const content = readFileSync(configPath, 'utf-8');
      if (!content.includes('pcp-managed')) return false;
      const cleaned = removePcpTomlSection(content);
      writeFileSync(configPath, cleaned);
      break;
    }
  }

  return true;
}

async function uninstallCommand(options: { backend?: string; all?: boolean }): Promise<void> {
  const cwd = process.cwd();

  if (options.all) {
    const worktrees = listWorktreePaths(cwd);
    console.log(chalk.bold(`\nRemoving PCP hooks across ${worktrees.length} worktree(s):\n`));

    for (const wt of worktrees) {
      const backend = options.backend ? getBackendByName(options.backend) : detectBackend(wt);
      const removed = uninstallFromDir(wt, options.backend);
      if (removed) {
        console.log(chalk.green(`  ✓ ${wt} — removed (${backend.name})`));
      } else {
        console.log(chalk.dim(`  · ${wt} — no hooks found`));
      }
    }

    console.log(chalk.dim('\nDone.'));
    return;
  }

  const backend = options.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  const configPath = join(cwd, backend.configPath);

  if (!existsSync(configPath)) {
    console.log(chalk.yellow('No config file found. Nothing to uninstall.'));
    return;
  }

  const removed = uninstallFromDir(cwd, options.backend);
  if (removed) {
    console.log(chalk.green(`PCP hooks removed from ${backend.configPath}`));
  } else {
    console.log(chalk.yellow('No PCP hooks found to remove.'));
  }
}

async function statusCommand(options: { backend?: string }): Promise<void> {
  const cwd = process.cwd();
  const backend = options.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  const configPath = join(cwd, backend.configPath);

  console.log(chalk.bold(`\nHook Status (${backend.name}):\n`));
  console.log(chalk.dim(`  Config: ${backend.configPath}`));

  if (!existsSync(configPath)) {
    console.log(chalk.yellow('\n  No config file found. Hooks not installed.'));
    console.log(chalk.dim('  Run: sb hooks install'));
    return;
  }

  let hasHooks = false;

  switch (backend.name) {
    case 'claude-code':
    case 'gemini': {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const hooks = config.hooks as Record<string, unknown> | undefined;
        if (hooks && Object.keys(hooks).length > 0) {
          hasHooks = true;
          console.log(chalk.green('\n  Hooks installed:'));
          for (const [event, entries] of Object.entries(hooks)) {
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
              const entryObj = entry as Record<string, unknown>;
              const hookList = entryObj.hooks as Array<Record<string, unknown>> | undefined;
              const matcher = entryObj.matcher as string | undefined;
              const command = entryObj.command as string | undefined;

              if (hookList) {
                for (const h of hookList) {
                  const cmd = h.command as string;
                  const matcherSuffix = matcher ? ` (${matcher})` : '';
                  const icon = isPcpHookCommand(cmd) ? chalk.green('●') : chalk.dim('○');
                  console.log(`    ${icon} ${event}${matcherSuffix} → ${cmd}`);
                }
              } else if (command) {
                // Gemini/simpler format
                const icon = isPcpHookCommand(command) ? chalk.green('●') : chalk.dim('○');
                console.log(`    ${icon} ${event} → ${command}`);
              }
            }
          }
        }
      } catch {
        console.log(chalk.red('\n  Failed to parse config file.'));
      }
      break;
    }
    case 'codex': {
      const content = readFileSync(configPath, 'utf-8');
      if (content.includes(PCP_MARKER)) {
        hasHooks = true;
        console.log(chalk.green('\n  PCP hooks installed (TOML)'));
        if (content.includes('session_start'))
          console.log(chalk.dim('    ● session_start → sb hooks on-session-start'));
        if (content.includes('session_end'))
          console.log(chalk.dim('    ● session_end → sb hooks on-stop'));
      }
      break;
    }
  }

  if (!hasHooks) {
    console.log(chalk.yellow('\n  No hooks installed.'));
    console.log(chalk.dim('  Run: sb hooks install'));
  }

  // Show capabilities
  console.log(chalk.dim('\n  Capabilities:'));
  console.log(
    chalk.dim(
      `    Compaction: ${backend.supportsCompaction ? chalk.green('yes') : chalk.yellow('no')}`
    )
  );
  console.log(
    chalk.dim(
      `    Prompt hook: ${backend.supportsPromptHook ? chalk.green('yes') : chalk.yellow('no')}`
    )
  );

  console.log('');
}

// ============================================================================
// Hook Handlers
// ============================================================================

async function preCompactHandler(): Promise<void> {
  await readStdin(); // consume stdin but we don't need it
  process.stdout.write(loadTemplate('hook-pre-compact'));
}

async function postCompactHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';

  let identityBlock = '';
  let inboxBlock = '';

  // Bootstrap identity
  try {
    const bootstrap = await callPcpTool('bootstrap', {
      email: config?.email,
      agentId,
    });
    identityBlock = buildIdentityBlock(bootstrap.identity);
  } catch {
    identityBlock = '*FAILED: Could not reach PCP server for `bootstrap`. You should call the `bootstrap` MCP tool manually to reload your identity context.*';
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });
    inboxBlock = buildInboxBlock(inbox.messages as Array<Record<string, unknown>> | undefined);
    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    inboxBlock = '*FAILED: Could not reach PCP server for `get_inbox`. You should call the `get_inbox` MCP tool manually to check for messages.*';
  }

  const template = loadTemplate('hook-post-compact');
  const output = renderTemplate(template, {
    AGENT_ID: agentId,
    IDENTITY_BLOCK: identityBlock,
    INBOX_BLOCK: inboxBlock,
  });

  process.stdout.write(output);
}

async function onSessionStartHandler(): Promise<void> {
  const stdin = await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';

  // Read studio/workspace ID from identity.json
  const identityPath = join(cwd, '.pcp', 'identity.json');
  let studioId: string | undefined;
  let studioLine = '';
  if (existsSync(identityPath)) {
    try {
      const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
      studioId = identity.studioId || identity.workspaceId;
      const studioName = identity.studio || identity.workspace;
      if (studioName) {
        studioLine = `Studio: ${studioName}`;
      }
    } catch {
      // ignore
    }
  }

  let identityBlock = '';
  let memoriesBlock = '';
  let sessionsBlock = '';
  let inboxBlock = '';

  // Bootstrap
  try {
    const bootstrapArgs: Record<string, unknown> = {
      email: config?.email,
      agentId,
    };
    if (studioId) bootstrapArgs.studioId = studioId;

    const bootstrap = await callPcpTool('bootstrap', bootstrapArgs);
    identityBlock = buildIdentityBlock(bootstrap.identity);
    memoriesBlock = buildMemoriesBlock(
      bootstrap.recentMemories as Array<Record<string, unknown>> | undefined
    );
    sessionsBlock = buildSessionsBlock(
      bootstrap.activeSessions as Array<Record<string, unknown>> | undefined
    );
  } catch {
    identityBlock = '*FAILED: Could not reach PCP server for `bootstrap`. You should call the `bootstrap` MCP tool manually to reload your identity context.*';
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });
    inboxBlock = buildInboxBlock(inbox.messages as Array<Record<string, unknown>> | undefined);
    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    inboxBlock = '*FAILED: Could not reach PCP server for `get_inbox`. You should call the `get_inbox` MCP tool manually to check for messages.*';
  }

  // Register PCP session with detected backend
  const detectedBackend = detectBackend(cwd);
  try {
    const startArgs: Record<string, unknown> = {
      email: config?.email,
      agentId,
      backend: detectedBackend.name,
    };
    if (studioId) startArgs.studioId = studioId;
    await callPcpTool('start_session', startArgs);
  } catch {
    // Session tracking failure isn't shown to the SB (no block for it),
    // but it means the session won't be tracked. The bootstrap failure
    // message above will already alert about server connectivity.
  }

  // Store session ID if provided in stdin
  if (stdin.session_id) {
    writeRuntimeFile(cwd, 'session-id', String(stdin.session_id));
  }

  const template = loadTemplate('hook-session-start');
  const output = renderTemplate(template, {
    AGENT_ID: agentId,
    WORKSPACE_LINE: studioLine,
    IDENTITY_BLOCK: identityBlock,
    MEMORIES_BLOCK: memoriesBlock,
    SESSIONS_BLOCK: sessionsBlock,
    INBOX_BLOCK: inboxBlock,
  });

  process.stdout.write(output);
}

async function onPromptHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';

  // Check if inbox check is stale (> 5 minutes)
  const lastCheck = readRuntimeFile(cwd, 'last-inbox-check');
  const staleThresholdMs = 5 * 60 * 1000;

  if (lastCheck) {
    const lastCheckTime = new Date(lastCheck).getTime();
    const elapsed = Date.now() - lastCheckTime;
    if (elapsed < staleThresholdMs) {
      // Fast path: inbox was checked recently, output nothing
      return;
    }
  }

  // Inbox is stale or never checked — poll
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });

    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());

    const messages = inbox.messages as Array<Record<string, unknown>> | undefined;
    const inboxTag = buildInboxTag(messages);
    if (inboxTag) {
      process.stdout.write(inboxTag);
    }
  } catch {
    // Silent failure — don't interrupt the user's prompt
  }
}

async function onStopHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';
  const parts: string[] = [];

  // Increment tool call counter
  const countStr = readRuntimeFile(cwd, 'tool-count');
  const count = (countStr ? parseInt(countStr, 10) : 0) + 1;
  writeRuntimeFile(cwd, 'tool-count', String(count));

  // Every ~30 calls, nudge to log session
  if (count % 30 === 0) {
    const template = loadTemplate('hook-on-stop');
    parts.push(renderTemplate(template, { TOOL_COUNT: String(count) }));
  }

  // Check inbox if stale
  const lastCheck = readRuntimeFile(cwd, 'last-inbox-check');
  const staleThresholdMs = 5 * 60 * 1000;
  let shouldCheckInbox = !lastCheck;
  if (lastCheck) {
    const elapsed = Date.now() - new Date(lastCheck).getTime();
    shouldCheckInbox = elapsed >= staleThresholdMs;
  }

  if (shouldCheckInbox) {
    try {
      const inbox = await callPcpTool('get_inbox', {
        email: config?.email,
        agentId,
      });

      writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());

      const inboxTag = buildInboxTag(inbox.messages as Array<Record<string, unknown>> | undefined);
      if (inboxTag) parts.push(inboxTag);
    } catch {
      // Silent
    }
  }

  if (parts.length > 0) {
    process.stdout.write(parts.join('\n\n'));
  }
}

// ============================================================================
// Register Commands
// ============================================================================

export function registerHooksCommands(program: Command): void {
  const hooks = program
    .command('hooks')
    .description('Manage CLI lifecycle hooks for PCP integration');

  hooks
    .command('install')
    .description('Install PCP hooks into the detected backend config')
    .option('-b, --backend <name>', 'Backend to target (claude-code, codex, gemini)')
    .option('--local', 'Write to local config (default for Claude Code)', true)
    .option('-f, --force', 'Overwrite existing hooks')
    .option('-a, --all', 'Install across all git worktrees')
    .action(installCommand);

  hooks
    .command('uninstall')
    .description('Remove PCP-managed hooks from backend config')
    .option('-b, --backend <name>', 'Backend to target')
    .option('-a, --all', 'Uninstall from all git worktrees')
    .action(uninstallCommand);

  hooks
    .command('status')
    .description('Show installed hook status for the detected backend')
    .option('-b, --backend <name>', 'Backend to check')
    .action(statusCommand);

  // Hook handlers — invoked by the backend, not the user
  hooks
    .command('pre-compact')
    .description('Hook: output pre-compaction reminder')
    .action(preCompactHandler);

  hooks
    .command('post-compact')
    .description('Hook: post-compaction bootstrap and inbox check')
    .action(postCompactHandler);

  hooks
    .command('on-session-start')
    .description('Hook: bootstrap identity and context at session start')
    .action(onSessionStartHandler);

  hooks
    .command('on-prompt')
    .description('Hook: periodic inbox check on user prompt')
    .action(onPromptHandler);

  hooks
    .command('on-stop')
    .description('Hook: session nudge and inbox check on stop')
    .action(onStopHandler);
}
