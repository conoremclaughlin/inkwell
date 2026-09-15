#!/usr/bin/env node
/**
 * Flag modules that DO something when you import them.
 *
 * A test that imports such a module runs it. In this repo that has already
 * meant booting a real HTTP server from inside `vitest run`, and arming the
 * channel plugin's inbox poller (PR #635, twice). Neither failed the suite:
 * the tests passed and the side effect happened anyway, which is exactly why
 * this needs to be checked rather than noticed.
 *
 * Usage: node scripts/check-import-side-effects.mjs <file...>
 *
 * Heuristic, deliberately: it reports top-level statements that execute, and
 * leaves the judgement to a person. Declarations, exports, imports, types and
 * constant initialisers are ignored.
 */
import { readFileSync } from 'fs';

const SAFE_START =
  /^(import |export |\/\/|\/\*|\s*\*|type |interface |enum |declare |const |let |var |function |class |async function |})/;

/** Top-level = column 0, since this repo is formatted by prettier. */
function topLevelEffects(source) {
  const hits = [];
  const lines = source.split('\n');
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (line.trim() === '' || /^\s/.test(line)) continue;
    if (SAFE_START.test(line)) continue;
    // A bare top-level statement that starts with an identifier and calls
    // something, or awaits, is an effect at import time.
    if (/^[A-Za-z_$][\w$.]*\s*\(/.test(line) || /^await\s/.test(line) || /^void\s/.test(line)) {
      hits.push({ line: i + 1, text: line.trim().slice(0, 100) });
    }
  }
  return hits;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/check-import-side-effects.mjs <file...>');
  process.exit(2);
}

let flagged = 0;
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    console.log(`SKIP  ${file} (unreadable)`);
    continue;
  }
  const hits = topLevelEffects(source);
  if (hits.length === 0) {
    console.log(`ok    ${file}`);
    continue;
  }
  flagged++;
  console.log(`EFFECT ${file}`);
  for (const h of hits) console.log(`         ${h.line}: ${h.text}`);
}
console.log(`\n${flagged} of ${files.length} module(s) run something on import.`);
process.exit(flagged > 0 ? 1 : 0);
