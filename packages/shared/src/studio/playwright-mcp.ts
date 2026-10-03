/**
 * The Playwright MCP server a studio session gets: headless, on a
 * throwaway profile (task cd2fe361).
 *
 * WHY ISOLATED AND HEADLESS BY DEFAULT. A session that drives someone's
 * everyday browser, or opens windows on their screen, interferes with
 * whatever they are doing in it at the time. And on 2026-10-01 a page
 * snapshot taken in an everyday, logged-in profile exposed the values of
 * filled password fields. So the default launch is `--headless` (no
 * window) and `--isolated` (the profile lives in memory and is discarded
 * when the server exits, so no cookies, logins or autofill carry from one
 * session to the next). `--isolated` also lets two sessions run at once:
 * without it every session shares one on-disk profile, and a second
 * launch is refused with "Browser is already in use for <dir>, use
 * --isolated to run multiple instances".
 *
 * This is the default guard, not a ban. A server entry that names a
 * browser or profile of its own (`--extension`, `--user-data-dir`,
 * `--cdp-endpoint`, `--endpoint`, their environment forms when set, or a
 * Chrome or Dia profile path) is someone's explicit choice, and so is one
 * that names a configuration file (`--config`, `PLAYWRIGHT_MCP_CONFIG`),
 * which can choose all of that itself. `pinIsolatedPlaywright` leaves such
 * an entry exactly as written and reports it. Adding `--isolated` to it
 * would not be harmless either: the server refuses a profile directory in
 * isolated mode, wherever the directory was set. An attach variable the
 * server ignores (`PLAYWRIGHT_MCP_EXTENSION=false`, an empty profile path)
 * is no choice at all, and the entry is pinned. What we generate never
 * names one, and the tests over every producer fail if it does.
 *
 * Flags, defaults and both refusals read from @playwright/mcp 0.0.70
 * (playwright-core lib/tools/mcp: program.js, config.js, browserFactory.js).
 */

/** The server's name in `.mcp.json`, and so the `mcp__playwright__*` tool prefix. */
export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';

/** The package `npx` runs. */
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp';

/** The default launch: `npx` with these arguments. */
export const PLAYWRIGHT_MCP_DEFAULT_ARGS: readonly string[] = [
  PLAYWRIGHT_MCP_PACKAGE,
  '--headless',
  '--isolated',
];

/** The flags the default launch must carry. */
const PINNED_FLAGS = ['--headless', '--isolated'] as const;

/**
 * Flags that hand the server a browser or a profile it did not launch
 * itself: the browser extension bridge, a profile directory, or a running
 * browser to connect to.
 */
export const PLAYWRIGHT_ATTACH_FLAGS: readonly string[] = [
  '--extension',
  '--user-data-dir',
  '--cdp-endpoint',
  '--endpoint',
];

/**
 * The same, set through the server's environment. Each counts only when
 * the server acts on its value (`envAttachmentActive`).
 */
export const PLAYWRIGHT_ATTACH_ENV: readonly string[] = [
  'PLAYWRIGHT_MCP_EXTENSION',
  'PLAYWRIGHT_MCP_USER_DATA_DIR',
  'PLAYWRIGHT_MCP_CDP_ENDPOINT',
];

/**
 * A configuration file, as a flag or in the environment. The file can
 * choose a profile directory, a browser or headed mode, and we don't read
 * it, so an entry naming one makes its own choices.
 */
export const PLAYWRIGHT_CONFIG_FLAG = '--config';
export const PLAYWRIGHT_CONFIG_ENV = 'PLAYWRIGHT_MCP_CONFIG';

/** Environment settings for the two pinned flags, by the flag they set. */
const PINNED_FLAG_ENV: Record<(typeof PINNED_FLAGS)[number], string> = {
  '--headless': 'PLAYWRIGHT_MCP_HEADLESS',
  '--isolated': 'PLAYWRIGHT_MCP_ISOLATED',
};

/**
 * 0.0.70's environment parsers, measured through its own config resolver
 * (`resolveCLIConfigForMCP`): a boolean is set only by `true`, `1`,
 * `false` or `0`, exactly as written (`TRUE`, `yes`, empty and blank are
 * unset), and a string only when it is non-empty after trimming.
 */
const ENV_BOOLEAN_VALUES = new Set(['true', '1', 'false', '0']);

function envBooleanIsSet(value: unknown): boolean {
  return typeof value === 'string' && ENV_BOOLEAN_VALUES.has(value);
}

