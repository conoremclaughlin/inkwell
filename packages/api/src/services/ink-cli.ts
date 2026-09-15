/**
 * Ink CLI resolution for server-spawned work.
 *
 * The server never consults the global `~/.ink/bin/ink` link. That link points
 * at whichever checkout the OB last chose, so a server that follows it runs some
 * other checkout's CLI for its hooks and chat loops. Instead, in order:
 *
 *   1. `INK_CLI_PATH` — an explicit override: the absolute path of a built
 *      cli.js or of an executable. For the rare server that must deliberately
 *      run a CLI from elsewhere.
 *   2. This checkout's own build, `<repo>/packages/cli/dist/cli.js`, found by
 *      walking up from this module. Works from `src/` under tsx and from
 *      `dist/` under node.
 *   3. Nothing. The caller falls back to `ink` on PATH, and this module warns
 *      once that the checkout has no CLI build.
 *
 * tsc emits cli.js without the execute bit (only `install:cli` chmods it), so a
 * resolved script always runs through node and is never executed directly.
 */

import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { logger } from '../utils/logger';

export type InkCliSource = 'env' | 'checkout';

export interface InkCliInvocation {
  /** Absolute path of the built cli.js (a script) or of an executable. */
  path: string;
  /** Which rule chose the path. */
  source: InkCliSource;
  /** True when `path` is a JS entry that must run through node. */
  script: boolean;
}

export const INK_CLI_PATH_ENV = 'INK_CLI_PATH';

const CLI_PACKAGE_REL = join('packages', 'cli', 'package.json');
const CLI_BUILD_REL = join('packages', 'cli', 'dist', 'cli.js');
const SCRIPT_EXTENSION = /\.[cm]?js$/i;

/**
 * The root of the checkout this module runs from: the nearest ancestor holding
 * packages/cli/package.json. Null when the module runs outside any checkout.
 */
export function findOwnCheckoutRoot(startDir: string = __dirname): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, CLI_PACKAGE_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const warned = new Set<string>();

function warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message, meta);
}

/** Test seam: let the one-time warnings fire again. */
export function resetInkCliWarnings(): void {
  warned.clear();
}

export interface ResolveInkCliOptions {
  /** Environment to read the override from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where to start the walk up to the checkout root. Default: this module's directory. */
  startDir?: string;
}

/**
 * The ink CLI this server should invoke, or null when neither an override nor
 * a build in this checkout exists. Not cached: a build that lands after the
 * server started is picked up on the next call.
 */
export function resolveInkCli(options: ResolveInkCliOptions = {}): InkCliInvocation | null {
  const env = options.env ?? process.env;
  const override = env[INK_CLI_PATH_ENV]?.trim();
  if (override) {
    if (isAbsolute(override) && existsSync(override)) {
      return { path: override, source: 'env', script: SCRIPT_EXTENSION.test(override) };
    }
    warnOnce(
      `override:${override}`,
      `${INK_CLI_PATH_ENV} is set but is not an existing absolute path; ignoring it`,
      { [INK_CLI_PATH_ENV]: override }
    );
  }

  const root = findOwnCheckoutRoot(options.startDir);
  if (!root) {
    warnOnce(
      'no-checkout',
      "Could not locate this server's checkout (no packages/cli/package.json above the api package); ink hooks and chat loops will run whatever `ink` is on PATH",
      { startDir: options.startDir ?? __dirname }
    );
    return null;
  }

  const built = join(root, CLI_BUILD_REL);
  if (existsSync(built)) {
    return { path: built, source: 'checkout', script: true };
  }
  warnOnce(
    `unbuilt:${root}`,
    'This checkout has no CLI build; ink hooks and chat loops will run whatever `ink` is on PATH. Build it with `yarn workspace @inklabs/cli build`.',
    { checkoutRoot: root, expected: built }
  );
  return null;
}

const SHELL_SAFE = /^[A-Za-z0-9_/.\-~:+@%,=]+$/;

/** Double-quote a value for a shell command line unless it is plainly safe. */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Command-line form for a persisted hook: `node /path/cli.js` for a script,
 * the bare path for an executable. Bare `node` is deliberate: hooks run in the
 * terminal's shell long after this process is gone, and a pinned nvm path can
 * vanish with the next node upgrade.
 */
export function inkCliCommand(cli: InkCliInvocation): string {
  return cli.script ? `node ${shellQuote(cli.path)}` : shellQuote(cli.path);
}

/**
 * spawn() form. A script runs through this server's own node binary, so the
 * child gets the same runtime the server was started with regardless of what
 * the server's PATH happens to hold.
 */
export function inkCliSpawn(cli: InkCliInvocation): { command: string; args: string[] } {
  return cli.script
    ? { command: process.execPath, args: [cli.path] }
    : { command: cli.path, args: [] };
}
