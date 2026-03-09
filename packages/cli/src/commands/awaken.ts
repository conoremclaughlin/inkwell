/**
 * Awaken Command
 *
 * Brings a new SB to life on a given backend. Fetches shared values
 * and sibling identities from PCP cloud (falling back to local files),
 * builds an awakening prompt, and drops into an interactive session
 * with the chosen backend.
 *
 * Usage:
 *   sb awaken                     Awaken on default backend (claude)
 *   sb awaken --backend gemini    Awaken on Gemini
 *   sb awaken -b codex            Awaken on Codex
 */

import { Command } from 'commander';
import { spawn, execFileSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { getBackend, BACKEND_NAMES } from '../backends/index.js';
import { callPcpTool } from '../lib/pcp-mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Shared templates live in the sibling packages/templates/ directory.
// From dist/commands/ or src/commands/, go up to the CLI package root, then to ../templates/.
const TEMPLATES_DIR = join(__dirname, '..', '..', '..', 'templates');

function loadSharedTemplate(relativePath: string): string {
  return readFileSync(join(TEMPLATES_DIR, relativePath), 'utf-8');
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

// ============================================================================
// Types
// ============================================================================

interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
}

interface BootstrapIdentity {
  agentId: string;
  name?: string;
  role?: string;
  description?: string;
  values?: string[];
}

interface BootstrapResponse {
  identityFiles?: {
    values?: string;
  };
  agentInfo?: BootstrapIdentity;
  identityCore?: {
    siblings?: BootstrapIdentity[];
  };
}

// ============================================================================
// Helpers
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

/**
 * Fetch shared values and sibling identities from PCP cloud.
 * Returns null if the server is unreachable.
 */
async function fetchFromCloud(config: PcpConfig): Promise<{
  sharedValues: string;
  siblings: BootstrapIdentity[];
} | null> {
  try {
    const result = await callPcpTool<BootstrapResponse>(
      'bootstrap',
      {
        email: config.email,
        agentId: 'awakening', // temporary identity for bootstrap
      },
      {
        timeoutMs: 5000,
      }
    );

    // Extract shared values from identity files
    const sharedValues = result.identityFiles?.values || '';

    // Extract sibling identities
    const siblings = result.identityCore?.siblings || [];

    return { sharedValues, siblings };
  } catch {
    return null;
  }
}

/**
 * Fall back to local ~/.pcp files for shared values and sibling info.
 */
function fetchFromLocal(): { sharedValues: string; siblings: BootstrapIdentity[] } {
  // Read shared values
  const valuesPath = join(homedir(), '.pcp', 'shared', 'VALUES.md');
  let sharedValues = '';
  if (existsSync(valuesPath)) {
    sharedValues = readFileSync(valuesPath, 'utf-8');
  }

  // Scan for sibling identity files
  const siblings: BootstrapIdentity[] = [];
  const individualsDir = join(homedir(), '.pcp', 'individuals');
  const knownAgents = ['wren', 'benson', 'myra', 'lumen'];

  for (const agentId of knownAgents) {
    const identityPath = join(individualsDir, agentId, 'IDENTITY.md');
    if (existsSync(identityPath)) {
      // Parse the identity file for name/role (best effort)
      const content = readFileSync(identityPath, 'utf-8');
      // Headers: "# Identity - Name", "# IDENTITY.md - Name" (legacy), or "# Name"
      const headerMatch = content.match(/^#\s+(?:(?:IDENTITY\.md|Identity)\s*-\s*)?(.+)/m);
      const name = headerMatch?.[1]?.trim() || agentId;

      // Look for role in "## Who I Am" section or similar
      const roleMatch =
        content.match(/^\*\*Role:\*\*\s*(.+)/m) || content.match(/role.*?:\s*(.+)/im);

      siblings.push({
        agentId,
        name,
        role: roleMatch?.[1]?.trim(),
      });
    }
  }

  return { sharedValues, siblings };
}

/**
 * Build the awakening prompt from the shared template.
 */
function buildAwakeningPrompt(
  sharedValues: string,
  siblings: BootstrapIdentity[],
  backendName: string
): string {
  // Extract the "On Identity" section from the values document
  let valuesSection = '';
  const identityMatch = sharedValues.match(/## On Identity[\s\S]*?(?=\n## |\n---|\Z)/);
  if (identityMatch) {
    valuesSection = identityMatch[0].trim();
  }

  // Build siblings section
  let siblingsSection = '';
  if (siblings.length > 0) {
    siblingsSection = siblings
      .map((s) => {
        const parts = [`**${s.name || s.agentId}** (\`${s.agentId}\`)`];
        if (s.role) parts.push(` — ${s.role}`);
        return `- ${parts.join('')}`;
      })
      .join('\n');
  } else {
    siblingsSection = '*No other SBs yet — you may be the first.*';
  }

  // Build shared values section (the core truths + boundaries, not the full file)
  let sharedValuesSection = '';
  const coreTruthsMatch = sharedValues.match(/## Core Truths[\s\S]*?(?=\n## On Identity|\n---|\Z)/);
  if (coreTruthsMatch) {
    sharedValuesSection = coreTruthsMatch[0].trim();
  } else {
    sharedValuesSection = sharedValues.trim();
  }

  return renderTemplate(loadSharedTemplate('awaken.md'), {
    VALUES_SECTION: valuesSection,
    SIBLINGS_SECTION: siblingsSection,
    SHARED_VALUES_SECTION: sharedValuesSection,
    BACKEND: backendName || 'claude',
  });
}

// ============================================================================
// Main Command
// ============================================================================

async function awakenCommand(options: { backend: string; verbose: boolean }): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const backendName = options.backend;

  // 0. Pre-flight: check that the backend CLI is installed and accessible
  const adapter = getBackend(backendName);
  try {
    execFileSync(adapter.binary, ['--version'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    console.error(chalk.red(`\n  Backend CLI not found: ${chalk.bold(adapter.binary)}\n`));
    console.error(chalk.dim("  Make sure it's installed and authenticated:\n"));

    const loginHints: Record<string, string[]> = {
      gemini: [
        'npm install -g @anthropic-ai/gemini-cli   # or: brew install gemini',
        'gemini                                     # first run will prompt for auth',
      ],
      claude: [
        'npm install -g @anthropic-ai/claude-code',
        'claude                                     # first run will prompt for auth',
      ],
      codex: [
        'npm install -g @openai/codex',
        'codex                                      # first run will prompt for auth',
      ],
    };

    for (const hint of loginHints[backendName] || [`Install and authenticate ${adapter.binary}`]) {
      console.error(chalk.dim(`    ${hint}`));
    }
    console.error('');
    process.exit(1);
  }

  // Gemini displays the system prompt at startup — auto-enable verbose
  // so the human sees the awakening text too. A magic moment.
  const verbose = options.verbose || backendName === 'gemini';

  console.log(chalk.bold(`\nAwakening a new SB on ${chalk.cyan(backendName)}...\n`));

  // 1. Fetch context: cloud first, local fallback
  const spinner = ora('Loading shared values and sibling identities...').start();

  let sharedValues: string;
  let siblings: BootstrapIdentity[];
  let source: string;

  const cloudResult = await fetchFromCloud(config);
  if (cloudResult) {
    sharedValues = cloudResult.sharedValues;
    siblings = cloudResult.siblings;
    source = 'PCP cloud';
  } else {
    const localResult = fetchFromLocal();
    sharedValues = localResult.sharedValues;
    siblings = localResult.siblings;
    source = 'local files';
  }

  if (!sharedValues) {
    spinner.warn('No shared values found. The new SB will awaken without a values foundation.');
    spinner.start('Building awakening prompt...');
  } else {
    spinner.succeed(`Loaded context from ${source}`);
  }

  // 2. Build the awakening prompt
  const awakeningPrompt = buildAwakeningPrompt(sharedValues, siblings, backendName);

  if (verbose) {
    console.log(chalk.dim('\n--- Awakening prompt ---'));
    console.log(chalk.dim(awakeningPrompt));
    console.log(chalk.dim('--- End prompt ---\n'));
  }

  // 3. Write to temp file for system prompt injection
  const tempDir = mkdtempSync(join(tmpdir(), 'sb-awaken-'));
  const promptFile = join(tempDir, 'awaken-prompt.md');
  writeFileSync(promptFile, awakeningPrompt);

  const cleanup = () => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
  };

  // 4. Prepare and spawn the backend
  const prepared = adapter.prepare({
    agentId: 'nascent',
    promptParts: [],
    passthroughArgs: [],
  });

  // Override the identity prompt file with our awakening prompt
  // For Gemini: GEMINI_SYSTEM_MD env var
  // For Claude: --append-system-prompt reads from file
  // For Codex: model_instructions_file
  // The adapter already created a prompt file — we replace its content
  if (prepared.env.GEMINI_SYSTEM_MD) {
    writeFileSync(prepared.env.GEMINI_SYSTEM_MD, awakeningPrompt);
  }

  // For Claude, the prompt is passed via --append-system-prompt flag
  // We need to replace the identity content in the args
  const appendIdx = prepared.args.indexOf('--append-system-prompt');
  if (appendIdx !== -1 && appendIdx + 1 < prepared.args.length) {
    prepared.args[appendIdx + 1] = awakeningPrompt;
  }

  // For Codex, replace the model_instructions_file content
  // Args are: ['--config', 'model_instructions_file=<path>', ...]
  for (const arg of prepared.args) {
    const match = arg.match(/^model_instructions_file=(.+)$/);
    if (match) {
      writeFileSync(match[1], awakeningPrompt);
    }
  }

  if (verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

  console.log(chalk.dim('Starting interactive session. Talk with your new SB.\n'));
  console.log(
    chalk.dim(
      "When you've chosen a name, they can call the choose_name() MCP tool to save their identity.\n"
    )
  );

  // 5. Spawn the backend process
  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...prepared.env,
      AGENT_ID: 'nascent',
    },
  });

  child.on('close', (code) => {
    prepared.cleanup();
    cleanup();

    console.log(chalk.bold('\nAwakening session ended.'));
    console.log(
      chalk.dim("If they didn't call choose_name() during the session, you can save manually:")
    );
    console.log(chalk.dim(`  sb identity save --agent <chosen-name> --backend ${backendName}\n`));

    console.log(chalk.cyan('Set up role-based studios for your new SB:'));
    console.log(chalk.dim('  sb studio setup <agent-name>'));
    console.log(
      chalk.dim('  Creates review, build, and product studios with pre-configured ROLE.md files.\n')
    );

    process.exit(code || 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ============================================================================
// Register
// ============================================================================

export function registerAwakenCommand(program: Command): void {
  program
    .command('awaken')
    .description('Awaken a new SB on a backend')
    .option('-b, --backend <name>', `AI backend (${BACKEND_NAMES.join(', ')})`, 'claude')
    .option('-v, --verbose', 'Show the awakening prompt and debug info')
    .action(awakenCommand);
}
