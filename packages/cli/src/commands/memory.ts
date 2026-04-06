import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';
import { parseEnvFile } from './mcp.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'mxbai-embed-large';
const DEFAULT_BACKFILL_BATCH_SIZE = 100;
const DEFAULT_JOB_LOG_DIR = join(homedir(), '.ink', 'logs', 'jobs');

interface InstallOptions {
  model?: string;
  skipPull?: boolean;
  all?: boolean;
}

interface BackfillOptions {
  userId?: string;
  agent?: string;
  limit?: string;
  batchSize?: string;
  dryRun?: boolean;
  logFile?: string;
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

function getWorktrees(cwd: string): string[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Array.from(
      new Set(
        output
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length))
          .filter((worktreePath) => existsSync(worktreePath))
      )
    );
  } catch {
    return [cwd];
  }
}

function readUserIdFromConfig(): string | undefined {
  try {
    const configPath = join(homedir(), '.ink', 'config.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { userId?: string };
    return raw.userId;
  } catch {
    return undefined;
  }
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

function formatJobTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function buildDefaultJobLogPath(jobName: string, date = new Date()): string {
  return join(DEFAULT_JOB_LOG_DIR, `${jobName}-${formatJobTimestamp(date)}.log`);
}

async function runStreamingCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile?: string } = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!options.logFile) {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit',
        shell: false,
      });

      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      });
      return;
    }

    mkdirSync(dirname(options.logFile), { recursive: true });
    const logStream = createWriteStream(options.logFile, { flags: 'a' });
    logStream.write(
      `[${new Date().toISOString()}] Starting command in ${options.cwd || process.cwd()}: ${command} ${args.join(' ')}\n`
    );

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });

    const writeChunk = (target: NodeJS.WriteStream, chunk: string | Buffer) => {
      target.write(chunk);
      logStream.write(chunk);
    };

    child.stdout?.on('data', (chunk) => writeChunk(process.stdout, chunk));
    child.stderr?.on('data', (chunk) => writeChunk(process.stderr, chunk));

    child.once('error', (error) => {
      logStream.write(`[${new Date().toISOString()}] Command failed to start: ${error.message}\n`);
      logStream.end(() => reject(error));
    });
    child.once('exit', (code) => {
      logStream.write(`[${new Date().toISOString()}] Command exited with code ${code ?? 'null'}\n`);
      logStream.end(() => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      });
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
  const spinner = ora('Checking Ollama installation').start();

  if (!(await commandExists('ollama'))) {
    spinner.fail('Ollama is not installed');
    for (const line of formatInstallInstructions()) {
      console.log(chalk.dim(line));
    }
    process.exit(1);
  }

  spinner.succeed('Ollama is installed');

  const worktrees = options.all ? getWorktrees(cwd) : [cwd];
  const baseUrl = parseEnvFile(join(cwd, '.env.local')).OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;

  if (!options.skipPull) {
    console.log(chalk.bold(`\nPulling embedding model: ${model}\n`));
    await runStreamingCommand('ollama', ['pull', model]);
  }

  const reachable = await checkOllama(baseUrl);
  if (!reachable) {
    console.log(chalk.yellow(`\nWarning: could not reach Ollama at ${baseUrl}`));
    console.log(chalk.dim('If Ollama is installed but not running, start it with `ollama serve`.'));
  }

  const updatedEnvPaths: string[] = [];
  for (const worktree of worktrees) {
    const envPath = join(worktree, '.env.local');
    upsertEnvFile(envPath, {
      MEMORY_EMBEDDINGS_ENABLED: 'true',
      MEMORY_EMBEDDING_PROVIDER: 'ollama',
      MEMORY_EMBEDDING_MODEL: model,
      OLLAMA_BASE_URL: baseUrl,
    });
    updatedEnvPaths.push(envPath);
  }

  console.log(chalk.green('\n✓ Memory embeddings configured\n'));
  for (const envPath of updatedEnvPaths) {
    console.log(chalk.dim(`Updated: ${envPath}`));
  }
  console.log(chalk.dim('Next useful commands:'));
  console.log(chalk.dim('  ink memory backfill'));
  console.log(chalk.dim('  yarn benchmark:memory-recall'));
  console.log(chalk.dim('  yarn benchmark:bootstrap-relevance'));
}

async function backfillCommand(options: BackfillOptions): Promise<void> {
  const cwd = process.env.INIT_CWD || process.cwd();
  const userId = options.userId || readUserIdFromConfig();

  if (!userId) {
    throw new Error(
      'Could not determine PCP userId. Pass --user-id <uuid> or ensure ~/.ink/config.json contains userId.'
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKFILL_MEMORY_USER_ID: userId,
  };

  if (options.agent) env.BACKFILL_MEMORY_AGENT_ID = options.agent;
  if (options.limit) env.BACKFILL_MEMORY_LIMIT = options.limit;
  if (options.batchSize) env.BACKFILL_MEMORY_BATCH_SIZE = options.batchSize;
  if (options.dryRun) env.BACKFILL_MEMORY_DRY_RUN = 'true';

  const logFile = options.logFile || buildDefaultJobLogPath('memory-backfill');
  console.log(chalk.dim(`Writing job log to ${logFile}`));

  await runStreamingCommand('yarn', ['workspace', '@inklabs/api', 'backfill:memory-embeddings'], {
    cwd,
    env,
    logFile,
  });
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Manage memory retrieval features');

  memory
    .command('install')
    .description('Install and configure local memory embeddings via Ollama')
    .option('--model <name>', 'Ollama embedding model to pull', DEFAULT_OLLAMA_MODEL)
    .option('--all', 'Write memory embedding config into every git worktree in this repo')
    .option('--skip-pull', 'Skip `ollama pull` if the model is already installed')
    .action((options: InstallOptions) => {
      installCommand(options).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Memory install failed: ${message}`));
        process.exit(1);
      });
    });

  memory
    .command('backfill')
    .description('Generate embeddings for existing memories that do not have them yet')
    .option('--user-id <uuid>', 'PCP user ID to backfill (defaults to ~/.ink/config.json userId)')
    .option('--agent <id>', 'Optional agent filter (e.g. lumen, wren)')
    .option('--limit <n>', 'Maximum number of memories to backfill in this run')
    .option(
      '--batch-size <n>',
      'Number of memories to process per DB fetch',
      String(DEFAULT_BACKFILL_BATCH_SIZE)
    )
    .option('--dry-run', 'Show what would be backfilled without writing embeddings')
    .option(
      '--log-file <path>',
      'Write a dedicated job log for this run (defaults to ~/.ink/logs/jobs/memory-backfill-<timestamp>.log)'
    )
    .action((options: BackfillOptions) => {
      backfillCommand(options).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Memory backfill failed: ${message}`));
        process.exit(1);
      });
    });
}
