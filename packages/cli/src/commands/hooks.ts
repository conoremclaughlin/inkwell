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
import { join } from 'path';
import { homedir } from 'os';
import { resolveAgentId } from '../backends/identity.js';

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
    sessionStart: 'session_start',
    preCompact: null,
    postCompact: null,
    onPrompt: null,
    onStop: 'session_end',
  },
  supportsCompaction: false,
  supportsPromptHook: false,
};

const GEMINI: HookCapabilities = {
  name: 'gemini',
  configPath: '.gemini/settings.json',
  configFormat: 'json',
  events: {
    sessionStart: 'session_start',
    preCompact: null,
    postCompact: null,
    onPrompt: null,
    onStop: 'session_end',
  },
  supportsCompaction: false,
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

async function callPcpTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${getPcpServerUrl()}/mcp`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
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
// Install / Uninstall / Status
// ============================================================================

/** Marker used to identify PCP-managed hook entries */
const PCP_MARKER = 'pcp-managed';

type InstallResult = 'installed' | 'already-installed' | 'conflict';

function buildClaudeCodeHooks(): Record<string, unknown> {
  return {
    hooks: {
      PreCompact: [
        {
          hooks: [{ type: 'command', command: 'sb hooks pre-compact' }],
        },
      ],
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [{ type: 'command', command: 'sb hooks post-compact' }],
        },
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'sb hooks on-session-start' }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: 'sb hooks on-prompt' }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: 'sb hooks on-stop' }],
        },
      ],
    },
  };
}

/** Check if existing Claude Code hooks already match the PCP hooks we'd write */
function claudeCodeHooksMatch(existing: Record<string, unknown>): boolean {
  const target = buildClaudeCodeHooks();
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
    if (claudeCodeHooksMatch(existing)) {
      return 'already-installed';
    }

    // Check if any non-PCP hooks exist
    const hasNonPcpHooks = Object.entries(existingHooks).some(([, entries]) => {
      if (!Array.isArray(entries)) return false;
      return entries.some((entry: Record<string, unknown>) => {
        const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
        if (!hooks) return false;
        return hooks.some((h) => {
          const cmd = h.command as string | undefined;
          return cmd && !cmd.startsWith('sb hooks ');
        });
      });
    });

    if (hasNonPcpHooks) {
      return 'conflict';
    }
  }

  const pcpHooks = buildClaudeCodeHooks();

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

  if (existing.hooks && !force) {
    // Check if our hooks are already there
    const hooksObj = existing.hooks as Record<string, unknown>;
    const hasSessionStart = Array.isArray(hooksObj.session_start) &&
      (hooksObj.session_start as Array<Record<string, unknown>>).some(
        (h) => h.command === 'sb hooks on-session-start'
      );
    const hasSessionEnd = Array.isArray(hooksObj.session_end) &&
      (hooksObj.session_end as Array<Record<string, unknown>>).some(
        (h) => h.command === 'sb hooks on-stop'
      );
    if (hasSessionStart && hasSessionEnd) {
      return 'already-installed';
    }

    return 'conflict';
  }

  const merged = {
    ...existing,
    hooks: {
      session_start: [{ command: 'sb hooks on-session-start' }],
      session_end: [{ command: 'sb hooks on-stop' }],
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

  const pcpSection = [
    '',
    `# ${PCP_MARKER}`,
    '[hooks]',
    'session_start = "sb hooks on-session-start"',
    'session_end = "sb hooks on-stop"',
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

async function installCommand(options: {
  backend?: string;
  local?: boolean;
  force?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
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

async function uninstallCommand(options: { backend?: string }): Promise<void> {
  const cwd = process.cwd();
  const backend = options.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  const configPath = join(cwd, backend.configPath);

  if (!existsSync(configPath)) {
    console.log(chalk.yellow('No config file found. Nothing to uninstall.'));
    return;
  }

  switch (backend.name) {
    case 'claude-code':
    case 'gemini': {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      delete config.hooks;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      break;
    }
    case 'codex': {
      const content = readFileSync(configPath, 'utf-8');
      const cleaned = removePcpTomlSection(content);
      writeFileSync(configPath, cleaned);
      break;
    }
  }

  console.log(chalk.green(`PCP hooks removed from ${backend.configPath}`));
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
                  const isPcp = cmd?.startsWith('sb hooks ');
                  const icon = isPcp ? chalk.green('●') : chalk.dim('○');
                  console.log(`    ${icon} ${event}${matcherSuffix} → ${cmd}`);
                }
              } else if (command) {
                // Gemini/simpler format
                const isPcp = command.startsWith('sb hooks ');
                const icon = isPcp ? chalk.green('●') : chalk.dim('○');
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
    chalk.dim(`    Compaction: ${backend.supportsCompaction ? chalk.green('yes') : chalk.yellow('no')}`)
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

  // Output reminder to stdout — the backend injects this into the conversation
  const output = [
    '## Pre-Compaction Reminder (PCP)',
    '',
    'Context is about to be compacted. Before compaction completes:',
    '',
    '1. **Save critical decisions** — Use `mcp__pcp__log_session` to persist any important reasoning, decisions, or context that should survive compaction.',
    '2. **Update memory** — If you discovered reusable patterns or key facts, use `mcp__pcp__remember` to save them.',
    '3. **Note current task state** — Log where you are in the current task so you can resume smoothly after compaction.',
    '',
    'This context will be lost after compaction unless you save it now.',
  ].join('\n');

  process.stdout.write(output);
}

async function postCompactHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId();
  const lines: string[] = [];

  lines.push('## Post-Compaction Context (PCP)');
  lines.push('');
  lines.push(`Agent: ${agentId}`);
  lines.push('');

  // Bootstrap identity
  try {
    const bootstrap = await callPcpTool('bootstrap', {
      email: config?.email,
      agentId,
    });

    if (bootstrap.identity) {
      lines.push('### Identity');
      lines.push('```json');
      lines.push(JSON.stringify(bootstrap.identity, null, 2));
      lines.push('```');
      lines.push('');
    }
  } catch {
    lines.push('*Could not reach PCP server for bootstrap.*');
    lines.push('');
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });

    const messages = inbox.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      lines.push(`### Inbox (${messages.length} message${messages.length === 1 ? '' : 's'})`);
      for (const msg of messages) {
        lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
      }
      lines.push('');
    }

    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    // Non-fatal
  }

  process.stdout.write(lines.join('\n'));
}

