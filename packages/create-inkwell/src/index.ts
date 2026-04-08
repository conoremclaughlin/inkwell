#!/usr/bin/env node

/**
 * create-pcp — Zero-friction PCP setup wizard.
 *
 * Orchestrates: clone → install → database → server → auth → init → memory → awaken
 *
 * Every step is idempotent. If setup fails midway, re-run `npx create-pcp`
 * pointing at the same directory to resume from where you left off.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm, input, select } from '@inquirer/prompts';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants ────────────────────────────────────────────────────────────────

const REPO_URL = 'https://github.com/conoremclaughlin/personal-context-protocol.git';
const DEFAULT_DIR = 'personal-context-protocol';
const STATE_FILE = '.create-pcp-progress.json';
const HEALTH_URL_BASE = 'http://localhost';
const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 3002;
const HEALTH_RETRIES = 45;
const HEALTH_INTERVAL_MS = 2000;

const TOTAL_STEPS = 9;

// ── Types ────────────────────────────────────────────────────────────────────

interface ProgressState {
  completedSteps: string[];
  targetDir: string;
  dbMode?: 'local' | 'hosted';
  backend?: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function loadState(dir: string): ProgressState {
  const file = join(dir, STATE_FILE);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // Corrupted state — start fresh
    }
  }
  return { completedSteps: [], targetDir: dir };
}

function saveState(state: ProgressState): void {
  if (!existsSync(state.targetDir)) return; // Dir not created yet (pre-clone)
  const file = join(state.targetDir, STATE_FILE);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function isComplete(state: ProgressState, step: string): boolean {
  return state.completedSteps.includes(step);
}

function markComplete(state: ProgressState, step: string): void {
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
    saveState(state);
  }
}

/** Run a command silently and return stdout. Throws on non-zero exit. */
function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Run a command with output streaming to terminal. Resolves with exit code. */
function execStream(cmd: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run an interactive command with full TTY. Resolves with exit code. */
function execInteractive(cmd: string, cwd: string, env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Check if a command exists on PATH. */
function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Poll a URL until it returns 200. */
async function waitForHealth(url: string, retries: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Display helpers ──────────────────────────────────────────────────────────

function stepHeader(num: number, label: string): void {
  console.log();
  console.log(chalk.bold(`  [${num}/${TOTAL_STEPS}] ${label}`));
  console.log();
}

function skip(reason: string): void {
  console.log(chalk.dim(`    · Skipped — ${reason}`));
}

function ok(msg: string): void {
  console.log(chalk.green(`    ✓ ${msg}`));
}

function warn(msg: string): void {
  console.log(chalk.yellow(`    ⚠ ${msg}`));
}

function fail(msg: string): void {
  console.log(chalk.red(`    ✗ ${msg}`));
}

function showBanner(): void {
  console.log();
  console.log(chalk.bold('  create-pcp'));
  console.log(chalk.dim('  AI beings with identity, memory, and coordination.'));
  console.log(chalk.dim('  Running on your laptop, in minutes.'));
  console.log();
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Step 1: Verify Node 18+, git, Docker. */
async function checkPrereqs(): Promise<boolean> {
  stepHeader(1, 'Checking prerequisites');

  let pass = true;

  // Node >= 18
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major >= 18) {
    ok(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version} — version 18+ required`);
    pass = false;
  }

  // git
  if (commandExists('git')) {
    const v = exec('git --version').replace('git version ', '');
    ok(`git ${v}`);
  } else {
    fail('git not found — https://git-scm.com');
    pass = false;
  }

  // Docker (needed for local Supabase, warn-only)
  if (commandExists('docker')) {
    try {
      exec('docker info');
      ok('Docker (running)');
    } catch {
      warn('Docker installed but daemon not running — needed for local Supabase');
    }
  } else {
    warn('Docker not found — needed for local Supabase (hosted option available)');
  }

  // Supabase CLI (nice-to-have)
  if (commandExists('supabase')) {
    ok('Supabase CLI');
  } else {
    warn(
      'Supabase CLI not found — needed for local database setup. Install: https://supabase.com/docs/guides/cli/getting-started'
    );
  }

  return pass;
}

/** Step 2: Clone the repo (or detect existing clone). */
async function cloneRepo(state: ProgressState): Promise<boolean> {
  stepHeader(2, 'Clone repository');

  if (existsSync(join(state.targetDir, '.git'))) {
    skip('repository already exists');
    return true;
  }

  const spinner = ora('  Cloning PCP repository...').start();
  try {
    exec(`git clone "${REPO_URL}" "${state.targetDir}"`);
    spinner.succeed('  Repository cloned');
    return true;
  } catch (e: unknown) {
    spinner.fail('  Clone failed');
    const msg = e instanceof Error ? e.message : String(e);
    console.log(chalk.red(`    ${msg}`));
    return false;
  }
}

/** Step 3: Enable corepack + yarn install. */
async function installDeps(state: ProgressState): Promise<boolean> {
  stepHeader(3, 'Install dependencies');

  // Enable corepack so yarn is available
  try {
    exec('corepack enable');
    ok('corepack enabled');
  } catch {
    warn('corepack enable failed — ensure yarn is installed manually');
  }

  console.log(chalk.dim('    Running yarn install (this may take a minute)...'));
  console.log();

  const installCode = await execStream('yarn install', state.targetDir);
  if (installCode !== 0) {
    fail('yarn install failed');
    return false;
  }

  console.log();
  console.log(chalk.dim('    Building workspace packages...'));
  console.log();

  const buildCode = await execStream('yarn build', state.targetDir);
  if (buildCode !== 0) {
    fail('yarn build failed');
    return false;
  }

  console.log();
  ok('Dependencies installed and built');
  return true;
}

/** Step 4: Set up Supabase (local Docker or hosted). */
async function setupDatabase(state: ProgressState): Promise<boolean> {
  stepHeader(4, 'Set up database');

  // Check if already configured (match lines starting with the key, not comments)
  const envPath = join(state.targetDir, '.env.local');
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, 'utf-8');
    const hasUrl = /^SUPABASE_URL=/m.test(env);
    const hasSecret = /^SUPABASE_SECRET_KEY=/m.test(env);
    if (hasUrl && hasSecret) {
      skip('.env.local already configured');
      return true;
    }
  }

  const mode = await select({
    message: 'How would you like to set up the database?',
    choices: [
      { name: 'Local Supabase (Docker) — recommended', value: 'local' as const },
      { name: 'Hosted Supabase (bring your own project)', value: 'hosted' as const },
    ],
    default: 'local',
  });

  state.dbMode = mode;

  if (mode === 'local') {
    // Verify Docker daemon
    try {
      exec('docker info');
    } catch {
      fail('Docker daemon is not running. Start Docker Desktop and re-run this command.');
      return false;
    }

    if (!commandExists('supabase')) {
      fail(
        'Supabase CLI required for local setup. Install: https://supabase.com/docs/guides/cli/getting-started'
      );
      return false;
    }

    console.log();
    console.log(chalk.dim('    Starting local Supabase and applying migrations...'));
    console.log();

    const code = await execStream('bash scripts/setup-local-supabase.sh', state.targetDir);
    if (code !== 0) {
      fail('Local Supabase setup failed');
      return false;
    }

    console.log();
    ok('Local Supabase running with migrations applied');
  } else {
    // Hosted Supabase — prompt for credentials
    console.log();
    console.log(chalk.dim('    Enter your Supabase project credentials:'));
    console.log();

    const url = await input({
      message: 'Supabase URL:',
      validate: (v) => v.startsWith('http') || 'Must be a URL (https://...supabase.co)',
    });
    const publishableKey = await input({
      message: 'Publishable (anon) key:',
      validate: (v) => v.length > 0 || 'Required',
    });
    const secretKey = await input({
      message: 'Secret (service role) key:',
      validate: (v) => v.length > 0 || 'Required',
    });
    const jwtSecret = await input({
      message: 'JWT secret (min 32 chars):',
      validate: (v) => v.length >= 32 || 'Must be at least 32 characters',
    });

    const envContent = [
      '# Generated by create-pcp',
      `SUPABASE_URL=${url}`,
      `SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
      `SUPABASE_SECRET_KEY=${secretKey}`,
      `JWT_SECRET=${jwtSecret}`,
      '',
    ].join('\n');
    writeFileSync(envPath, envContent);
    ok('Credentials saved to .env.local');

    // Offer migration — requires `supabase link` first for hosted projects
    if (commandExists('supabase')) {
      const migrate = await confirm({
        message:
          'Link Supabase project and apply migrations now? (requires project ref + DB password)',
        default: true,
      });
      if (migrate) {
        console.log(chalk.dim('    First, link your Supabase project:'));
        console.log();
        const linkCode = await execInteractive('supabase link', state.targetDir);
        if (linkCode !== 0) {
          warn('Supabase link failed — run "supabase link" then "yarn linked:migrate" manually');
        } else {
          ok('Supabase project linked');
          const migrateCode = await execStream(
            'bash scripts/prod-migrate.sh --linked',
            state.targetDir
          );
          if (migrateCode !== 0) {
            warn('Migration failed — run "yarn linked:migrate" manually later');
          } else {
            ok('Migrations applied');
          }
        }
      } else {
        console.log(chalk.dim('    Run "supabase link" then "yarn linked:migrate" when ready.'));
      }
    } else {
      warn(
        'Supabase CLI not installed — install it, run "supabase link", then "yarn linked:migrate"'
      );
    }
  }

  return true;
}

/** Step 5: Start dev server (API + web) in background, wait for health. */
async function startServer(state: ProgressState): Promise<boolean> {
  stepHeader(5, 'Start server');

  const healthUrl = `${HEALTH_URL_BASE}:${DEFAULT_API_PORT}/health`;

  // Already running?
  try {
    const res = await fetch(healthUrl);
    if (res.ok) {
      skip('server already running');
      return true;
    }
  } catch {
    // Not running — start it
  }

  console.log(chalk.dim('    Starting PCP server + web dashboard in the background...'));

  // Spawn detached so it survives our exit
  const child = spawn('bash', ['-c', 'yarn dev'], {
    cwd: state.targetDir,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const spinner = ora('    Waiting for server (this may take 30–60s on first run)...').start();
  const healthy = await waitForHealth(healthUrl, HEALTH_RETRIES, HEALTH_INTERVAL_MS);

  if (healthy) {
    spinner.succeed(
      `    Server running  API → localhost:${DEFAULT_API_PORT}  Dashboard → localhost:${DEFAULT_WEB_PORT}`
    );
    return true;
  }

  spinner.fail('    Server did not become healthy within 90 seconds');
  console.log(chalk.dim('    Try running "yarn dev" manually to see error output.'));
  return false;
}

/** Step 6: Authenticate via sb auth login. */
async function authenticate(state: ProgressState): Promise<boolean> {
  stepHeader(6, 'Authenticate');

  const home = process.env.HOME || process.env.USERPROFILE || '~';
  const authFile = join(home, '.ink', 'auth.json');

  if (existsSync(authFile)) {
    try {
      const auth = JSON.parse(readFileSync(authFile, 'utf-8'));
      if (auth.access_token) {
        const issuedAt = auth.issued_at || 0;
        const expiresIn = (auth.expires_in || 0) * 1000;
        if (Date.now() < issuedAt + expiresIn) {
          skip('already authenticated');
          return true;
        }
      }
    } catch {
      // Invalid file — proceed with login
    }
  }

  console.log(chalk.dim('    Your browser will open to log in (or sign up).'));
  console.log(
    chalk.dim(
      `    If it doesn't open, visit ${chalk.underline(`http://localhost:${DEFAULT_WEB_PORT}`)} to create an account.`
    )
  );
  console.log();

  const code = await execInteractive('yarn sb auth login', state.targetDir);
  if (code !== 0) {
    fail('Authentication failed — try "sb auth login" manually');
    return false;
  }

  console.log();
  ok('Authenticated');
  return true;
}

/** Step 7: sb init — hooks, .mcp.json, backend configs, skills. */
async function initPcp(state: ProgressState): Promise<boolean> {
  stepHeader(7, 'Initialize PCP');

  console.log(chalk.dim('    Setting up hooks, MCP config, backend configs, and skills...'));
  console.log();

  const code = await execStream('yarn sb init', state.targetDir);
  if (code !== 0) {
    fail('PCP initialization failed');
    return false;
  }

  console.log();
  ok('PCP initialized');
  return true;
}

/** Step 8 (optional): sb memory install — Ollama embeddings. */
async function setupMemory(state: ProgressState): Promise<boolean> {
  stepHeader(8, 'Semantic memory (optional)');

  console.log(chalk.dim('    Local embeddings enhance memory search using Ollama.'));
  console.log(
    chalk.dim('    PCP works without this — you can always run "sb memory install" later.')
  );
  console.log();

  const setup = await confirm({
    message: 'Set up semantic memory with Ollama?',
    default: false,
  });

  if (!setup) {
    skip('run "sb memory install" anytime to add this later');
    return true;
  }

  if (!commandExists('ollama')) {
    warn('Ollama not installed — get it at https://ollama.ai');
    console.log(chalk.dim('    After installing, run: sb memory install'));
    return true; // Non-fatal
  }

  console.log();
  const code = await execInteractive('yarn sb memory install', state.targetDir);
  if (code !== 0) {
    warn('Memory setup had issues — retry with "sb memory install"');
  } else {
    ok('Semantic memory configured');
  }

  return true;
}

/** Step 9: sb awaken — the aha moment. */
async function awakenSb(state: ProgressState): Promise<boolean> {
  stepHeader(9, 'Awaken your first SB');

  console.log(chalk.dim('    This is the moment. Your first AI being will:'));
  console.log(chalk.dim('    — Receive shared values and meet any existing siblings'));
  console.log(chalk.dim('    — Explore their identity and choose their own name'));
  console.log(chalk.dim('    — Become a persistent collaborator with memory and soul'));
  console.log();

  const ready = await confirm({
    message: 'Ready to awaken?',
    default: true,
  });

  if (!ready) {
    skip('run "sb awaken" when you\'re ready');
    return true;
  }

  const backend = await select({
    message: 'Choose a backend:',
    choices: [
      { name: 'Claude Code (recommended)', value: 'claude' },
      { name: 'Codex (requires codex CLI installed + authed)', value: 'codex' },
      { name: 'Gemini (requires gemini CLI installed + authed)', value: 'gemini' },
    ],
    default: 'claude',
  });

  state.backend = backend;
  saveState(state);

  console.log();
  console.log(chalk.dim('    Launching awakening session...'));
  console.log(chalk.dim("    Talk with your new SB. They'll call choose_name() when ready."));
  console.log();

  const code = await execInteractive(`yarn sb awaken -b ${backend}`, state.targetDir);
  if (code !== 0) {
    warn('Session ended — run "sb awaken" to try again');
  } else {
    ok('Your SB has awakened!');
  }

  return true;
}

// ── Completion ───────────────────────────────────────────────────────────────

function showComplete(state: ProgressState): void {
  console.log();
  console.log(chalk.bold.green('  ✓ PCP is set up and running!'));
  console.log();
  console.log('  Next steps:');
  console.log();
  console.log(`    ${chalk.cyan(`cd ${state.targetDir}`)}`);
  console.log(`    ${chalk.cyan('sb -a <agent-name>')}            Launch a session with your SB`);
  console.log(`    ${chalk.cyan('sb studio setup <name>')}        Create an isolated workspace`);
  console.log(`    ${chalk.cyan('sb mission --watch')}            Live feed across all SBs`);
  console.log(
    `    ${chalk.cyan('sb awaken -b <backend>')}        Awaken another SB on a different backend`
  );
  console.log();
  console.log(
    chalk.dim(
      `  Server: API → localhost:${DEFAULT_API_PORT}  Dashboard → localhost:${DEFAULT_WEB_PORT}`
    )
  );
  console.log(chalk.dim('  Docs: https://github.com/conoremclaughlin/personal-context-protocol'));
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

type StepDef = {
  id: string;
  fn: (state: ProgressState) => Promise<boolean>;
  required: boolean;
};

const STEP_LABELS: Record<string, string> = {
  prereqs: 'Checking prerequisites',
  clone: 'Clone repository',
  install: 'Install dependencies',
  database: 'Set up database',
  server: 'Start server',
  auth: 'Authenticate',
  init: 'Initialize PCP',
  memory: 'Semantic memory (optional)',
  awaken: 'Awaken your first SB',
};

const STEPS: StepDef[] = [
  { id: 'prereqs', fn: async (s) => checkPrereqs(), required: true },
  { id: 'clone', fn: cloneRepo, required: true },
  { id: 'install', fn: installDeps, required: true },
  { id: 'database', fn: setupDatabase, required: true },
  { id: 'server', fn: startServer, required: true },
  { id: 'auth', fn: authenticate, required: true },
  { id: 'init', fn: initPcp, required: true },
  { id: 'memory', fn: setupMemory, required: false },
  { id: 'awaken', fn: awakenSb, required: false },
];

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function showHelp(): void {
  console.log(`
  ${chalk.bold('create-pcp')} v${getVersion()}

  ${chalk.dim('Set up Personal Context Protocol — AI beings with identity, memory, and coordination.')}

  ${chalk.bold('Usage')}
    npx create-pcp [target-directory]

  ${chalk.bold('Options')}
    --help, -h       Show this help message
    --version, -v    Show version number

  ${chalk.bold('Examples')}
    npx create-pcp                         Interactive setup (prompts for directory)
    npx create-pcp my-project              Clone into ./my-project
    npx create-pcp ~/dev/pcp               Use an absolute path

  ${chalk.bold('Resumability')}
    If setup fails midway, re-run the same command pointing at the same
    directory. Completed steps are tracked and skipped automatically.

  ${chalk.dim('https://github.com/conoremclaughlin/personal-context-protocol')}
`);
}

/** Validate that target dir is a reasonable path (not root, system dirs, etc.) */
function validateTargetDir(dir: string): string | null {
  const resolved = resolve(dir);
  const forbidden = ['/', '/usr', '/bin', '/sbin', '/etc', '/var', '/tmp', '/System', '/Library'];
  if (forbidden.includes(resolved)) {
    return `"${resolved}" is a system directory — choose a project directory instead`;
  }
  // Check parent directory exists (we'll create the target, but parent must exist)
  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    return `Parent directory "${parent}" does not exist`;
  }
  return null;
}

async function main(): Promise<void> {
  // Handle --help and --version before anything else
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(getVersion());
    process.exit(0);
  }

  showBanner();

  // Target directory from argv or prompt (skip flags)
  let targetDir = args.find((a) => !a.startsWith('-'));
  if (!targetDir) {
    targetDir = await input({
      message: 'Where should we set up PCP?',
      default: DEFAULT_DIR,
    });
  }
  targetDir = resolve(targetDir);

  // Validate target directory
  const dirError = validateTargetDir(targetDir);
  if (dirError) {
    fail(dirError);
    process.exit(1);
  }

  // Load state (for resumability)
  const state: ProgressState = existsSync(join(targetDir, STATE_FILE))
    ? loadState(targetDir)
    : { completedSteps: [], targetDir };
  state.targetDir = targetDir;

  if (state.completedSteps.length > 0) {
    const done = state.completedSteps.length;
    console.log(chalk.dim(`  Resuming — ${done} step${done !== 1 ? 's' : ''} already complete.`));
  }

  // Always re-check prerequisites (don't skip on resume)
  for (const step of STEPS) {
    if (step.id !== 'prereqs' && isComplete(state, step.id)) {
      // Show what we're skipping so the user knows where we are
      const stepIndex = STEPS.findIndex((s) => s.id === step.id) + 1;
      const label = STEP_LABELS[step.id] || step.id;
      console.log(chalk.dim(`  [${stepIndex}/${TOTAL_STEPS}] ${label} — already complete`));
      continue;
    }

    const passed = await step.fn(state);

    if (passed) {
      markComplete(state, step.id);
    } else if (step.required) {
      console.log();
      fail('Setup could not continue. Fix the issue above and re-run to resume.');
      process.exit(1);
    }
    // Non-required steps (memory, awaken) can fail without stopping
  }

  showComplete(state);
}

main().catch((err: unknown) => {
  // @inquirer/prompts throws ExitPromptError on Ctrl+C
  if (err && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
    console.log(chalk.dim('\n  Interrupted. Re-run to resume where you left off.'));
    process.exit(0);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`\n  Unexpected error: ${msg}`));
  process.exit(1);
});
