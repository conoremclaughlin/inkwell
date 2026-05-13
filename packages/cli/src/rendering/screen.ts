// Screen buffer — packed typed-array cell storage with StylePool/CharPool interning.
// Copied from Claude Code fork's rendering engine.

import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from '@alcalzone/ansi-tokenize';
import { type Point, type Rectangle, type Size, unionRect } from './layout/geometry.js';
import { BEL, ESC, SEP } from './termio/ansi.js';

// Stub: original used warn.ts which calls logForDebugging
const warn = {
  ifNotInteger(_value: number | undefined, _name: string): void {},
};

const INVERSE_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[7m',
  endCode: '\x1b[27m',
};
const BOLD_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[1m',
  endCode: '\x1b[22m',
};
const UNDERLINE_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[4m',
  endCode: '\x1b[24m',
};
const YELLOW_FG_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[33m',
  endCode: '\x1b[39m',
};

export class CharPool {
  private strings: string[] = [' ', ''];
  private stringMap = new Map<string, number>([
    [' ', 0],
    ['', 1],
  ]);
  private ascii: Int32Array = initCharAscii();

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;
        const index = this.strings.length;
        this.strings.push(char);
        this.ascii[code] = index;
        return index;
      }
    }
    const existing = this.stringMap.get(char);
    if (existing !== undefined) return existing;
    const index = this.strings.length;
    this.strings.push(char);
    this.stringMap.set(char, index);
    return index;
  }

  get(index: number): string {
    return this.strings[index] ?? ' ';
  }
}

export class HyperlinkPool {
  private strings: string[] = [''];
  private stringMap = new Map<string, number>();

  intern(hyperlink: string | undefined): number {
    if (!hyperlink) return 0;
    let id = this.stringMap.get(hyperlink);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(hyperlink);
      this.stringMap.set(hyperlink, id);
    }
    return id;
  }

  get(id: number): string | undefined {
    return id === 0 ? undefined : this.strings[id];
  }
}

export class StylePool {
  private ids = new Map<string, number>();
  private styles: AnsiCode[][] = [];
  private transitionCache = new Map<number, string>();
  readonly none: number;

  constructor() {
    this.none = this.intern([]);
  }

  intern(styles: AnsiCode[]): number {
    const key = styles.length === 0 ? '' : styles.map((s) => s.code).join('\0');
    let id = this.ids.get(key);
    if (id === undefined) {
      const rawId = this.styles.length;
      this.styles.push(styles.length === 0 ? [] : styles);
      id = (rawId << 1) | (styles.length > 0 && hasVisibleSpaceEffect(styles) ? 1 : 0);
      this.ids.set(key, id);
    }
    return id;
  }

  get(id: number): AnsiCode[] {
    return this.styles[id >>> 1] ?? [];
  }

  transition(fromId: number, toId: number): string {
    if (fromId === toId) return '';
    const key = fromId * 0x100000 + toId;
    let str = this.transitionCache.get(key);
    if (str === undefined) {
      str = ansiCodesToString(diffAnsiCodes(this.get(fromId), this.get(toId)));
      this.transitionCache.set(key, str);
    }
    return str;
  }

  private inverseCache = new Map<number, number>();
  withInverse(baseId: number): number {
    let id = this.inverseCache.get(baseId);
    if (id === undefined) {
      const baseCodes = this.get(baseId);
      const hasInverse = baseCodes.some((c) => c.endCode === '\x1b[27m');
      id = hasInverse ? baseId : this.intern([...baseCodes, INVERSE_CODE]);
      this.inverseCache.set(baseId, id);
    }
    return id;
  }

  private currentMatchCache = new Map<number, number>();
  withCurrentMatch(baseId: number): number {
    let id = this.currentMatchCache.get(baseId);
    if (id === undefined) {
      const baseCodes = this.get(baseId);
      const codes = baseCodes.filter((c) => c.endCode !== '\x1b[39m' && c.endCode !== '\x1b[49m');
      codes.push(YELLOW_FG_CODE);
      if (!baseCodes.some((c) => c.endCode === '\x1b[27m')) codes.push(INVERSE_CODE);
      if (!baseCodes.some((c) => c.endCode === '\x1b[22m')) codes.push(BOLD_CODE);
      if (!baseCodes.some((c) => c.endCode === '\x1b[24m')) codes.push(UNDERLINE_CODE);
      id = this.intern(codes);
      this.currentMatchCache.set(baseId, id);
    }
    return id;
  }

