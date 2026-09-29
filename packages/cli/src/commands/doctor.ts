import { Command } from 'commander';
import chalk from 'chalk';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'fs';
import { basename, dirname, join, parse as parsePath, resolve } from 'path';
import { homedir } from 'os';
import { normalizeIdentityJson } from '../backends/identity.js';
import { auditStudio, type StudioAudit } from '@inklabs/shared';
import { detectWorktree } from './init.js';
import { callInkTool } from '../lib/ink-mcp.js';

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

/**
 * What the server knows about the studio this worktree claims to be.
 * `unrecorded`: a row exists for this path but identity.json does not carry
 * its id — the shape of every studio created before the checklist, which
 * used to read as "no studio row" although the server had one.
 */
export type StudioRegistration =
  | 'registered'
  | 'unrecorded'
  | 'unregistered'
  | 'unreachable'
  | 'not-applicable';

/**
 * The studio checklist as doctor checks (task c3b34be8): every item the
 * shared audit judges, plus the one item only the server can answer — that
 * the studio id in identity.json names a row it still has. A required item
 * that is missing fails; a reported-only item warns. The repair is always
 * the same command, so it is named once, below the list.
 */
export function studioChecksFrom(
  audit: StudioAudit,
  registration: StudioRegistration
): DoctorCheck[] {
  const checks: DoctorCheck[] = audit.checks.map((check) => ({
    name: `Studio: ${check.label}`,
    status: check.ok ? 'ok' : check.required ? 'fail' : 'warn',
    detail: check.ok ? check.detail : `${check.detail} — repair: ${check.repair}`,
  }));
  if (registration !== 'not-applicable') {
    checks.push({
      name: 'Studio: registered on the server',
      status:
        registration === 'registered' ? 'ok' : registration === 'unreachable' ? 'warn' : 'fail',
      detail:
        registration === 'registered'
          ? 'the studio id in identity.json names a row the server has'
          : registration === 'unreachable'
            ? 'server not reachable; could not confirm the studio row'
            : registration === 'unrecorded'
              ? 'the server has a studio row for this worktree, but identity.json does not record its id — repair: ink init'
              : 'no studio row for this worktree — repair: ink init',
    });
  }
  return checks;
}

/**
 * Ask the server whether the studio is registered; never throws. With an id
 * from identity.json, that id must name a row. Without one, the worktree
 * path is looked up the way the launcher does, so a row the server has is
 * reported as such rather than as missing.
 */
export async function probeRegistration(
  studioId: string | undefined,
  worktreePath: string,
  call: typeof callInkTool = callInkTool
): Promise<StudioRegistration> {
  const found = (result: Record<string, unknown> | undefined) =>
    !!result && (!!result.studio || result.success === true);
  try {
    if (studioId) {
      return found(await call('get_studio', { studioId })) ? 'registered' : 'unregistered';
    }
    return found(await call('get_studio', { path: worktreePath })) ? 'unrecorded' : 'unregistered';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not found|no studio|unknown studio/i.test(message) ? 'unregistered' : 'unreachable';
  }
}

async function buildStudioChecks(cwd: string): Promise<DoctorCheck[]> {
  const placement = detectWorktree(cwd);
  if (!placement.toplevel) return [];
  const audit = auditStudio(placement.toplevel, { linked: placement.linked });
  let registration: StudioRegistration = 'not-applicable';
  if (placement.linked) {
    const identity = audit.checks.find((c) => c.id === 'studio-id');
    const studioId = identity?.ok ? identity.detail.replace(/^studioId /, '') : undefined;
    registration = await probeRegistration(studioId, placement.toplevel);
  }
  return studioChecksFrom(audit, registration);
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
          if (pkg.name === '@inklabs/cli') return candidate;
        } catch {
          // continue walking
        }
      }
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error('Could not find @inklabs/cli package. Run from within the repo.');
}

function resolveDefaultCliName(fsOps: Pick<DoctorFs, 'existsSync' | 'readFileSync'>): string {
  const invokedCandidates = [process.argv[1], process.env._]
    .map((value) => basename(String(value || '')).trim())
    .filter(Boolean);
  for (const candidate of invokedCandidates) {
    if (/^ink(?:-[a-z0-9][a-z0-9_-]*)?$/i.test(candidate)) {
      return candidate.toLowerCase();
    }
  }

  const fromEnv = (process.env.SB_SLUG || process.env.AGENT_ID)?.trim().toLowerCase();
  if (fromEnv) return `ink-${fromEnv}`;

  const cwd = process.cwd();
  const identityPath = join(cwd, '.ink', 'identity.json');
  if (fsOps.existsSync(identityPath)) {
    try {
      const identity = normalizeIdentityJson(
        JSON.parse(fsOps.readFileSync(identityPath, 'utf-8'))
      ) as { sbSlug?: string };
      if (identity.sbSlug) return `ink-${identity.sbSlug}`;
    } catch {
      // fall through
    }
  }
  const dirName = basename(cwd);
  const match = dirName.match(/--(.+)$/);
  if (match) return `ink-${match[1]}`;
  return 'ink';
}

export function analyzeCliLink(
  options: { name?: string; binDir?: string },
  fsOps: DoctorFs = defaultFs
): DoctorResult {
  const binDir = options.binDir || join(homedir(), '.local', 'bin');
  const binaryName = options.name || resolveDefaultCliName(fsOps);
  buildFixArgs(binaryName); // validate before it is used as a path or suggested command
  const linkPath = join(binDir, binaryName);
  const checks: DoctorCheck[] = [];

  let expectedTarget: string | undefined;
  try {
    expectedTarget = join(resolveCliRoot(fsOps), 'dist', 'cli.js');
  } catch {
    checks.push({
      name: 'CLI root',
      status: 'warn',
      detail: 'Could not resolve @inklabs/cli root from current directory.',
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
  return ['ink', ...buildFixArgs(binaryName)].join(' ');
}

export function buildFixArgs(binaryName: string): string[] {
  if (
    typeof binaryName !== 'string' ||
    !/^[a-zA-Z0-9]/.test(binaryName) ||
    /[^a-zA-Z0-9_-]/.test(binaryName)
  ) {
    throw new Error('CLI alias must contain only letters, numbers, underscores, and hyphens');
  }
  return binaryName === 'ink' ? ['studio', 'cli'] : ['studio', 'cli', '--name', binaryName];
}

export async function applyCliLinkFix(binaryName: string): Promise<void> {
  const { stdout, stderr } = await promisify(execFile)('ink', buildFixArgs(binaryName));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
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
  const studioChecks = await buildStudioChecks(process.cwd());
  result.checks.push(...studioChecks);

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
  const studioIncomplete = studioChecks.some((check) => check.status === 'fail');
  const linkNeedsFix =
    result.checks.some((check) => !check.name.startsWith('Studio: ') && check.status === 'fail') ||
    hasStudioMismatch;
  const needsFix = linkNeedsFix;

  if (studioIncomplete) {
    console.log(chalk.bold('Studio repair'));
    console.log(
      chalk.dim('  This worktree is missing studio items. From inside it, run:\n  ink init')
    );
    console.log('');
  }

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
          await applyCliLinkFix(result.binaryName);
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
        chalk.dim('\nTip: run ink doctor --fix to confirm and apply from this directory.')
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
    .option('-n, --name <name>', 'Binary name (default: ink-<agent>)')
    .option('--json', 'Output machine-readable JSON')
    .option('--fix', 'Prompt to run studio link fix command from current directory')
    .action(doctorCommand);
}
