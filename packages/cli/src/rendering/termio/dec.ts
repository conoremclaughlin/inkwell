/**
 * DEC (Digital Equipment Corporation) Private Mode Sequences
 *
 * DEC private modes use CSI ? N h (set) and CSI ? N l (reset) format.
 * Copied from Claude Code fork's rendering engine.
 */

import { csi } from './csi.js';

export const DEC = {
  CURSOR_VISIBLE: 25,
  ALT_SCREEN: 47,
  ALT_SCREEN_CLEAR: 1049,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  FOCUS_EVENTS: 1004,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_UPDATE: 2026,
} as const;

export function decset(mode: number): string {
  return csi(`?${mode}h`);
}

export function decreset(mode: number): string {
  return csi(`?${mode}l`);
}

export const BSU = decset(DEC.SYNCHRONIZED_UPDATE);
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE);
export const EBP = decset(DEC.BRACKETED_PASTE);
export const DBP = decreset(DEC.BRACKETED_PASTE);
export const EFE = decset(DEC.FOCUS_EVENTS);
export const DFE = decreset(DEC.FOCUS_EVENTS);
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE);
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE);
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR);
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR);