  private selectionBgCode: AnsiCode | null = null;
  private selectionBgCache = new Map<number, number>();
  setSelectionBg(bg: AnsiCode | null): void {
    if (this.selectionBgCode?.code === bg?.code) return;
    this.selectionBgCode = bg;
    this.selectionBgCache.clear();
  }
  withSelectionBg(baseId: number): number {
    const bg = this.selectionBgCode;
    if (bg === null) return this.withInverse(baseId);
    let id = this.selectionBgCache.get(baseId);
    if (id === undefined) {
      const kept = this.get(baseId).filter(
        (c) => c.endCode !== '\x1b[49m' && c.endCode !== '\x1b[27m'
      );
      kept.push(bg);
      id = this.intern(kept);
      this.selectionBgCache.set(baseId, id);
    }
    return id;
  }
}

const VISIBLE_ON_SPACE = new Set(['\x1b[49m', '\x1b[27m', '\x1b[24m', '\x1b[29m', '\x1b[55m']);

function hasVisibleSpaceEffect(styles: AnsiCode[]): boolean {
  for (const style of styles) {
    if (VISIBLE_ON_SPACE.has(style.endCode)) return true;
  }
  return false;
}

export const enum CellWidth {
  Narrow = 0,
  Wide = 1,
  SpacerTail = 2,
  SpacerHead = 3,
}

export type Hyperlink = string | undefined;

export type Cell = {
  char: string;
  styleId: number;
  width: CellWidth;
  hyperlink: Hyperlink;
};

const EMPTY_CHAR_INDEX = 0;
const SPACER_CHAR_INDEX = 1;

function initCharAscii(): Int32Array {
  const table = new Int32Array(128);
  table.fill(-1);
  table[32] = EMPTY_CHAR_INDEX;
  return table;
}

const STYLE_SHIFT = 17;
const HYPERLINK_SHIFT = 2;
const HYPERLINK_MASK = 0x7fff;
const WIDTH_MASK = 3;

function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width;
}

const EMPTY_CELL_VALUE = 0n;

export type Screen = Size & {
  cells: Int32Array;
  cells64: BigInt64Array;
  charPool: CharPool;
  hyperlinkPool: HyperlinkPool;
  emptyStyleId: number;
  damage: Rectangle | undefined;
  noSelect: Uint8Array;
  softWrap: Int32Array;
};

function isEmptyCellByIndex(screen: Screen, index: number): boolean {
  const ci = index << 1;
  return screen.cells[ci] === 0 && screen.cells[ci | 1] === 0;
}

export function isEmptyCellAt(screen: Screen, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return true;
  return isEmptyCellByIndex(screen, y * screen.width + x);
}

export function isCellEmpty(screen: Screen, cell: Cell): boolean {
  return (
    cell.char === ' ' &&
    cell.styleId === screen.emptyStyleId &&
    cell.width === CellWidth.Narrow &&
    !cell.hyperlink
  );
}

function internHyperlink(screen: Screen, hyperlink: Hyperlink): number {
  return screen.hyperlinkPool.intern(hyperlink);
}

export function createScreen(
  width: number,
  height: number,
  styles: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool
): Screen {
  warn.ifNotInteger(width, 'createScreen width');
  warn.ifNotInteger(height, 'createScreen height');

  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0);
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0);
  }

  const size = width * height;
  const buf = new ArrayBuffer(size << 3);
  const cells = new Int32Array(buf);
  const cells64 = new BigInt64Array(buf);

  return {
    width,
    height,
    cells,
    cells64,
    charPool,
    hyperlinkPool,
    emptyStyleId: styles.none,
    damage: undefined,
    noSelect: new Uint8Array(size),
    softWrap: new Int32Array(height),
  };
}

