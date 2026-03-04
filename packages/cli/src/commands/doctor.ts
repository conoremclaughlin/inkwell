import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'fs';
import { basename, dirname, join, parse as parsePath, resolve } from 'path';
import { homedir } from 'os';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface DoctorResult {
  binaryName: string;
  linkPath: string;
  expectedTarget?: string;
  resolvedTarget?: string;
  checks: DoctorCheck[];
}

interface DoctorFs {
  existsSync(path: string): boolean;
  lstatSync(path: string): { isSymbolicLink(): boolean };
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  statSync(path: string): { mode: number };
  readFileSync(path: string, encoding: 'utf-8'): string;
}

const defaultFs: DoctorFs = {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  readFileSync,
};

type MigrationStatusResult = {
  target?: 'linked' | 'local';
  state?: 'clean' | 'pending' | 'unknown';
  reason?: string | null;
  pendingCount?: number;
  pending?: string[];
};
const MIGRATION_CHECK_NAME = 'Migrations';

function resolveCliRoot(fsOps: Pick<DoctorFs, 'existsSync' | 'readFileSync'>): string {
  let dir = process.cwd();
  const { root } = parsePath(dir);
  while (true) {
    for (const candidate of [join(dir, 'packages', 'cli'), dir]) {
      const pkgPath = join(candidate, 'package.json');
      if (fsOps.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fsOps.readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === '@personal-context/cli') return candidate;
        } catch {
          // continue walking
        }
      }
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error('Could not find @personal-context/cli package. Run from within the repo.');
}

function resolveDefaultCliName(fsOps: Pick<DoctorFs, 'existsSync' | 'readFileSync'>): string {
  const invokedCandidates = [process.argv[1], process.env._]
    .map((value) => basename(String(value || '')).trim())
    .filter(Boolean);
  for (const candidate of invokedCandidates) {
    if (/^sb(?:-[a-z0-9][a-z0-9_-]*)?$/i.test(candidate)) {
      return candidate.toLowerCase();
    }
  }

  const fromEnv = process.env.AGENT_ID?.trim().toLowerCase();
  if (fromEnv) return `sb-${fromEnv}`;

  const cwd = process.cwd();
  const identityPath = join(cwd, '.pcp', 'identity.json');
  if (fsOps.existsSync(identityPath)) {
    try {
      const identity = JSON.parse(fsOps.readFileSync(identityPath, 'utf-8'));
      if (identity.agentId) return `sb-${identity.agentId}`;
    } catch {
      // fall through
    }
  }
  const dirName = basename(cwd);
  const match = dirName.match(/--(.+)$/);
  if (match) return `sb-${match[1]}`;
  return 'sb';
}