function envStringIsSet(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether an attach variable takes effect: the extension bridge only when
 * it reads as true, a profile directory or endpoint only when non-empty.
 * `PLAYWRIGHT_MCP_EXTENSION=false`, `0` or empty attaches nothing.
 */
function envAttachmentActive(key: string, value: unknown): boolean {
  if (key === 'PLAYWRIGHT_MCP_EXTENSION') return value === 'true' || value === '1';
  return envStringIsSet(value);
}

/**
 * A personal browser's profile directory, on macOS or Linux: Chrome,
 * Chromium, Dia, and the other Chromium browsers a person may use daily.
 */
const BROWSER_PROFILE_PATH =
  /(Application Support\/(Google\/Chrome|Chromium|Dia|BraveSoftware|Microsoft Edge|Arc)\b|\.config\/(google-chrome|chromium|BraveSoftware|microsoft-edge)\b)/i;

/** The fields of an MCP server entry this module reads. */
export interface PlaywrightServerShape {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
}

/**
 * Whether an entry launches the Playwright MCP server: `npx @playwright/mcp`
 * (any version tag, any npx flags), or the package's own binary.
 */
export function isPlaywrightMcpServer(config: PlaywrightServerShape | null | undefined): boolean {
  if (!config) return false;
  const command = typeof config.command === 'string' ? config.command : '';
  const bin = command.split('/').pop() ?? '';
  if (bin === 'playwright-mcp' || bin === 'mcp-server-playwright') return true;
  const args = Array.isArray(config.args) ? config.args : [];
  return args.some(
    (arg) =>
      typeof arg === 'string' &&
      (arg === PLAYWRIGHT_MCP_PACKAGE || arg.startsWith(`${PLAYWRIGHT_MCP_PACKAGE}@`))
  );
}

/**
 * What in an entry makes its own browser choice: attach flags, attach
 * variables the server would act on, a configuration file (flag or
 * variable), and `browser profile path` for an argument or environment
 * value naming one. Names only, never values. Empty for the default launch.
 */
export function playwrightBrowserAttachments(config: PlaywrightServerShape): string[] {
  const found = new Set<string>();
  const args = Array.isArray(config.args) ? config.args : [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const name = flagName(arg);
    if (PLAYWRIGHT_ATTACH_FLAGS.includes(name) || name === PLAYWRIGHT_CONFIG_FLAG) found.add(name);
    if (BROWSER_PROFILE_PATH.test(arg)) found.add('browser profile path');
  }
  const env = config.env && typeof config.env === 'object' ? config.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (PLAYWRIGHT_ATTACH_ENV.includes(key) && envAttachmentActive(key, value)) found.add(key);
    if (key === PLAYWRIGHT_CONFIG_ENV && envStringIsSet(value)) found.add(key);
    if (typeof value === 'string' && BROWSER_PROFILE_PATH.test(value)) {
      found.add('browser profile path');
    }
  }
  if (typeof config.command === 'string' && BROWSER_PROFILE_PATH.test(config.command)) {
    found.add('browser profile path');
  }
  return [...found];
}

export interface PinnedPlaywrightServers<T> {
  /** The servers, with each default Playwright launch carrying the pinned flags. */
  servers: Record<string, T>;
  /** Servers whose arguments gained a flag. */
  pinned: string[];
  /** Playwright servers left as written because they name a browser or profile. */
  attached: Array<{ name: string; attachments: string[] }>;
}

/**
 * Pin every Playwright MCP server in a server map to the default launch:
 * `--headless` and `--isolated` are appended when missing, after the
 * arguments already there. An entry that names a browser or profile of its
 * own is left exactly as written and listed in `attached`. Every other
 * server is untouched. Returns a new map; the input is not mutated.
 */
export function pinIsolatedPlaywright<T extends PlaywrightServerShape>(
  servers: Record<string, T>
): PinnedPlaywrightServers<T> {
  const out: Record<string, T> = {};
  const pinned: string[] = [];
  const attached: Array<{ name: string; attachments: string[] }> = [];
  // A parsed file can carry anything here; what is not a map is not ours to read.
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { servers, pinned, attached };
  }
  for (const [name, config] of Object.entries(servers)) {
    if (!isPlaywrightMcpServer(config)) {
      out[name] = config;
      continue;
    }
    const attachments = playwrightBrowserAttachments(config);
    if (attachments.length > 0) {
      out[name] = config;
      attached.push({ name, attachments });
      continue;
    }
    const args = Array.isArray(config.args) ? config.args : [];
    const present = new Set(args.filter((a) => typeof a === 'string').map(flagName));
    // A flag overrides its environment setting, so a flag the entry's own
    // environment already sets, either way, is left to that setting.
    const env = config.env && typeof config.env === 'object' ? config.env : {};
    const missing = PINNED_FLAGS.filter(
      (flag) => !present.has(flag) && !envBooleanIsSet(env[PINNED_FLAG_ENV[flag]])
    );
    if (missing.length === 0) {
      out[name] = config;
      continue;
    }
    out[name] = { ...config, args: [...args, ...missing] };
    pinned.push(name);
  }
  return { servers: out, pinned, attached };
}
