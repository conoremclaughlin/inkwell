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
 * privileged actor changing policy during a run. Only the default macOS keychain
 * login is supported; file-backed Linux and custom-config logins need an explicit
 * design, not a credential-copy fallback.
 * Sources: code.claude.com/docs/en/managed-settings; local 2.1.294 policy loader.
 */
export async function assertUnmanagedHost(
  platform: NodeJS.Platform = process.platform,
  isAbsent: (path: string) => Promise<boolean> = absent
): Promise<void> {
  if (platform !== 'darwin') throw new WebSearchError('unsupported_platform');
  const root = '/Library/Application Support/ClaudeCode';
  const paths = ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'].map((file) =>
    join(root, file)
  );
  // Claude's pinned policy loader uses os.userInfo(), not HOME/USER.
  paths.push('/Library/Managed Preferences/com.anthropic.claudecode.plist');
  paths.push(
    join('/Library/Managed Preferences', userInfo().username, 'com.anthropic.claudecode.plist')
  );
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
      JSON.stringify({
        disableAllHooks: true,
        // Safe mode suppresses user discovery, not these default-on builtins.
        // agents-md installs instruction-loading hooks; authoring adds a skill.
        // Disable only these non-security features. Never disable sec-default or
        // managed safety policy. Unexpected init plugins still refuse the run.
        enabledPlugins: {
          'cc-plugin-agents-md@builtin': false,
          'cc-plugin-plugin-authoring@builtin': false,
        },
        autoMemoryEnabled: false,
      }),
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
      // dotenv, user config, PATH lookup, or profiles. The service explicitly
      // selects the default keychain only for inference, never capability probes.
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
