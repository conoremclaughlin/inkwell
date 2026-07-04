/**
 * Shim for Claude Code's src/utils/env.ts
 *
 * The rendering engine imports `env` for platform/terminal detection.
 * Claude Code's version has deep deps (lodash-es, findExecutable, fsOperations, etc.)
 * so we provide the same shape with simpler implementations.
 */

type Platform = 'win32' | 'darwin' | 'linux';

function detectTerminal(): string | null {
  if (process.env.CURSOR_TRACE_ID) return 'cursor';
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) return 'cursor';
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('windsurf')) return 'windsurf';
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM;
  if (process.env.TMUX) return 'tmux';
  if (process.env.STY) return 'screen';
  if (process.env.KITTY_WINDOW_ID) return 'kitty';
  if (process.env.WT_SESSION) return 'windows-terminal';
  if (process.env.TERM) return process.env.TERM;
  if (!process.stdout.isTTY) return 'non-interactive';
  return null;
}

export const env = {
  platform: (['win32', 'darwin'].includes(process.platform)
    ? process.platform
    : 'linux') as Platform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isCI: process.env.CI === 'true' || process.env.CI === '1',
  isSSH: (): boolean =>
    !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
};
