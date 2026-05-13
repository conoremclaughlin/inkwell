/**
 * Rendering engine — double-buffered, diff-based terminal output.
 *
 * Adapted from Claude Code's fork rendering engine. Provides:
 * - Screen: packed typed-array cell buffer with CharPool/StylePool interning
 * - LogUpdate: frame-to-frame diffing producing minimal terminal writes
 * - Terminal: capability detection + synchronized output writer
 *
 * Usage:
 *   1. Create pools (CharPool, HyperlinkPool, StylePool)
 *   2. Create screens via createScreen()
 *   3. Write cells via setCellAt()
 *   4. Build Frame objects
 *   5. Diff via LogUpdate.render(prev, next)
 *   6. Flush via writeDiffToTerminal()
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
