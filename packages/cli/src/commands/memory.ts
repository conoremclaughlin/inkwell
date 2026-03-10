import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { parseEnvFile } from './mcp.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'mxbai-embed-large';

interface InstallOptions {
  model?: string;
  skipPull?: boolean;
}

function formatInstallInstructions(): string[] {
  return [
    'Ollama is required for local memory embeddings.',
    'Install it first:',
    '  macOS: brew install ollama',
    '  Or download: https://ollama.com/download',
    'Then start it with:',
    '  ollama serve',
  ];
}

function upsertEnvFile(filePath: string, entries: Record<string, string>): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return line;

    const key = line.slice(0, eqIdx).trim();
    if (!(key in entries)) return line;

    seen.add(key);
    return `${key}=${entries[key]}`;
  });

  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  writeFileSync(filePath, `${nextLines.filter(Boolean).join('\n')}\n`, 'utf-8');
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: 'ignore',
      shell: false,
    });

    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function runStreamingCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function checkOllama(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function installCommand(options: InstallOptions): Promise<void> {
  const model = options.model || DEFAULT_OLLAMA_MODEL;
  const cwd = process.env.INIT_CWD || process.cwd();
  const envPath = join(cwd, '.env.local');
  const spinner = ora('Checking Ollama installation').start();

  if (!(await commandExists('ollama'))) {
    spinner.fail('Ollama is not installed');
    for (const line of formatInstallInstructions()) {
      console.log(chalk.dim(line));
    }
    process.exit(1);
  }

  spinner.succeed('Ollama is installed');

  const baseUrl = parseEnvFile(envPath).OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;

  if (!options.skipPull) {
    console.log(chalk.bold(`\nPulling embedding model: ${model}\n`));
    await runStreamingCommand('ollama', ['pull', model]);
  }

  const reachable = await checkOllama(baseUrl);
  if (!reachable) {
    console.log(chalk.yellow(`\nWarning: could not reach Ollama at ${baseUrl}`));
    console.log(chalk.dim('If Ollama is installed but not running, start it with `ollama serve`.'));
  }

  upsertEnvFile(envPath, {
    MEMORY_EMBEDDINGS_ENABLED: 'true',
    MEMORY_EMBEDDING_PROVIDER: 'ollama',
    MEMORY_EMBEDDING_MODEL: model,
    OLLAMA_BASE_URL: baseUrl,
  });

  console.log(chalk.green('\n✓ Memory embeddings configured\n'));
  console.log(chalk.dim(`Updated: ${envPath}`));
  console.log(chalk.dim('Next useful commands:'));
  console.log(chalk.dim('  yarn benchmark:memory-recall'));
  console.log(chalk.dim('  yarn benchmark:bootstrap-relevance'));
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Manage memory retrieval features');

  memory
    .command('install')
    .description('Install and configure local memory embeddings via Ollama')
    .option('--model <name>', 'Ollama embedding model to pull', DEFAULT_OLLAMA_MODEL)
    .option('--skip-pull', 'Skip `ollama pull` if the model is already installed')
    .action((options: InstallOptions) => {
      installCommand(options).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Memory install failed: ${message}`));
        process.exit(1);
      });
    });
}
