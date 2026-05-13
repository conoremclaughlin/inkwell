/**
 * Cross-platform terminal clearing with scrollback support.
 * Copied from Claude Code fork's rendering engine.
 */

import { CURSOR_HOME, csi, ERASE_SCREEN, ERASE_SCROLLBACK } from './termio/csi.js';

const CURSOR_HOME_WINDOWS = csi(0, 'f');

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION;
}

function isMintty(): boolean {
  if (process.env.TERM_PROGRAM === 'mintty') return true;
  if (process.platform === 'win32' && process.env.MSYSTEM) return true;
  return false;
}

function isModernWindowsTerminal(): boolean {
  if (isWindowsTerminal()) return true;
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  )
    return true;
  if (isMintty()) return true;
  return false;
}

export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME;
    } else {
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS;
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME;
}

export const clearTerminal = getClearTerminalSequence();
