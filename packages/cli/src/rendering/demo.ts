#!/usr/bin/env tsx
/**
 * Visual demo — exercises the rendering pipeline end-to-end.
 * Run with: npx tsx packages/cli/src/rendering/demo.ts
 */

import { type AnsiCode } from '@alcalzone/ansi-tokenize';
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  setCellAt,
  CellWidth,
  type Frame,
  LogUpdate,
  writeDiffToTerminal,
  emptyFrame,
} from './index.js';

const charPool = new CharPool();
const hyperlinkPool = new HyperlinkPool();
const stylePool = new StylePool();

// Define some styles
const boldStyle: AnsiCode[] = [{ type: 'ansi', code: '\x1b[1m', endCode: '\x1b[22m' }];
const greenFg: AnsiCode[] = [{ type: 'ansi', code: '\x1b[32m', endCode: '\x1b[39m' }];
const cyanFg: AnsiCode[] = [{ type: 'ansi', code: '\x1b[36m', endCode: '\x1b[39m' }];
const magentaFg: AnsiCode[] = [{ type: 'ansi', code: '\x1b[35m', endCode: '\x1b[39m' }];
const yellowFg: AnsiCode[] = [{ type: 'ansi', code: '\x1b[33m', endCode: '\x1b[39m' }];
const boldGreen: AnsiCode[] = [...boldStyle, ...greenFg];
const boldCyan: AnsiCode[] = [...boldStyle, ...cyanFg];
const dimStyle: AnsiCode[] = [{ type: 'ansi', code: '\x1b[2m', endCode: '\x1b[22m' }];

const boldId = stylePool.intern(boldStyle);
const greenId = stylePool.intern(greenFg);
const cyanId = stylePool.intern(cyanFg);
const magentaId = stylePool.intern(magentaFg);
const yellowId = stylePool.intern(yellowFg);
const boldGreenId = stylePool.intern(boldGreen);
const boldCyanId = stylePool.intern(boldCyan);
const dimId = stylePool.intern(dimStyle);

const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;

function writeText(
  screen: ReturnType<typeof createScreen>,
  x: number,
  y: number,
  text: string,
  styleId = stylePool.none
) {
  for (let i = 0; i < text.length; i++) {
    setCellAt(screen, x + i, y, {
      char: text[i]!,
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    });
  }
}

function drawBox(
  screen: ReturnType<typeof createScreen>,
  x: number,
  y: number,
  w: number,
  h: number,
  styleId: number
) {
  // Corners
  setCellAt(screen, x, y, { char: '┌', styleId, width: CellWidth.Narrow, hyperlink: undefined });
  setCellAt(screen, x + w - 1, y, {
    char: '┐',
    styleId,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  });
  setCellAt(screen, x, y + h - 1, {
    char: '└',
    styleId,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  });
  setCellAt(screen, x + w - 1, y + h - 1, {
    char: '┘',
    styleId,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  });
  // Horizontal edges
  for (let i = 1; i < w - 1; i++) {
    setCellAt(screen, x + i, y, {
      char: '─',
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    });
    setCellAt(screen, x + i, y + h - 1, {
      char: '─',
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    });
  }
  // Vertical edges
  for (let j = 1; j < h - 1; j++) {
    setCellAt(screen, x, y + j, {
      char: '│',
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    });
    setCellAt(screen, x + w - 1, y + j, {
      char: '│',
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    });
  }
}

// --- Frame 1: Draw a box with banner ---
const width = Math.min(cols, 60);
const height = 12;
const screen1 = createScreen(width, height, stylePool, charPool, hyperlinkPool);

drawBox(screen1, 0, 0, width, height, dimId);
writeText(screen1, 2, 0, ' Ink Rendering Engine Demo ', boldCyanId);

writeText(screen1, 2, 2, 'Screen buffer:', boldId);
writeText(screen1, 2, 3, `  ${width}x${height} cells, packed Int32Array`, greenId);
writeText(screen1, 2, 4, `  CharPool + StylePool interning`, greenId);

writeText(screen1, 2, 6, 'Diff engine:', boldId);
writeText(screen1, 2, 7, '  Frame-to-frame diffing', magentaId);
writeText(screen1, 2, 8, '  Minimal terminal writes', magentaId);

writeText(screen1, 2, 10, 'DEC 2026 synchronized output', yellowId);

const prev: Frame = emptyFrame(rows, width, stylePool, charPool, hyperlinkPool);
const frame1: Frame = {
  screen: screen1,
  viewport: { width, height: rows },
  cursor: { x: 0, y: height, visible: true },
};

const isTTY = process.stdout.isTTY ?? false;
const logUpdate = new LogUpdate({ isTTY, stylePool });
// Also create a forced-TTY instance to test incremental diff
const logUpdateTTY = new LogUpdate({ isTTY: true, stylePool });
const terminal = { stdout: process.stdout, stderr: process.stderr };

// Render frame 1
const diff1 = logUpdate.render(prev, frame1);
writeDiffToTerminal(terminal, diff1);

// --- Frame 2: Update some text (incremental diff) ---
const screen2 = createScreen(width, height, stylePool, charPool, hyperlinkPool);
drawBox(screen2, 0, 0, width, height, dimId);
writeText(screen2, 2, 0, ' Ink Rendering Engine Demo ', boldCyanId);

writeText(screen2, 2, 2, 'Screen buffer:', boldId);
writeText(screen2, 2, 3, `  ${width}x${height} cells, packed Int32Array`, greenId);
writeText(screen2, 2, 4, `  CharPool + StylePool interning`, greenId);

writeText(screen2, 2, 6, 'Diff engine:', boldId);
writeText(screen2, 2, 7, '  Frame-to-frame diffing', magentaId);
writeText(screen2, 2, 8, '  Only 2 cells changed this frame!', boldGreenId);

writeText(screen2, 2, 10, 'DEC 2026 synchronized output', yellowId);

const frame2: Frame = {
  screen: screen2,
  viewport: { width, height: rows },
  cursor: { x: 0, y: height, visible: true },
};

const diff2 = logUpdate.render(frame1, frame2);

// Render frame 2 (incremental update)
writeDiffToTerminal(terminal, diff2);

// Show stats below the rendered content
const patchCount = diff2.length;
const byteCount = diff2.reduce((n, p) => {
  if (p.type === 'stdout') return n + p.content.length;
  if (p.type === 'styleStr') return n + p.str.length;
  return n + 4;
}, 0);
const patchTypes = [...new Set(diff2.map((p) => p.type))].join(', ');

process.stdout.write(`\nisTTY: ${isTTY}\n`);
process.stdout.write(`Frame 1 → 2: ${patchCount} patches (${patchTypes}), ~${byteCount} bytes\n`);

// Test the TTY diff path separately to verify incremental diffing
logUpdateTTY.render(prev, frame1);
const ttyDiff = logUpdateTTY.render(frame1, frame2);
const ttyPatchTypes = [...new Set(ttyDiff.map((p) => p.type))].join(', ');
const ttyBytes = ttyDiff.reduce((n, p) => {
  if (p.type === 'stdout') return n + p.content.length;
  if (p.type === 'styleStr') return n + p.str.length;
  return n + 4;
}, 0);

process.stdout.write(
  `TTY diff:    ${ttyDiff.length} patches (${ttyPatchTypes}), ~${ttyBytes} bytes\n`
);
process.stdout.write(`Full redraw: ${width * height * 2} bytes\n\n`);
