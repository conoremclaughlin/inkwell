#!/usr/bin/env node
/**
 * PCP CLI - Personal Context Protocol
 *
 * The unified command-line interface for PCP:
 * - Wrap Claude Code with identity injection and session tracking
 * - Manage workspaces for parallel development
 * - Interact with agents (trigger, inbox, status)
 * - Session management
 *
 * Usage:
 *   pcp [options] [prompt]    Start Claude with PCP integration
 *   pcp ws create <name>      Create a workspace
 *   pcp agent trigger <id>    Trigger an agent
 *   pcp session list          List sessions
 */

import { program } from 'commander';
import chalk from 'chalk';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerSessionCommands } from './commands/session.js';
import { runClaude } from './commands/claude.js';

const VERSION = '0.2.0';

// ============================================================================
// Main Program Setup
// ============================================================================

program
  .name('pcp')
  .description('PCP CLI - Personal Context Protocol')
  .version(VERSION)
  .option('-a, --agent <id>', 'Agent identity to use', 'wren')
  .option('-m, --model <model>', 'Model to use (sonnet, opus, haiku)', 'sonnet')
  .option('--no-session', 'Disable session tracking')
  .option('-v, --verbose', 'Verbose output')
  .argument('[prompt...]', 'Prompt to send to Claude')
  .action(async (promptParts: string[], options) => {
    const prompt = promptParts.join(' ');

    if (!prompt && !process.stdin.isTTY) {
      // Read from stdin if piped
      let stdinData = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        stdinData += chunk;
      }
      await runClaude(stdinData.trim(), options);
    } else if (prompt) {
      await runClaude(prompt, options);
    } else {
      // No prompt - show help or start interactive
      console.log(chalk.cyan('PCP CLI') + chalk.dim(` v${VERSION}`));
      console.log('');
      console.log('Usage:');
      console.log(chalk.dim('  pcp "your prompt"        Run Claude with prompt'));
      console.log(chalk.dim('  pcp ws create <name>     Create a workspace'));
      console.log(chalk.dim('  pcp agent status         Check agent status'));
      console.log(chalk.dim('  pcp session list         List sessions'));
      console.log('');
      console.log('Run', chalk.cyan('pcp --help'), 'for all commands.');
    }
  });

// Register subcommand groups
registerWorkspaceCommands(program);
registerAgentCommands(program);
registerSessionCommands(program);

// Parse CLI
program.parse();