export function resetScreen(screen: Screen, width: number, height: number): void {
  warn.ifNotInteger(width, 'resetScreen width');
  warn.ifNotInteger(height, 'resetScreen height');

  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0);
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0);
  }

  const size = width * height;

  if (screen.cells64.length < size) {
    const buf = new ArrayBuffer(size << 3);
    screen.cells = new Int32Array(buf);
    screen.cells64 = new BigInt64Array(buf);
    screen.noSelect = new Uint8Array(size);
  }
  if (screen.softWrap.length < height) {
    screen.softWrap = new Int32Array(height);
  }

  screen.cells64.fill(EMPTY_CELL_VALUE, 0, size);
  screen.noSelect.fill(0, 0, size);
  screen.softWrap.fill(0, 0, height);

  screen.width = width;
  screen.height = height;
  screen.damage = undefined;
}

export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined;
  return cellAtIndex(screen, y * screen.width + x);
}

export function cellAtIndex(screen: Screen, index: number): Cell {
  const ci = index << 1;
  const word1 = screen.cells[ci + 1]!;
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  return {
    char: screen.charPool.get(screen.cells[ci]!),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : screen.hyperlinkPool.get(hid),
  };
}

export function visibleCellAtIndex(
  cells: Int32Array,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  index: number,
  lastRenderedStyleId: number
): Cell | undefined {
  const ci = index << 1;
  const charId = cells[ci]!;
  if (charId === 1) return undefined;
  const word1 = cells[ci + 1]!;
  if (charId === 0 && (word1 & 0x3fffc) === 0) {
    const fgStyle = word1 >>> STYLE_SHIFT;
    if (fgStyle === 0 || fgStyle === lastRenderedStyleId) return undefined;
  }
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  return {
    char: charPool.get(charId),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : hyperlinkPool.get(hid),
  };
}

function cellAtCI(screen: Screen, ci: number, out: Cell): void {
  const w1 = ci | 1;
  const word1 = screen.cells[w1]!;
  out.char = screen.charPool.get(screen.cells[ci]!);
  out.styleId = word1 >>> STYLE_SHIFT;
  out.width = word1 & WIDTH_MASK;
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  out.hyperlink = hid === 0 ? undefined : screen.hyperlinkPool.get(hid);
}

export function charInCellAt(screen: Screen, x: number, y: number): string | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined;
  const ci = (y * screen.width + x) << 1;
  return screen.charPool.get(screen.cells[ci]!);
}

