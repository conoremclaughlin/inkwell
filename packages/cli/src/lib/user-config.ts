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

/** Pre-rename location, still present on installs that predate `.ink/`. */
export function legacyUserConfigPath(): string {
  return join(homedir(), '.pcp', 'config.json');
}

/** Shown when a command needs an authenticated user and there isn't one. */
export const NOT_SIGNED_IN_MESSAGE = 'Not signed in to Inkwell. Run: ink auth login';

function readJsonFile(path: string): UserConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UserConfig;
  } catch {
    return null;
  }
}

/**
 * Read ~/.ink/config.json, falling back to the legacy ~/.pcp/config.json so
 * installs that predate the rename keep working. Returns null when neither
 * exists or the file is unparseable.
 */
export function readUserConfig(): UserConfig | null {
  return readJsonFile(userConfigPath()) ?? readJsonFile(legacyUserConfigPath());
}