export function analyzeCliLink(
  options: { name?: string; binDir?: string },
  fsOps: DoctorFs = defaultFs
): DoctorResult {
  const binDir = options.binDir || join(homedir(), '.local', 'bin');
  const binaryName = options.name || resolveDefaultCliName(fsOps);
  const linkPath = join(binDir, binaryName);
  const checks: DoctorCheck[] = [];

  let expectedTarget: string | undefined;
  try {
    expectedTarget = join(resolveCliRoot(fsOps), 'dist', 'cli.js');
  } catch {
    checks.push({
      name: 'CLI root',
      status: 'warn',
      detail: 'Could not resolve @personal-context/cli root from current directory.',
    });
  }

  if (!fsOps.existsSync(linkPath)) {
    const fixCmd = buildFixCommand(binaryName);
    checks.push({
      name: 'Linked binary',
      status: 'fail',
      detail: `Missing ${linkPath} (run: ${fixCmd})`,
    });
    return { binaryName, linkPath, expectedTarget, checks };
  }

  const isSymlink = fsOps.lstatSync(linkPath).isSymbolicLink();
  if (!isSymlink) {
    checks.push({
      name: 'Linked binary',
      status: 'fail',
      detail: `${linkPath} exists but is not a symlink.`,
    });
    return { binaryName, linkPath, expectedTarget, checks };
  }

  const rawTarget = fsOps.readlinkSync(linkPath);
  const resolvedTarget = rawTarget.startsWith('/') ? rawTarget : resolve(binDir, rawTarget);

  checks.push({
    name: 'Symlink',
    status: 'ok',
    detail: `${linkPath} → ${resolvedTarget}`,
  });

  if (!fsOps.existsSync(resolvedTarget)) {
    checks.push({
      name: 'Target exists',
      status: 'fail',
      detail: `Symlink target missing: ${resolvedTarget}`,
    });
    return { binaryName, linkPath, expectedTarget, resolvedTarget, checks };
  }

  checks.push({
    name: 'Target exists',
    status: 'ok',
    detail: resolvedTarget,
  });

  try {
    const mode = fsOps.statSync(resolvedTarget).mode;
    const executable = (mode & 0o111) !== 0;
    checks.push({
      name: 'Executable bit',
      status: executable ? 'ok' : 'warn',
      detail: executable
        ? 'Target is executable.'
        : 'Target is not executable (chmod +x may be needed).',
    });
  } catch {
    checks.push({
      name: 'Executable bit',
      status: 'warn',
      detail: 'Could not stat target mode.',
    });
  }

  if (expectedTarget) {
    const normalizedExpected = fsOps.existsSync(expectedTarget)
      ? fsOps.realpathSync(expectedTarget)
      : expectedTarget;
    const normalizedResolved = fsOps.realpathSync(resolvedTarget);
    const matches = normalizedExpected === normalizedResolved;
    checks.push({
      name: 'Studio target match',
      status: matches ? 'ok' : 'warn',
      detail: matches
        ? 'Linked binary points at this studio CLI build.'
        : `Linked binary points elsewhere.\n      expected: ${normalizedExpected}\n      actual:   ${normalizedResolved}`,
    });
  }

  const pathList = (process.env.PATH || '').split(':').filter(Boolean);
  const onPath = pathList.includes(binDir);
  checks.push({
    name: 'PATH',
    status: onPath ? 'ok' : 'warn',
    detail: onPath ? `${binDir} is on PATH.` : `${binDir} is not on PATH.`,
  });

  return { binaryName, linkPath, expectedTarget, resolvedTarget, checks };
}

function iconForStatus(status: CheckStatus): string {
  if (status === 'ok') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('⚠');
  return chalk.red('✗');
}

function buildFixCommand(binaryName: string): string {
  if (binaryName === 'sb') return 'sb studio cli';
  return `sb studio cli --name ${binaryName}`;
}

function resolveRepoRoot(fsOps: Pick<DoctorFs, 'existsSync'>): string | undefined {
  let dir = process.cwd();
  const { root } = parsePath(dir);
  while (true) {
    if (fsOps.existsSync(join(dir, 'supabase', 'config.toml'))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return undefined;
}

function parseMigrationStatus(raw: string): MigrationStatusResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as MigrationStatusResult;
  } catch {
    return null;
  }
}

function formatPendingMigrationCheck(parsed: MigrationStatusResult): DoctorCheck {
  const pendingCount = parsed.pendingCount || parsed.pending?.length || 0;
  const pendingList = (parsed.pending || []).slice(0, 5).join(', ');
  const scope = parsed.target === 'local' ? 'local' : 'linked';
  return {
    name: MIGRATION_CHECK_NAME,
    status: 'warn',
    detail:
      `${pendingCount} pending ${scope} migration(s).` +
      `${pendingList ? `\n      pending: ${pendingList}` : ''}\n` +
      `      run: yarn prod:migrate (or one-shot: yarn prod:up)`,
  };
}

