#!/usr/bin/env node
/**
 * Generates the placeholder app icon (assets/icon-source.png, 1024x1024).
 *
 * The web package has no logo asset yet, so this draws a simple geometric
 * "ink drop" mark programmatically: an off-white teardrop on a dark indigo
 * rounded square. Pure Node — the PNG is encoded by hand with zlib, no
 * image dependencies. Deterministic output.
 *
 * Usage:  node scripts/generate-icon.mjs
 * Then:   npx tauri icon assets/icon-source.png --output src-tauri/icons
 * (or `yarn icon:generate` which does both)
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SS = 4; // supersampling grid per pixel edge (4x4 = 16 samples)

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Rounded-square background.
const RECT = { min: 64, max: 960, radius: 208 };
// Teardrop: circle + tangent triangle up to an apex.
const DROP = { apexX: 512, apexY: 236, cx: 512, cy: 618, r: 196 };

function insideRoundedRect(x, y) {
  const half = (RECT.max - RECT.min) / 2;
  const cx = (RECT.max + RECT.min) / 2;
  const dx = Math.max(Math.abs(x - cx) - (half - RECT.radius), 0);
  const dy = Math.max(Math.abs(y - cx) - (half - RECT.radius), 0);
  return dx * dx + dy * dy <= RECT.radius * RECT.radius;
}

// Tangent points of the lines from the apex to the drop circle.
const tangents = (() => {
  const { apexX, apexY, cx, cy, r } = DROP;
  const dx = apexX - cx;
  const dy = apexY - cy;
  const d = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  const spread = Math.acos(r / d);
  return [base + spread, base - spread].map((a) => ({
    x: cx + r * Math.cos(a),
    y: cy + r * Math.sin(a),
  }));
})();

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const p = { x: px, y: py };
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function insideDrop(x, y) {
  const dx = x - DROP.cx;
  const dy = y - DROP.cy;
  if (dx * dx + dy * dy <= DROP.r * DROP.r) return true;
  return insideTriangle(x, y, { x: DROP.apexX, y: DROP.apexY }, tangents[0], tangents[1]);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
// Background: vertical dark-indigo gradient. Drop: light periwinkle gradient.
const BG_TOP = [38, 46, 99];
const BG_BOTTOM = [17, 20, 46];
const DROP_TOP = [232, 235, 255];
const DROP_BOTTOM = [170, 180, 255];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py++) {
  const t = py / (SIZE - 1);
  const bg = [
    Math.round(lerp(BG_TOP[0], BG_BOTTOM[0], t)),
    Math.round(lerp(BG_TOP[1], BG_BOTTOM[1], t)),
    Math.round(lerp(BG_TOP[2], BG_BOTTOM[2], t)),
  ];
  const fg = [
    Math.round(lerp(DROP_TOP[0], DROP_BOTTOM[0], t)),
    Math.round(lerp(DROP_TOP[1], DROP_BOTTOM[1], t)),
    Math.round(lerp(DROP_TOP[2], DROP_BOTTOM[2], t)),
  ];
  for (let px = 0; px < SIZE; px++) {
    let rectHits = 0;
    let dropHits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (insideRoundedRect(x, y)) {
          rectHits++;
          if (insideDrop(x, y)) dropHits++;
        }
      }
    }
    const total = SS * SS;
    const rectCov = rectHits / total;
    const dropCov = dropHits / total;
    const i = (py * SIZE + px) * 4;
    // Composite: drop over background, alpha from rounded-rect coverage.
    pixels[i] = Math.round(lerp(bg[0], fg[0], dropCov));
    pixels[i + 1] = Math.round(lerp(bg[1], fg[1], dropCov));
    pixels[i + 2] = Math.round(lerp(bg[2], fg[2], dropCov));
    pixels[i + 3] = Math.round(rectCov * 255);
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'icon-source.png');
writeFileSync(outPath, encodePng(SIZE, SIZE, pixels));
console.log(`wrote ${outPath} (${SIZE}x${SIZE})`);