export function setCellAt(screen: Screen, x: number, y: number, cell: Cell): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return;
  const ci = (y * screen.width + x) << 1;
  const cells = screen.cells;

  const prevWidth = cells[ci + 1]! & WIDTH_MASK;
  if (prevWidth === CellWidth.Wide && cell.width !== CellWidth.Wide) {
    const spacerX = x + 1;
    if (spacerX < screen.width) {
      const spacerCI = ci + 2;
      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
        cells[spacerCI] = EMPTY_CHAR_INDEX;
        cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
      }
    }
  }
  let clearedWideX = -1;
  if (prevWidth === CellWidth.SpacerTail && cell.width !== CellWidth.SpacerTail) {
    if (x > 0) {
      const wideCI = ci - 2;
      if ((cells[wideCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        cells[wideCI] = EMPTY_CHAR_INDEX;
        cells[wideCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
        clearedWideX = x - 1;
      }
    }
  }

  cells[ci] = internCharString(screen, cell.char);
  cells[ci + 1] = packWord1(cell.styleId, internHyperlink(screen, cell.hyperlink), cell.width);

  const minX = clearedWideX >= 0 ? Math.min(x, clearedWideX) : x;
  const damage = screen.damage;
  if (damage) {
    const right = damage.x + damage.width;
    const bottom = damage.y + damage.height;
    if (minX < damage.x) {
      damage.width += damage.x - minX;
      damage.x = minX;
    } else if (x >= right) {
      damage.width = x - damage.x + 1;
    }
    if (y < damage.y) {
      damage.height += damage.y - y;
      damage.y = y;
    } else if (y >= bottom) {
      damage.height = y - damage.y + 1;
    }
  } else {
    screen.damage = { x: minX, y, width: x - minX + 1, height: 1 };
  }

  if (cell.width === CellWidth.Wide) {
    const spacerX = x + 1;
    if (spacerX < screen.width) {
      const spacerCI = ci + 2;
      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        const orphanCI = spacerCI + 2;
        if (
          spacerX + 1 < screen.width &&
          (cells[orphanCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail
        ) {
          cells[orphanCI] = EMPTY_CHAR_INDEX;
          cells[orphanCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
        }
      }
      cells[spacerCI] = SPACER_CHAR_INDEX;
      cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.SpacerTail);

      const d = screen.damage;
      if (d && spacerX >= d.x + d.width) {
        d.width = spacerX - d.x + 1;
      }
    }
  }
}

export function setCellStyleId(screen: Screen, x: number, y: number, styleId: number): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return;
  const ci = (y * screen.width + x) << 1;
  const cells = screen.cells;
  const word1 = cells[ci + 1]!;
  const width = word1 & WIDTH_MASK;
  if (width === CellWidth.SpacerTail || width === CellWidth.SpacerHead) return;
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  cells[ci + 1] = packWord1(styleId, hid, width);
  const d = screen.damage;
  if (d) {
    screen.damage = unionRect(d, { x, y, width: 1, height: 1 });
  } else {
    screen.damage = { x, y, width: 1, height: 1 };
  }
}

function internCharString(screen: Screen, char: string): number {
  return screen.charPool.intern(char);
}

export function blitRegion(
  dst: Screen,
  src: Screen,
  regionX: number,
  regionY: number,
  maxX: number,
  maxY: number
): void {
  regionX = Math.max(0, regionX);
  regionY = Math.max(0, regionY);
  if (regionX >= maxX || regionY >= maxY) return;

  const rowLen = maxX - regionX;
  const srcStride = src.width << 1;
  const dstStride = dst.width << 1;
  const rowBytes = rowLen << 1;
  const srcCells = src.cells;
  const dstCells = dst.cells;
  const srcNoSel = src.noSelect;
  const dstNoSel = dst.noSelect;

  dst.softWrap.set(src.softWrap.subarray(regionY, maxY), regionY);

  if (regionX === 0 && maxX === src.width && src.width === dst.width) {
    const srcStart = regionY * srcStride;
    const totalBytes = (maxY - regionY) * srcStride;
    dstCells.set(srcCells.subarray(srcStart, srcStart + totalBytes), srcStart);
    const nsStart = regionY * src.width;
    const nsLen = (maxY - regionY) * src.width;
    dstNoSel.set(srcNoSel.subarray(nsStart, nsStart + nsLen), nsStart);
  } else {
    let srcRowCI = regionY * srcStride + (regionX << 1);
    let dstRowCI = regionY * dstStride + (regionX << 1);
    let srcRowNS = regionY * src.width + regionX;
    let dstRowNS = regionY * dst.width + regionX;
    for (let y = regionY; y < maxY; y++) {
      dstCells.set(srcCells.subarray(srcRowCI, srcRowCI + rowBytes), dstRowCI);
      dstNoSel.set(srcNoSel.subarray(srcRowNS, srcRowNS + rowLen), dstRowNS);
      srcRowCI += srcStride;
      dstRowCI += dstStride;
      srcRowNS += src.width;
      dstRowNS += dst.width;
    }
  }

  const regionRect = { x: regionX, y: regionY, width: rowLen, height: maxY - regionY };
  if (dst.damage) {
    dst.damage = unionRect(dst.damage, regionRect);
  } else {
    dst.damage = regionRect;
  }

  if (maxX < dst.width) {
    let srcLastCI = (regionY * src.width + (maxX - 1)) << 1;
    let dstSpacerCI = (regionY * dst.width + maxX) << 1;
    let wroteSpacerOutsideRegion = false;
    for (let y = regionY; y < maxY; y++) {
      if ((srcCells[srcLastCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        dstCells[dstSpacerCI] = SPACER_CHAR_INDEX;
        dstCells[dstSpacerCI + 1] = packWord1(dst.emptyStyleId, 0, CellWidth.SpacerTail);
        wroteSpacerOutsideRegion = true;
      }
      srcLastCI += srcStride;
      dstSpacerCI += dstStride;
    }
    if (wroteSpacerOutsideRegion && dst.damage) {
      const rightEdge = dst.damage.x + dst.damage.width;
      if (rightEdge === maxX) {
        dst.damage = { ...dst.damage, width: dst.damage.width + 1 };
      }
    }
  }
}

export function clearRegion(
  screen: Screen,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number
): void {
  const startX = Math.max(0, regionX);
  const startY = Math.max(0, regionY);
  const maxX = Math.min(regionX + regionWidth, screen.width);
  const maxY = Math.min(regionY + regionHeight, screen.height);
  if (startX >= maxX || startY >= maxY) return;

  const cells = screen.cells;
  const cells64 = screen.cells64;
  const screenWidth = screen.width;
  const rowBase = startY * screenWidth;
  let damageMinX = startX;
  let damageMaxX = maxX;

  if (startX === 0 && maxX === screenWidth) {
    cells64.fill(EMPTY_CELL_VALUE, rowBase, rowBase + (maxY - startY) * screenWidth);
  } else {
    const stride = screenWidth << 1;
    const rowLen = maxX - startX;
    const checkLeft = startX > 0;
    const checkRight = maxX < screenWidth;
    let leftEdge = (rowBase + startX) << 1;
    let rightEdge = (rowBase + maxX - 1) << 1;
    let fillStart = rowBase + startX;

    for (let y = startY; y < maxY; y++) {
      if (checkLeft) {
        if ((cells[leftEdge + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
          const prevW1 = leftEdge - 1;
          if ((cells[prevW1]! & WIDTH_MASK) === CellWidth.Wide) {
            cells[prevW1 - 1] = EMPTY_CHAR_INDEX;
            cells[prevW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
            damageMinX = startX - 1;
          }
        }
      }

      if (checkRight) {
        if ((cells[rightEdge + 1]! & WIDTH_MASK) === CellWidth.Wide) {
          const nextW1 = rightEdge + 3;
          if ((cells[nextW1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
            cells[nextW1 - 1] = EMPTY_CHAR_INDEX;
            cells[nextW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
            damageMaxX = maxX + 1;
          }
        }
      }

      cells64.fill(EMPTY_CELL_VALUE, fillStart, fillStart + rowLen);
      leftEdge += stride;
      rightEdge += stride;
      fillStart += screenWidth;
    }
  }

  const regionRect = {
    x: damageMinX,
    y: startY,
    width: damageMaxX - damageMinX,
    height: maxY - startY,
  };
  if (screen.damage) {
    screen.damage = unionRect(screen.damage, regionRect);
  } else {
    screen.damage = regionRect;
  }
}

export function shiftRows(screen: Screen, top: number, bottom: number, n: number): void {
  if (n === 0 || top < 0 || bottom >= screen.height || top > bottom) return;
  const w = screen.width;
  const cells64 = screen.cells64;
  const noSel = screen.noSelect;
  const sw = screen.softWrap;
  const absN = Math.abs(n);
  if (absN > bottom - top) {
    cells64.fill(EMPTY_CELL_VALUE, top * w, (bottom + 1) * w);
    noSel.fill(0, top * w, (bottom + 1) * w);
    sw.fill(0, top, bottom + 1);
    return;
  }
  if (n > 0) {
    cells64.copyWithin(top * w, (top + n) * w, (bottom + 1) * w);
    noSel.copyWithin(top * w, (top + n) * w, (bottom + 1) * w);
    sw.copyWithin(top, top + n, bottom + 1);
    cells64.fill(EMPTY_CELL_VALUE, (bottom - n + 1) * w, (bottom + 1) * w);
    noSel.fill(0, (bottom - n + 1) * w, (bottom + 1) * w);
    sw.fill(0, bottom - n + 1, bottom + 1);
  } else {
    cells64.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w);
    noSel.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w);
    sw.copyWithin(top - n, top, bottom + n + 1);
    cells64.fill(EMPTY_CELL_VALUE, top * w, (top - n) * w);
    noSel.fill(0, top * w, (top - n) * w);
    sw.fill(0, top, top - n);
  }
}

const OSC8_REGEX = new RegExp(`^${ESC}\\]8${SEP}${SEP}([^${BEL}]*)${BEL}$`);
export const OSC8_PREFIX = `${ESC}]8${SEP}`;

export function extractHyperlinkFromStyles(styles: AnsiCode[]): Hyperlink | null {
  for (const style of styles) {
    const code = style.code;
    if (code.length < 5 || !code.startsWith(OSC8_PREFIX)) continue;
    const match = code.match(OSC8_REGEX);
    if (match) {
      return match[1] || null;
    }
  }
  return null;
}

export function filterOutHyperlinkStyles(styles: AnsiCode[]): AnsiCode[] {
  return styles.filter(
    (style) => !style.code.startsWith(OSC8_PREFIX) || !OSC8_REGEX.test(style.code)
  );
}

export function diff(
  prev: Screen,
  next: Screen
): [point: Point, removed: Cell | undefined, added: Cell | undefined][] {
  const output: [Point, Cell | undefined, Cell | undefined][] = [];
  diffEach(prev, next, (x, y, removed, added) => {
    output.push([{ x, y }, removed ? { ...removed } : undefined, added ? { ...added } : undefined]);
  });
  return output;
}

type DiffCallback = (
  x: number,
  y: number,
  removed: Cell | undefined,
  added: Cell | undefined
) => boolean | void;

export function diffEach(prev: Screen, next: Screen, cb: DiffCallback): boolean {
  const prevWidth = prev.width;
  const nextWidth = next.width;
  const prevHeight = prev.height;
  const nextHeight = next.height;

  let region: Rectangle;
  if (prevWidth === 0 && prevHeight === 0) {
    region = { x: 0, y: 0, width: nextWidth, height: nextHeight };
  } else if (next.damage) {
    region = next.damage;
    if (prev.damage) {
      region = unionRect(region, prev.damage);
    }
  } else if (prev.damage) {
    region = prev.damage;
  } else {
    region = { x: 0, y: 0, width: 0, height: 0 };
  }

  if (prevHeight > nextHeight) {
    region = unionRect(region, {
      x: 0,
      y: nextHeight,
      width: prevWidth,
      height: prevHeight - nextHeight,
    });
  }
  if (prevWidth > nextWidth) {
    region = unionRect(region, {
      x: nextWidth,
      y: 0,
      width: prevWidth - nextWidth,
      height: prevHeight,
    });
  }

  const maxHeight = Math.max(prevHeight, nextHeight);
  const maxWidth = Math.max(prevWidth, nextWidth);
  const endY = Math.min(region.y + region.height, maxHeight);
  const endX = Math.min(region.x + region.width, maxWidth);

  if (prevWidth === nextWidth) {
    return diffSameWidth(prev, next, region.x, endX, region.y, endY, cb);
  }
  return diffDifferentWidth(prev, next, region.x, endX, region.y, endY, cb);
}

function findNextDiff(a: Int32Array, b: Int32Array, w0: number, count: number): number {
  for (let i = 0; i < count; i++, w0 += 2) {
    const w1 = w0 | 1;
    if (a[w0] !== b[w0] || a[w1] !== b[w1]) return i;
  }
  return count;
}

function diffRowBoth(
  prevCells: Int32Array,
  nextCells: Int32Array,
  prev: Screen,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  nextCell: Cell,
  cb: DiffCallback
): boolean {
  let x = startX;
  while (x < endX) {
    const skip = findNextDiff(prevCells, nextCells, ci, endX - x);
    x += skip;
    ci += skip << 1;
    if (x >= endX) break;
    cellAtCI(prev, ci, prevCell);
    cellAtCI(next, ci, nextCell);
    if (cb(x, y, prevCell, nextCell)) return true;
    x++;
    ci += 2;
  }
  return false;
}

function diffRowRemoved(
  prev: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  cb: DiffCallback
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    cellAtCI(prev, ci, prevCell);
    if (cb(x, y, prevCell, undefined)) return true;
  }
  return false;
}

function diffRowAdded(
  nextCells: Int32Array,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  nextCell: Cell,
  cb: DiffCallback
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    if (nextCells[ci] === 0 && nextCells[ci | 1] === 0) continue;
    cellAtCI(next, ci, nextCell);
    if (cb(x, y, undefined, nextCell)) return true;
  }
  return false;
}

function diffSameWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback
): boolean {
  const prevCells = prev.cells;
  const nextCells = next.cells;
  const width = prev.width;
  const prevHeight = prev.height;
  const nextHeight = next.height;
  const stride = width << 1;

  const prevCell: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined };
  const nextCell: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined };

  const rowEndX = Math.min(endX, width);
  let rowCI = (startY * width + startX) << 1;

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prevHeight;
    const nextIn = y < nextHeight;

    if (prevIn && nextIn) {
      if (
        diffRowBoth(
          prevCells,
          nextCells,
          prev,
          next,
          rowCI,
          y,
          startX,
          rowEndX,
          prevCell,
          nextCell,
          cb
        )
      )
        return true;
    } else if (prevIn) {
      if (diffRowRemoved(prev, rowCI, y, startX, rowEndX, prevCell, cb)) return true;
    } else if (nextIn) {
      if (diffRowAdded(nextCells, next, rowCI, y, startX, rowEndX, nextCell, cb)) return true;
    }

    rowCI += stride;
  }

  return false;
}

function diffDifferentWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback
): boolean {
  const prevWidth = prev.width;
  const nextWidth = next.width;
  const prevCells = prev.cells;
  const nextCells = next.cells;

  const prevCell: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined };
  const nextCell: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined };

  const prevStride = prevWidth << 1;
  const nextStride = nextWidth << 1;
  let prevRowCI = (startY * prevWidth + startX) << 1;
  let nextRowCI = (startY * nextWidth + startX) << 1;

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prev.height;
    const nextIn = y < next.height;
    const prevEndX = prevIn ? Math.min(endX, prevWidth) : startX;
    const nextEndX = nextIn ? Math.min(endX, nextWidth) : startX;
    const bothEndX = Math.min(prevEndX, nextEndX);

    let prevCI = prevRowCI;
    let nextCI = nextRowCI;

    for (let x = startX; x < bothEndX; x++) {
      if (
        prevCells[prevCI] === nextCells[nextCI] &&
        prevCells[prevCI + 1] === nextCells[nextCI + 1]
      ) {
        prevCI += 2;
        nextCI += 2;
        continue;
      }
      cellAtCI(prev, prevCI, prevCell);
      cellAtCI(next, nextCI, nextCell);
      prevCI += 2;
      nextCI += 2;
      if (cb(x, y, prevCell, nextCell)) return true;
    }

    if (prevEndX > bothEndX) {
      prevCI = prevRowCI + ((bothEndX - startX) << 1);
      for (let x = bothEndX; x < prevEndX; x++) {
        cellAtCI(prev, prevCI, prevCell);
        prevCI += 2;
        if (cb(x, y, prevCell, undefined)) return true;
      }
    }

    if (nextEndX > bothEndX) {
      nextCI = nextRowCI + ((bothEndX - startX) << 1);
      for (let x = bothEndX; x < nextEndX; x++) {
        if (nextCells[nextCI] === 0 && nextCells[nextCI | 1] === 0) {
          nextCI += 2;
          continue;
        }
        cellAtCI(next, nextCI, nextCell);
        nextCI += 2;
        if (cb(x, y, undefined, nextCell)) return true;
      }
    }

    prevRowCI += prevStride;
    nextRowCI += nextStride;
  }

  return false;
}

