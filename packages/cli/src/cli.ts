#!/usr/bin/env node
/**
 * SB CLI - Synthetically-born Being
 *
 * A lightweight CLI that wraps AI coding tools (Claude Code, etc.) with
 * identity injection and session tracking. Unrecognized flags are passed
 * through to the underlying tool.
 *
 * Usage:
 *   sb                         Interactive session (default: claude)
 *   sb "your prompt"           One-shot prompt mode
 *   sb -b codex "fix the bug"  Use Codex CLI backend
 *   sb -b gemini "review this" Use Gemini CLI backend
 *   sb --resume <id>           Passthrough flags to backend
 *   sb studio create <name>    Create a studio (worktree)
 *   sb session list            List sessions
 */

import { program } from 'commander';
import chalk from 'chalk';
import { registerStudioCommands } from './commands/studio.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerSessionCommands } from './commands/session.js';
import { registerConfigCommands } from './commands/mcp.js';
import { registerAwakenCommand } from './commands/awaken.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerInitCommand } from './commands/init.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerChatCommand } from './commands/chat.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMissionCommand } from './commands/mission.js';
import { registerStatusCommand } from './commands/status.js';
import { runClaude, runClaudeInteractive } from './commands/claude.js';
import { resolveBackend } from './backends/index.js';

const VERSION = '0.3.0';

// ============================================================================
// Argv Parsing
// ============================================================================

/**
 * Known SB flags and their config.
 * Everything else is forwarded to the underlying AI tool.
 */
const SB_FLAGS: Record<string, { hasValue: boolean; key: string }> = {
  '-a': { hasValue: true, key: 'agent' },
  '--agent': { hasValue: true, key: 'agent' },
  '-b': { hasValue: true, key: 'backend' },
  '--backend': { hasValue: true, key: 'backend' },
  '-m': { hasValue: true, key: 'model' },
  '--model': { hasValue: true, key: 'model' },
  '-v': { hasValue: false, key: 'verbose' },
  '--verbose': { hasValue: false, key: 'verbose' },
  '--no-session': { hasValue: false, key: 'noSession' },
  '--session-candidates': { hasValue: false, key: 'sessionCandidates' },
  '--session-choice': { hasValue: true, key: 'sessionChoice' },
};

interface ParsedArgs {
  sbOptions: {
    agent: string | undefined;
    backend: string | undefined;
    model: string | undefined; // undefined = use backend's default
    session: boolean;
    verbose: boolean;
    sessionCandidates: boolean;
    sessionChoice: string | undefined;
  };
  passthroughArgs: string[];
  promptParts: string[];
  prompt: string;
}

/**
 * Parse argv manually to cleanly separate SB flags, passthrough flags,
 * and the prompt. Commander can't reliably handle unknown flags with values
 * (e.g. --resume abc123) so we do this ourselves for the root command.
 */
/**
 * Detect whether positional args contain a backend subcommand that
 * requires interactive stdio (e.g. `codex resume [id]`).
 *
 * These subcommands are always passed through to the backend as-is.
 * sb does not use positional args as prompts — prompts go via flags
 * or piped stdin.
 */
export function isBackendInteractiveSubcommand(backend: string, promptParts: string[]): boolean {
  if (backend !== 'codex' || promptParts.length === 0) return false;
  const CODEX_INTERACTIVE_SUBCOMMANDS = ['resume'];
  return promptParts.some((part) => CODEX_INTERACTIVE_SUBCOMMANDS.includes(part));
}

