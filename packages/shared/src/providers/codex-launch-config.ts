/**
 * The config-affecting part of a Codex launch's pass-through, for the
 * effective-config check.
 *
 * `codex mcp list --json` reports the merged config it is run with. A launch
 * whose pass-through carries `-c mcp_servers.inkwell.http_headers.…` or a
 * different `mcp_servers.inkwell.url` runs with a config the bare listing
 * never showed: the check passed a clean file, and the override reached only
 * the credential-bearing child (Lumen, #701 cb80aa4b, measured with Codex).
 * So every override the launch carries goes into the probe, in launch order,
 * and whatever the probe cannot reproduce refuses the launch.
 *
 * - `-c`/`--config` in every spelling is carried into the probe as `-c V`.
 *   Codex applies overrides in order, so a later one for the same key wins
 *   in both.
 * - `-p`/`--profile` and `-C`/`--cd` select a profile or the directory whose
 *   project config is read, and `--enable`/`--disable` switch features. None
 *   of them is known to reach `mcp list` the way it reaches the launch, so a
 *   launch carrying one is refused rather than checked against a config it
 *   would not run with.
 * - Options known not to touch the config (the sandbox, the model, output
 *   and approval settings) are passed over, with their values.
 * - Any other option is refused as unclassified: an option the check does not
 *   know could be one that changes the config.
 *
 * Only the pass-through is read. The adapter's own flags are its own, and the
 * prompt is never classified: the runner places it after `exec` with no `--`,
 * so prompt text that begins with a dash would read as an option. A refusal
 * never quotes the token, which could carry a value (`--api-key=…`).
 */

import type { LaunchConfig } from './types.js';

export const CODEX_LAUNCH_REFUSALS = {
  profile:
    'the launch selects a Codex config profile (-p/--profile), which the effective-config check cannot apply; Codex was not started',
  directory:
    'the launch selects a working directory for Codex (-C/--cd), which the effective-config check cannot apply; Codex was not started',
  feature:
    'the launch switches a Codex feature (--enable/--disable), which the effective-config check cannot apply; Codex was not started',
  missingValue:
    'the launch passes a Codex option without its value; Codex was not started, because its configuration could not be checked',
  unclassified:
    'the launch passes an option to Codex that the effective-config check does not recognise; Codex was not started, because it could change the configuration',
} as const;

/** Options that take a value and do not affect the config Codex loads. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-m',
  '--model',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '--color',
  '--add-dir',
  '--output-schema',
  '-o',
  '--output-last-message',
  '--local-provider',
  '-i',
  '--image',
]);

/** Options without a value that do not affect the config Codex loads. */
const FLAG_OPTIONS: ReadonlySet<string> = new Set([
  '--skip-git-repo-check',
  '--json',
  '--experimental-json',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--oss',
  '--search',
  '--last',
  '--all',
]);

const CONFIG_OPTIONS: ReadonlySet<string> = new Set(['-c', '--config']);

/** Refused options, by every name, to the reason each is refused. */
const REFUSED_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['-p', CODEX_LAUNCH_REFUSALS.profile],
  ['--profile', CODEX_LAUNCH_REFUSALS.profile],
  ['-C', CODEX_LAUNCH_REFUSALS.directory],
  ['--cd', CODEX_LAUNCH_REFUSALS.directory],
  ['--enable', CODEX_LAUNCH_REFUSALS.feature],
  ['--disable', CODEX_LAUNCH_REFUSALS.feature],
]);

/**
 * An option token split into its name and an attached value, if it has one:
 * `--config=V` and the short form `-cV` both attach one.
 */
function splitOption(token: string): { name: string; attached?: string } {
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    return eq === -1
      ? { name: token }
      : { name: token.slice(0, eq), attached: token.slice(eq + 1) };
  }
  // A short option is one letter; anything after it is its value.
  return token.length > 2 ? { name: token.slice(0, 2), attached: token.slice(2) } : { name: token };
}

/**
 * The config-affecting part of `passthrough`, as `-c V` pairs in order, or
 * why the launch cannot be checked. `-`, and every token after a `--`, are
 * positional.
 */
export function classifyCodexPassthrough(passthrough: readonly string[]): LaunchConfig {
  const args: string[] = [];
  for (let i = 0; i < passthrough.length; i += 1) {
    const token = passthrough[i]!;
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-') continue;
    const { name, attached } = splitOption(token);
    const refused = REFUSED_OPTIONS.get(name);
    if (refused) return { refusal: refused };
    if (FLAG_OPTIONS.has(name)) {
      if (attached !== undefined) return { refusal: CODEX_LAUNCH_REFUSALS.unclassified };
      continue;
    }
    const isConfig = CONFIG_OPTIONS.has(name);
    if (!isConfig && !VALUE_OPTIONS.has(name))
      return { refusal: CODEX_LAUNCH_REFUSALS.unclassified };
    let value = attached;
    if (value === undefined) {
      value = passthrough[i + 1];
      if (value === undefined) return { refusal: CODEX_LAUNCH_REFUSALS.missingValue };
      i += 1;
    }
    if (isConfig) args.push('-c', value);
  }
  return { args };
}