export function markNoSelectRegion(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const maxX = Math.min(x + width, screen.width);
  const maxY = Math.min(y + height, screen.height);
  const noSel = screen.noSelect;
  const stride = screen.width;
  for (let row = Math.max(0, y); row < maxY; row++) {
    const rowStart = row * stride;
    noSel.fill(1, rowStart + Math.max(0, x), rowStart + maxX);
  }
}

export function migrateScreenPools(
  screen: Screen,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool
): void {
  const oldCharPool = screen.charPool;
  const oldHyperlinkPool = screen.hyperlinkPool;
  if (oldCharPool === charPool && oldHyperlinkPool === hyperlinkPool) return;

  const size = screen.width * screen.height;
  const cells = screen.cells;

  for (let ci = 0; ci < size << 1; ci += 2) {
    const oldCharId = cells[ci]!;
    cells[ci] = charPool.intern(oldCharPool.get(oldCharId));

    const word1 = cells[ci + 1]!;
    const oldHyperlinkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
    if (oldHyperlinkId !== 0) {
      const oldStr = oldHyperlinkPool.get(oldHyperlinkId);
      const newHyperlinkId = hyperlinkPool.intern(oldStr);
      const styleId = word1 >>> STYLE_SHIFT;
      const width = word1 & WIDTH_MASK;
      cells[ci + 1] = packWord1(styleId, newHyperlinkId, width);
    }
  }

  screen.charPool = charPool;
  screen.hyperlinkPool = hyperlinkPool;
}