async function onSessionStartHandler(): Promise<void> {
  const stdin = await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId();
  const lines: string[] = [];

  lines.push('## Session Context (PCP)');
  lines.push('');
  lines.push(`Agent: **${agentId}**`);

  // Read workspace ID from identity.json
  const identityPath = join(cwd, '.pcp', 'identity.json');
  let workspaceId: string | undefined;
  if (existsSync(identityPath)) {
    try {
      const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
      workspaceId = identity.workspaceId;
      if (identity.workspace) {
        lines.push(`Workspace: ${identity.workspace}`);
      }
    } catch {
      // ignore
    }
  }

  lines.push('');

  // Bootstrap
  try {
    const bootstrapArgs: Record<string, unknown> = {
      email: config?.email,
      agentId,
    };
    if (workspaceId) bootstrapArgs.workspaceId = workspaceId;

    const bootstrap = await callPcpTool('bootstrap', bootstrapArgs);

    if (bootstrap.identity) {
      lines.push('### Identity');
      lines.push('```json');
      lines.push(JSON.stringify(bootstrap.identity, null, 2));
      lines.push('```');
      lines.push('');
    }

    if (bootstrap.recentMemories) {
      const memories = bootstrap.recentMemories as Array<Record<string, unknown>>;
      if (memories.length > 0) {
        lines.push('### Recent Memories');
        for (const mem of memories.slice(0, 5)) {
          lines.push(`- ${mem.content || mem.key || JSON.stringify(mem)}`);
        }
        lines.push('');
      }
    }

    if (bootstrap.activeSessions) {
      const sessions = bootstrap.activeSessions as Array<Record<string, unknown>>;
      if (sessions.length > 0) {
        lines.push('### Active Sessions');
        for (const s of sessions) {
          lines.push(`- ${(s.id as string)?.substring(0, 8) || 'unknown'}: ${s.summary || s.status || 'active'}`);
        }
        lines.push('');
      }
    }
  } catch {
    lines.push('*Could not reach PCP server for bootstrap.*');
    lines.push('');
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });

    const messages = inbox.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      lines.push(`### Inbox (${messages.length} message${messages.length === 1 ? '' : 's'})`);
      for (const msg of messages) {
        lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
      }
      lines.push('');
    }

    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    // Non-fatal
  }

  // Store session ID if provided in stdin
  if (stdin.session_id) {
    writeRuntimeFile(cwd, 'session-id', String(stdin.session_id));
  }

  process.stdout.write(lines.join('\n'));
}

async function onPromptHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId();

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
    if (messages && messages.length > 0) {
      const lines: string[] = [];
      lines.push(`<pcp-inbox count="${messages.length}">`);
      for (const msg of messages) {
        lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
      }
      lines.push('</pcp-inbox>');
      process.stdout.write(lines.join('\n'));
    }
  } catch {
    // Silent failure — don't interrupt the user's prompt
  }
}

async function onStopHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId();
  const lines: string[] = [];

  // Increment tool call counter
  const countStr = readRuntimeFile(cwd, 'tool-count');
  const count = (countStr ? parseInt(countStr, 10) : 0) + 1;
  writeRuntimeFile(cwd, 'tool-count', String(count));

  // Every ~30 calls, nudge to log session
  if (count % 30 === 0) {
    lines.push('<pcp-reminder>');
    lines.push(
      `You have completed ~${count} tool calls this session. Consider using \`mcp__pcp__log_session\` to save a progress snapshot.`
    );
    lines.push('</pcp-reminder>');
    lines.push('');
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

      const messages = inbox.messages as Array<Record<string, unknown>> | undefined;
      if (messages && messages.length > 0) {
        lines.push(`<pcp-inbox count="${messages.length}">`);
        for (const msg of messages) {
          lines.push(
            `- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`
          );
        }
        lines.push('</pcp-inbox>');
      }
    } catch {
      // Silent
    }
  }

  if (lines.length > 0) {
    process.stdout.write(lines.join('\n'));
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
    .action(installCommand);

  hooks
    .command('uninstall')
    .description('Remove PCP-managed hooks from backend config')
    .option('-b, --backend <name>', 'Backend to target')
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