function buildMigrationHealthCheck(
  fsOps: Pick<DoctorFs, 'existsSync'> = defaultFs
): DoctorCheck | null {
  const repoRoot = resolveRepoRoot(fsOps);
  if (!repoRoot) return null;

  const scriptPath = join(repoRoot, 'scripts', 'migration-status.mjs');
  if (!fsOps.existsSync(scriptPath)) {
    return {
      name: MIGRATION_CHECK_NAME,
      status: 'warn',
      detail: `Missing scripts/migration-status.mjs at ${scriptPath}`,
    };
  }

  let raw = '';
  try {
    raw = execFileSync('node', [scriptPath, '--json', '--workdir', repoRoot], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: string }).stdout || '')
        : '';
    const parsed = parseMigrationStatus(stdout);
    if (parsed?.state === 'pending') {
      return formatPendingMigrationCheck(parsed);
    }

    const reason = parsed?.reason || String(error);
    return {
      name: MIGRATION_CHECK_NAME,
      status: 'warn',
      detail: `Unable to determine linked migration status.\n      ${reason}`,
    };
  }

  const parsed = parseMigrationStatus(raw);
  if (!parsed) {
    return {
      name: MIGRATION_CHECK_NAME,
      status: 'warn',
      detail: 'Unable to parse migration status output.',
    };
  }

  if (parsed.state === 'pending') {
    return formatPendingMigrationCheck(parsed);
  }

  if (parsed.state === 'clean') {
    const scope = parsed.target === 'local' ? 'local' : 'linked';
    return {
      name: MIGRATION_CHECK_NAME,
      status: 'ok',
      detail: `No pending ${scope} migrations.`,
    };
  }

  return {
    name: MIGRATION_CHECK_NAME,
    status: 'warn',
    detail: parsed.reason || 'Unable to determine linked migration status.',
  };
}

async function doctorCommand(options: {
  name?: string;
  json?: boolean;
  fix?: boolean;
}): Promise<void> {
  const result = analyzeCliLink({ name: options.name });
  const migrationCheck = buildMigrationHealthCheck();
  if (migrationCheck) {
    result.checks.push(migrationCheck);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    const hasFailure = result.checks.some((check) => check.status === 'fail');
    process.exit(hasFailure ? 1 : 0);
  }

  console.log(chalk.bold('\nSB CLI Doctor\n'));
  console.log(chalk.dim(`  Binary: ${result.binaryName}`));
  console.log(chalk.dim(`  Link:   ${result.linkPath}`));
  if (result.expectedTarget) {
    console.log(chalk.dim(`  Expect: ${result.expectedTarget}`));
  }
  console.log('');

  for (const check of result.checks) {
    const label =
      check.status === 'ok'
        ? chalk.green(check.name)
        : check.status === 'warn'
          ? chalk.yellow(check.name)
          : chalk.red(check.name);
    console.log(`  ${iconForStatus(check.status)} ${label}`);
    console.log(chalk.dim(`      ${check.detail}`));
  }
  console.log('');

  const hasFailure = result.checks.some((check) => check.status === 'fail');
  const hasStudioMismatch = result.checks.some(
    (check) => check.name === 'Studio target match' && check.status === 'warn'
  );
  const needsFix = hasFailure || hasStudioMismatch;

  if (needsFix) {
    const fixCmd = buildFixCommand(result.binaryName);
    console.log(chalk.bold('Suggested fix'));
    console.log(
      chalk.dim(
        `  From the studio you want this alias to point to, run:\n` +
          `  ${fixCmd}\n` +
          `  (If needed first: cd /path/to/your-studio)`
      )
    );

    if (options.fix) {
      const rl = createInterface({ input, output });
      try {
        const answer = (
          await rl.question(chalk.yellow(`\nRun that fix now from current directory? [y/N]: `))
        )
          .trim()
          .toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          execSync(fixCmd, { stdio: 'inherit' });
          console.log(chalk.green('\nApplied fix command.'));
        } else {
          console.log(chalk.dim('Skipped fix command.'));
        }
      } catch (error) {
        console.error(chalk.red(`Failed to apply fix: ${String(error)}`));
        process.exit(1);
      } finally {
        rl.close();
      }
    } else {
      console.log(
        chalk.dim('\nTip: run sb doctor --fix to confirm and apply from this directory.')
      );
    }
    console.log('');
  }

  if (hasFailure) {
    process.exit(1);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Inspect studio-linked SB CLI binary and target health')
    .option('-n, --name <name>', 'Binary name (default: sb-<agent>)')
    .option('--json', 'Output machine-readable JSON')
    .option('--fix', 'Prompt to run studio link fix command from current directory')
    .action(doctorCommand);
}