export function extractArgs(argv: string[]): ParsedArgs {
  const sbOptions: ParsedArgs['sbOptions'] = {
    agent: undefined,
    backend: undefined,
    model: undefined, // undefined = use backend's default
    session: true,
    verbose: false,
    sessionCandidates: false,
    sessionChoice: undefined,
  };
  const passthroughArgs: string[] = [];
  const promptParts: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const flag = SB_FLAGS[arg];

    if (flag) {
      // Known SB flag
      if (flag.hasValue && i + 1 < argv.length) {
        const val = argv[++i];
        if (flag.key === 'agent') sbOptions.agent = val;
        if (flag.key === 'backend') sbOptions.backend = val;
        if (flag.key === 'model') sbOptions.model = val;
        if (flag.key === 'sessionChoice') sbOptions.sessionChoice = val;
      } else if (!flag.hasValue) {
        if (flag.key === 'noSession') sbOptions.session = false;
        else if (flag.key === 'verbose') sbOptions.verbose = true;
        else if (flag.key === 'sessionCandidates') sbOptions.sessionCandidates = true;
      }
    } else if (arg === '--') {
      // Explicit passthrough boundary — everything after goes to claude
      passthroughArgs.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) {
      // Unknown flag — forward to the underlying tool
      passthroughArgs.push(arg);
      // If next arg exists and doesn't look like a flag, treat it as this flag's value
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        passthroughArgs.push(argv[++i]);
      }
    } else {
      // Positional arg — part of the prompt
      promptParts.push(arg);
    }

    i++;
  }

  return {
    sbOptions,
    passthroughArgs,
    promptParts,
    prompt: promptParts.join(' '),
  };
}

// ============================================================================
// Main Program Setup
// ============================================================================

program
  .name('sb')
  .description('SB CLI — launch AI coding sessions with persistent identity')
  .version(VERSION)
  .enablePositionalOptions()
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .option('-a, --agent <id>', 'Agent identity to use')
  .option('-b, --backend <name>', 'AI backend (claude, codex, gemini)', 'claude')
  .option('-m, --model <model>', 'Model to use (defaults to backend-specific)')
  .option('--no-session', 'Disable session tracking')
  .option(
    '--session-candidates',
    'List session candidates and exit (or combine with --session-choice)'
  )
  .option('--session-choice <choice>', 'Force session selection (new | pcp:<id> | local:<id>)')
  .option('-v, --verbose', 'Verbose output')
  .argument('[prompt...]', 'Prompt to send (omit for interactive)')
  .action(async () => {
    // We parse argv ourselves for clean passthrough — Commander's parsed
    // values aren't reliable for unknown flags with values.
    const { sbOptions, passthroughArgs, promptParts, prompt } = extractArgs(process.argv.slice(2));

    // Resolve backend from identity.json if not explicitly set
    const resolvedOptions = { ...sbOptions, backend: resolveBackend(sbOptions.backend) };

    const isInteractiveSubcommand = isBackendInteractiveSubcommand(
      resolvedOptions.backend,
      promptParts
    );

    if (isInteractiveSubcommand) {
      // Move positional args to passthrough so the backend receives them as subcommand args
      await runClaudeInteractive(resolvedOptions, [...passthroughArgs, ...promptParts]);
    } else if (!prompt && !passthroughArgs.length && !process.stdin.isTTY) {
      // Piped stdin — read it as the prompt
      let stdinData = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        stdinData += chunk;
      }
      await runClaude(stdinData.trim(), [stdinData.trim()], resolvedOptions, passthroughArgs);
    } else if (prompt) {
      // Prompt mode (one-shot)
      await runClaude(prompt, promptParts, resolvedOptions, passthroughArgs);
    } else {
      // No prompt — launch interactive session
      // Passthrough args (like --resume) still forwarded
      await runClaudeInteractive(resolvedOptions, passthroughArgs);
    }
  });

// Register subcommand groups
registerStudioCommands(program);
registerWorkspaceCommands(program);
registerAgentCommands(program);
registerSessionCommands(program);
registerConfigCommands(program);
registerAwakenCommand(program);
registerHooksCommands(program);
registerInitCommand(program);
registerAuthCommands(program);
registerChatCommand(program);
registerDoctorCommand(program);
registerMissionCommand(program);
registerStatusCommand(program);

// ============================================================================
// Subcommand detection
// ============================================================================

// Commander routes to subcommands automatically. But we need to prevent
// the default action from firing when a subcommand is used. Commander
// handles this — subcommand names take precedence over the default action.

program.parse();
