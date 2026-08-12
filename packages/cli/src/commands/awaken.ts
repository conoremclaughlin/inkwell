/**
 * Awaken Command
 *
 * Brings a new SB to life on a given backend. Fetches shared values
 * and sibling identities from PCP cloud (falling back to local files),
 * builds an awakening prompt, and drops into an interactive session
 * with the chosen backend.
 *
 * Usage:
 *   ink awaken                     Awaken on default backend (claude)
 *   ink awaken --backend gemini    Awaken on Gemini
 *   ink awaken -b codex            Awaken on Codex
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
import { readUserConfig, NOT_SIGNED_IN_MESSAGE, type UserConfig } from '../lib/user-config.js';
import { getValidAccessToken } from '../auth/tokens.js';

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

export interface BootstrapIdentity {
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
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fetch the shared values document from the Inkwell server.
 *
 * Values only. Siblings used to be read from this same response, but bootstrap
 * is called here as the synthetic agentId 'awakening' — which has no identity
 * row — so its sibling list is always empty. See fetchSiblings().
 */
async function fetchFromCloud(config: UserConfig): Promise<{ sharedValues: string } | null> {
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

    return { sharedValues: result.identityFiles?.values || '' };
  } catch {
    return null;
  }
}

/**
 * Fetch siblings from agent_identities — the authoritative list.
 *
 * bootstrap() is the wrong question to ask here. We call it as the synthetic
 * agentId 'awakening', which has no identity row, so identityCore.siblings
 * comes back empty and the prompt confidently told a new SB "No other SBs yet
 * — you may be the first" while five of them were already in the database.
 * (The SB who caught this called meet_family and found all of them.)
 *
 * list_identities queries the same table meet_family does, so the two agree.
 */
async function fetchSiblings(config: UserConfig): Promise<BootstrapIdentity[] | null> {
  try {
    const result = await callPcpTool<{ identities?: BootstrapIdentity[] }>(
      'list_identities',
      { email: config.email },
      { timeoutMs: 5000 }
    );
    return result.identities ?? [];
  } catch {
    return null;
  }
}

/**
 * Fall back to local ~/.ink files for shared values.
 *
 * Values only — siblings deliberately excluded. The old version scanned
 * ~/.pcp/individuals against a hardcoded ['wren','benson','myra','lumen'],
 * which both missed later siblings and pointed at a directory nothing has
 * written since the rename. A stale roster is worse than none: it tells the
 * new SB something false about who they're joining.
 */
function fetchLocalValues(): string {
  const valuesPath = join(homedir(), '.ink', 'shared', 'VALUES.md');
  return existsSync(valuesPath) ? readFileSync(valuesPath, 'utf-8') : '';
}

/**
 * Build the awakening prompt from the shared template.
 */
