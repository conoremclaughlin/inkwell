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
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerWorkspaceContainerCommands } from './commands/workspace-container.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerSessionCommands } from './commands/session.js';
import { registerConfigCommands } from './commands/mcp.js';
import { registerAwakenCommand } from './commands/awaken.js';
import { runClaude, runClaudeInteractive } from './commands/claude.js';

const VERSION = '0.3.0';

// ============================================================================
// Argv Parsing
// ============================================================================

/**
 * Known SB flags and their config.
 * Everything else is forwarded to the underlying AI tool.
 */
const SB_FLAGS: Record<string, { hasValue: boolean; key: string }> = {
  '-a':           { hasValue: true,  key: 'agent' },
  '--agent':      { hasValue: true,  key: 'agent' },
  '-b':           { hasValue: true,  key: 'backend' },
  '--backend':    { hasValue: true,  key: 'backend' },
  '-m':           { hasValue: true,  key: 'model' },
  '--model':      { hasValue: true,  key: 'model' },
  '-v':           { hasValue: false, key: 'verbose' },
  '--verbose':    { hasValue: false, key: 'verbose' },
  '--no-session': { hasValue: false, key: 'noSession' },
};

interface ParsedArgs {
  sbOptions: {
    agent: string;
    backend: string;
    model: string | undefined;  // undefined = use backend's default
    session: boolean;
    verbose: boolean;
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
function extractArgs(argv: string[]): ParsedArgs {
  const sbOptions: ParsedArgs['sbOptions'] = {
    agent: 'wren',
    backend: 'claude',
    model: undefined,  // undefined = use backend's default
    session: true,
    verbose: false,
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
      } else if (!flag.hasValue) {
        if (flag.key === 'noSession') sbOptions.session = false;
        else if (flag.key === 'verbose') sbOptions.verbose = true;
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
  .option('-a, --agent <id>', 'Agent identity to use', 'wren')
  .option('-b, --backend <name>', 'AI backend (claude, codex, gemini)', 'claude')
  .option('-m, --model <model>', 'Model to use (defaults to backend-specific)')
  .option('--no-session', 'Disable session tracking')
  .option('-v, --verbose', 'Verbose output')
  .argument('[prompt...]', 'Prompt to send (omit for interactive)')
  .action(async () => {
    // We parse argv ourselves for clean passthrough — Commander's parsed
    // values aren't reliable for unknown flags with values.
    const { sbOptions, passthroughArgs, promptParts, prompt } = extractArgs(process.argv.slice(2));

    if (!prompt && !passthroughArgs.length && !process.stdin.isTTY) {
      // Piped stdin — read it as the prompt
      let stdinData = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        stdinData += chunk;
      }
      await runClaude(stdinData.trim(), [stdinData.trim()], sbOptions, passthroughArgs);
    } else if (prompt) {
      // Prompt mode (one-shot)
      await runClaude(prompt, promptParts, sbOptions, passthroughArgs);
    } else {
      // No prompt — launch interactive session
      // Passthrough args (like --resume) still forwarded
      await runClaudeInteractive(sbOptions, passthroughArgs);
    }
  });

// Register subcommand groups
registerWorkspaceCommands(program);
registerWorkspaceContainerCommands(program);
registerAgentCommands(program);
registerSessionCommands(program);
registerConfigCommands(program);
registerAwakenCommand(program);

// ============================================================================
// Subcommand detection
// ============================================================================

// Commander routes to subcommands automatically. But we need to prevent
// the default action from firing when a subcommand is used. Commander
// handles this — subcommand names take precedence over the default action.

program.parse();
