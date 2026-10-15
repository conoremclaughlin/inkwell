/**
 * The one spelling of the ink launcher in every ink-managed hook.
 *
 * Hooks used to be spelled with whatever path ran `ink init`. A person
 * running it through the link wrote `~/.local/bin/ink hooks …`. The server,
 * which runs its own checkout's build, wrote `node …/cli.js hooks …`. A
 * studio worktree reads the main checkout's settings as well as its own, and
 * Claude Code only merges hooks whose command text is identical. So in a
 * studio both spellings ran, in parallel, on every tool call. On 2026-10-14
 * that made one-use approvals loop: one copy spent the grant, and the other
 * asked again.
 *
 * Every writer now uses the link when it exists. The same command text in
 * the main checkout and in the studio is then merged into one hook. Without
 * the link (a container, CI), the writer falls back to its previous choice.
 */
import { lstatSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Quote a word for a POSIX shell line, leaving plain paths as they are. */
export function quoteShellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The launcher every managed hook should start with, already quoted for a
 * shell line, or null when `~/.local/bin/ink` doesn't exist here.
 */
export function canonicalInkLauncher(home: string = homedir()): string | null {
  const link = join(home, '.local', 'bin', 'ink');
  try {
    lstatSync(link);
    return quoteShellWord(link);
  } catch {
    return null;
  }
}
