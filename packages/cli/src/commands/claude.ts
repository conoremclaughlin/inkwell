/**
 * Backend Runner
 *
 * Spawns the selected AI CLI backend with identity injection,
 * passthrough flags, and session tracking.
 */

import { spawn } from 'child_process';
import chalk from 'chalk';
import { getBackend, resolveAgentId } from '../backends/index.js';

export interface SbOptions {
  agent: string;
  model: string;
  session: boolean;
  verbose: boolean;
  backend: string;
}

/**
 * Run a backend with a prompt (one-shot mode).
 */
export async function runClaude(
  prompt: string,
  promptParts: string[],
  options: SbOptions,
  passthroughArgs: string[] = [],
): Promise<void> {
  const agentId = resolveAgentId(options.agent);
  const adapter = getBackend(options.backend);

  if (options.verbose) {
    console.log(chalk.dim(`Backend: ${adapter.name}`));
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
    console.log(chalk.dim(`Session tracking: ${options.session}`));
    if (passthroughArgs.length) {
      console.log(chalk.dim(`Passthrough: ${passthroughArgs.join(' ')}`));
    }
  }

  const prepared = adapter.prepare({
    agentId,
    model: options.model,
    prompt,
    promptParts,
    passthroughArgs,
  });

  if (options.verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: { ...process.env, ...prepared.env },
  });

  child.on('close', (code) => {
    prepared.cleanup();
    if (code !== 0) process.exit(code || 1);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

/**
 * Run a backend interactively (no prompt).
 */
export async function runClaudeInteractive(
  options: SbOptions,
  passthroughArgs: string[] = [],
): Promise<void> {
  const agentId = resolveAgentId(options.agent);
  const adapter = getBackend(options.backend);

  if (options.verbose) {
    console.log(chalk.dim(`Backend: ${adapter.name}`));
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
    if (passthroughArgs.length) {
      console.log(chalk.dim(`Passthrough: ${passthroughArgs.join(' ')}`));
    }
  }

  const prepared = adapter.prepare({
    agentId,
    model: options.model,
    promptParts: [],
    passthroughArgs,
  });

  if (options.verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: { ...process.env, ...prepared.env },
  });

  child.on('close', (code) => {
    prepared.cleanup();
    process.exit(code || 0);
  });
}
