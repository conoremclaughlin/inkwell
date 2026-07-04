/**
 * Rendering engine — double-buffered, diff-based terminal output.
 *
 * Core files are verbatim copies from Claude Code's fork (instructkr-claude-code/src/ink/).
 * External deps (env, debug, semver, intl, execFileNoThrow) are shimmed in ./compat/.
 * Type stubs (cursor.ts, render-node-to-output.ts) provide types that live
 * elsewhere in the fork's codebase.
 */

export { type Cursor } from './cursor.js';
export {
  type Frame,
  type Diff,
  type Patch,
  type FlickerReason,
  emptyFrame,
  shouldClearScreen,
} from './frame.js';
export {
  type Screen,
  type Cell,
  type Hyperlink,
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  resetScreen,
  setCellAt,
  setCellStyleId,
  cellAt,
  cellAtIndex,
  isEmptyCellAt,
  isCellEmpty,
  charInCellAt,
  diffEach,
  diff,
  blitRegion,
  clearRegion,
  shiftRows,
} from './screen.js';
export { LogUpdate } from './log-update.js';
export {
  type Terminal,
  writeDiffToTerminal,
  isSynchronizedOutputSupported,
  SYNC_OUTPUT_SUPPORTED,
} from './terminal.js';
export { type Point, type Size, type Rectangle } from './layout/geometry.js';
