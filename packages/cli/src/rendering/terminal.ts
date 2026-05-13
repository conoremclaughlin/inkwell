/**
 * Terminal capability detection + diff-to-terminal writer.
 * Adapted from Claude Code fork's rendering engine.
 * Removed semver/env deps — uses inline detection.
 */

import type { Writable } from 'stream';
import { getClearTerminalSequence } from './clearTerminal.js';
import type { Diff } from './frame.js';
import { cursorMove, cursorTo, eraseLines } from './termio/csi.js';
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js';
import { link } from './termio/osc.js';

export function isSynchronizedOutputSupported(): boolean {
  if (process.env.TMUX) return false;

  const termProgram = process.env.TERM_PROGRAM;
  const term = process.env.TERM;

  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true;
  }

  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true;
  if (term === 'xterm-ghostty') return true;
  if (term?.startsWith('foot')) return true;
  if (term?.includes('alacritty')) return true;
  if (process.env.ZED_TERM) return true;
  if (process.env.WT_SESSION) return true;

  const vteVersion = process.env.VTE_VERSION;
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

export const SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported();

export type Terminal = {
  stdout: Writable;
  stderr: Writable;
};

export function writeDiffToTerminal(terminal: Terminal, diff: Diff, skipSyncMarkers = false): void {
  if (diff.length === 0) {
    return;
  }

  const useSync = !skipSyncMarkers;
  let buffer = useSync ? BSU : '';

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        buffer += patch.content;
        break;
      case 'clear':
        if (patch.count > 0) {
          buffer += eraseLines(patch.count);
        }
        break;
      case 'clearTerminal':
        buffer += getClearTerminalSequence();
        break;
      case 'cursorHide':
        buffer += HIDE_CURSOR;
        break;
      case 'cursorShow':
        buffer += SHOW_CURSOR;
        break;
      case 'cursorMove':
        buffer += cursorMove(patch.x, patch.y);
        break;
      case 'cursorTo':
        buffer += cursorTo(patch.col);
        break;
      case 'carriageReturn':
        buffer += '\r';
        break;
      case 'hyperlink':
        buffer += link(patch.uri);
        break;
      case 'styleStr':
        buffer += patch.str;
        break;
    }
  }

  if (useSync) buffer += ESU;
  terminal.stdout.write(buffer);
}
