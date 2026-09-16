/**
 * User Config
 *
 * Single reader for the machine-level Inkwell config at ~/.ink/config.json.
 * `ink auth login` is what writes this file (email + userId from the JWT);
 * `ink init` only touches the repo, so a missing config means "not signed in",
 * not "not initialized".
 *
 * Commands used to each carry their own copy of this reader, and two of them
 * still pointed at the pre-rename ~/.pcp/config.json. Import from here instead
 * of hand-rolling another one.
 *
 * ~/.ink is the only location read. Reading the legacy ~/.pcp/config.json as a
 * fallback would report an email while `authFilePath()` (~/.ink/auth.json) and
 * PcpClient still see nothing — the command clears the signed-in gate and then
 * fails deeper with a worse error. A pre-rename install needs `ink auth login`
 * anyway to mint tokens, and that writes ~/.ink/config.json on its way through.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface UserConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
  skills?: { extraDirs?: string[] };
}

/** Where `ink auth login` writes. */
export function userConfigPath(): string {
  return join(homedir(), '.ink', 'config.json');
}

/**
 * Shown when a command needs an authenticated user and there isn't one.
 *
 * Names account creation as well as login. `ink auth login` opens the browser
 * at /login, which links to /signup — so it is already the right command for
 * someone with no account at all. But "login" does not *read* that way to a
 * brand-new user, who reasonably concludes they need to sign up somewhere
 * first and goes looking. That was the same dead end as issue #331: the
 * mechanism existed, the signpost didn't.
 */
export const NOT_SIGNED_IN_MESSAGE =
  'Not signed in to Inkwell. Run: ink auth login\n' +
  "  No account yet? That's the same command — the page it opens has a sign-up link.";

/**
 * Read ~/.ink/config.json. Returns null when it doesn't exist or is
 * unparseable — both mean "not signed in" to every caller.
 */
export function readUserConfig(): UserConfig | null {
  const path = userConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UserConfig;
  } catch {
    return null;
  }
}
