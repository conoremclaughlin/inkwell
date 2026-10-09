import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { WebSearchError } from './errors.js';

export interface SearchSandbox {
  root: string;
  cwd: string;
  settings: string;
  mcp: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/** Only metadata is checked: never open machine auth or policy contents. */
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * --setting-sources and --strict-mcp-config are NOT managed-policy bypasses.
 * Refuse known endpoint policy sources, even empty files/directories/symlinks.
 * This is a deployment precondition, not OS isolation or protection from a
 * privileged actor changing policy during a run. Windows/WSL are unreviewed.
 * Sources: code.claude.com/docs/en/managed-settings; local 2.1.294 policy loader.
 */
export async function assertUnmanagedHost(
  platform: NodeJS.Platform = process.platform,
  isAbsent: (path: string) => Promise<boolean> = absent
): Promise<void> {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new WebSearchError('unsupported_platform');
  }
  const roots =
    platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode']
      : ['/etc/claude-code', '/mnt/c/Program Files/ClaudeCode'];
  const paths = roots.flatMap((root) =>
    ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'].map((file) =>
      join(root, file)
    )
  );
  if (platform === 'darwin') {
    // Claude's pinned policy loader uses os.userInfo(), not HOME/USER.
    paths.push('/Library/Managed Preferences/com.anthropic.claudecode.plist');
    paths.push(
      join('/Library/Managed Preferences', userInfo().username, 'com.anthropic.claudecode.plist')
    );
  } else {
    // Presence of Windows interop is enough to refuse, without querying registry.
    paths.push('/proc/sys/fs/binfmt_misc/WSLInterop');
  }
  for (const path of paths) {
    if (!(await isAbsent(path))) throw new WebSearchError('managed_configuration');
  }
}

export async function createSandbox(): Promise<SearchSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'ink-web-search-'));
  const cleanup = async () => {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      throw new WebSearchError('cleanup_failed');
    }
  };
  try {
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const config = join(root, 'config');
    const temp = join(root, 'tmp');
    for (const dir of [cwd, home, config, temp]) await mkdir(dir, { mode: 0o700 });
    const settings = join(config, 'settings.json');
    const mcp = join(config, 'mcp.json');
    await writeFile(
      settings,
      JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false }),
      { mode: 0o600 }
    );
    await writeFile(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    return {
      root,
      cwd,
      settings,
      mcp,
      cleanup,
      // Deliberately not process.env, buildCleanEnv, session launch settings,
      // dotenv, user config, PATH lookup, profiles, or keychain integration.
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_SIMPLE: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: '4',
        CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR: '0',
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048',
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Resolve once, preventing a mutable `claude` symlink switching after probing. */
export async function resolveExecutable(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new WebSearchError('missing_configuration');
  }
}
