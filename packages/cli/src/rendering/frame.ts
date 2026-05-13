/**
 * Frame types — describes a single rendered frame for the diff engine.
 * Adapted from Claude Code fork. ScrollHint inlined (was in render-node-to-output.ts).
 */

import type { Cursor } from './cursor.js';
import type { Size } from './layout/geometry.js';
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './screen.js';

export type ScrollHint = { top: number; bottom: number; delta: number };

export type Frame = {
  readonly screen: Screen;
  readonly viewport: Size;
  readonly cursor: Cursor;
  readonly scrollHint?: ScrollHint | null;
  readonly scrollDrainPending?: boolean;
};

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool
): Frame {
  return {
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  };
}

export type FlickerReason = 'resize' | 'offscreen' | 'clear';

export type FrameEvent = {
  durationMs: number;
  phases?: {
    renderer: number;
    diff: number;
    optimize: number;
    write: number;
    patches: number;
    yoga: number;
    commit: number;
    yogaVisited: number;
    yogaMeasured: number;
    yogaCacheHits: number;
    yogaLive: number;
  };
  flickers: Array<{
    desiredHeight: number;
    availableHeight: number;
    reason: FlickerReason;
  }>;
};

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      type: 'clearTerminal';
      reason: FlickerReason;
      debug?: { triggerY: number; prevLine: string; nextLine: string };
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  | { type: 'styleStr'; str: string };

export type Diff = Patch[];

export function shouldClearScreen(prevFrame: Frame, frame: Frame): FlickerReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width;
  if (didResize) return 'resize';

  const currentFrameOverflows = frame.screen.height >= frame.viewport.height;
  const previousFrameOverflowed = prevFrame.screen.height >= prevFrame.viewport.height;
  if (currentFrameOverflows || previousFrameOverflowed) return 'offscreen';

  return undefined;
}