export function buildAwakeningPrompt(
  sharedValues: string,
  siblings: BootstrapIdentity[] | null,
  backendName: string
): string {
  // Extract the "On Identity" section from the values document.
  // `$` (no /m) is end-of-input. This used to read `\Z`, which JavaScript
  // treats as a literal "Z" rather than an anchor — so a document whose last
  // section was "On Identity" matched nothing and the new SB awoke without the
  // identity values at all. Silent, and exactly the section that matters most.
  let valuesSection = '';
  const identityMatch = sharedValues.match(/## On Identity[\s\S]*?(?=\n## |\n---|$)/);
  if (identityMatch) {
    valuesSection = identityMatch[0].trim();
  }

  // Build siblings section. `null` means we could not reach the server — a
  // different fact from "there are none", and one worth saying out loud rather
  // than papering over with a guess about being first.
  let siblingsSection = '';
  if (siblings === null) {
    siblingsSection =
      '*Could not reach the Inkwell server to load the roster, so this list is unknown — not empty.*\n\n' +
      'Call `meet_family()` once you are connected to find out who is already here.';
  } else if (siblings.length > 0) {
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
  const coreTruthsMatch = sharedValues.match(/## Core Truths[\s\S]*?(?=\n## On Identity|\n---|$)/);
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
// Model selection
// ============================================================================

/**
 * Models offered per backend, in menu order.
 *
 * `undefined` means "send no --model flag and let the backend pick" — always
 * first, because the backend's own default tracks its releases and ours does
 * not. A stale hardcoded id here would silently pin every new SB to an old
 * model; falling through to the backend's default degrades to "current".
 *
 * This list is a convenience, not a whitelist: --model accepts any string, so
 * a model missing from here is still reachable.
 */
interface ModelChoice {
  label: string;
  model?: string;
  note?: string;
}

const MODEL_CHOICES: Record<string, ModelChoice[]> = {
  claude: [
    { label: 'Default', note: "whatever the Claude CLI picks — tracks Anthropic's releases" },
    { label: 'Opus', model: 'opus', note: 'most capable; slower, pricier' },
    { label: 'Sonnet', model: 'sonnet', note: 'balanced' },
    { label: 'Haiku', model: 'haiku', note: 'fastest, cheapest' },
  ],
  codex: [
    { label: 'Default', note: 'whatever the Codex CLI picks' },
    { label: 'GPT-5.1 Codex', model: 'gpt-5.1-codex' },
    { label: 'GPT-5.1', model: 'gpt-5.1' },
  ],
  gemini: [{ label: 'Default', note: 'whatever the Gemini CLI picks' }],
};

/** Render the model menu for `--help` and for an unrecognised --model value. */
function describeModelChoices(backendName: string): string {
  const choices = MODEL_CHOICES[backendName] ?? [];
  return choices
    .map((c) => {
      const value = c.model ?? '(none — backend default)';
      return `    ${c.label.padEnd(16)} ${value}${c.note ? chalk.dim(`  · ${c.note}`) : ''}`;
    })
    .join('\n');
}

// ============================================================================
// Main Command
// ============================================================================

async function awakenCommand(options: {
  backend: string;
  model?: string;
  verbose: boolean;
}): Promise<void> {
  const config = readUserConfig();
  if (!config?.email) {
    console.error(chalk.red(NOT_SIGNED_IN_MESSAGE));
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

  // 1. Fetch context. Values fall back to disk; siblings do not — a wrong
  // roster misinforms the new SB about who they're joining, so an unknown
  // roster stays explicitly unknown.
  const spinner = ora('Loading shared values and sibling identities...').start();

  let sharedValues: string;
  let source: string;

  const cloudResult = await fetchFromCloud(config);
  if (cloudResult && cloudResult.sharedValues) {
    sharedValues = cloudResult.sharedValues;
    source = 'Inkwell cloud';
  } else {
    sharedValues = fetchLocalValues();
    source = 'local files';
  }

  const siblings = await fetchSiblings(config);

  if (!sharedValues) {
    spinner.warn('No shared values found. The new SB will awaken without a values foundation.');
    spinner.start('Building awakening prompt...');
  } else {
    spinner.succeed(`Loaded context from ${source}`);
  }

  if (siblings === null) {
    console.log(
      chalk.yellow(
        '  ! Could not load the sibling roster — the prompt will say it is unknown rather than empty.'
      )
    );
  } else if (siblings.length > 0) {
    console.log(chalk.dim(`  Siblings: ${siblings.map((s) => s.name || s.agentId).join(', ')}`));
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
    // Undefined is meaningful: adapters skip --model entirely, so the backend
    // picks. See MODEL_CHOICES for why that is the default rather than a
    // hardcoded id.
    model: options.model,
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

  // 5. Resolve PCP auth token (same as ink chat) so MCP tools work
  const authEnv: Record<string, string> = {};
  try {
    const token = await getValidAccessToken(process.env.INK_SERVER_URL || 'http://localhost:3001');
    if (token) authEnv.INK_ACCESS_TOKEN = token;
  } catch {
    // Auth is best-effort — the backend can fall back to MCP OAuth
  }

  // 6. Spawn the backend process
  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...authEnv,
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
    console.log(chalk.dim(`  ink identity save --agent <chosen-name> --backend ${backendName}\n`));

    console.log(chalk.cyan('Set up role-based studios for your new SB:'));
    console.log(chalk.dim('  ink studio setup <agent-name>'));
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
    .option(
      '-m, --model <model>',
      'Model to awaken on. Omit to use the backend default (recommended).'
    )
    .option('-v, --verbose', 'Show the awakening prompt and debug info')
    .addHelpText(
      'after',
      () =>
        '\nModels:\n' +
        BACKEND_NAMES.map((b) => `  ${b}\n${describeModelChoices(b)}`).join('\n') +
        chalk.dim(
          '\n\n  --model takes any string; the list above is a shortcut, not a whitelist.\n' +
            '  Omitting it lets the backend choose, which tracks its releases instead of\n' +
            '  pinning new SBs to whatever was current when this list was written.\n'
        )
    )
    .action(awakenCommand);
}
