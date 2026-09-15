#!/usr/bin/env node
/**
 * Regression coverage for the assertion-preservation check.
 *
 * These exist because the first version of that script failed GREEN. A tracked
 * filename containing a space made `git show` fail, the failure was caught and
 * read as "file absent at this revision", and a real deleted assertion was
 * reported as `0 -> 0 ... OK`, exit 0 (Lumen, PR #635). A verification tool
 * that passes when it cannot see is worse than no tool, so the properties it
 * has to hold are pinned here rather than trusted.
 *
 * Four tiers:
 *
 *   PATHS        — filenames the shell would mangle are treated as paths:
 *                  spaces, and command-substitution metacharacters.
 *   LIFECYCLE    — added and deleted files are handled from the diff STATUS,
 *                  so legitimate absence still works once reads fail closed.
 *   FAIL CLOSED  — when an object that should exist cannot be read, the run
 *                  stops with exit 2. It is never counted as zero assertions.
 *   PARAMETERIZED— an assertion moved between two `it.each` blocks is drift.
 *                  Before the fix both blocks collapsed to the bare suite and
 *                  the move reported 1 -> 1, clean.
 *
 * Usage: node scripts/check-assertions-preserved.test.mjs
 * Exits 0 when every case holds, 1 otherwise.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CHECK = resolve('scripts/check-assertions-preserved.mjs');
const TYPESCRIPT = resolve('node_modules/typescript');
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

let failures = 0;
const ok = (name) => console.log(`PASS ${name}`);
const bad = (name, detail) => {
  console.log(`FAIL ${name}\n     ${detail}`);
  failures++;
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'assertion-check-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(TYPESCRIPT, join(dir, 'node_modules', 'typescript'));
  return dir;
}

const commit = (dir, message) => {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
};

/** Run the check in `dir`; never throws, so a non-zero exit is data. */
function run(dir, args, extraPath) {
  try {
    const out = execFileSync('node', [CHECK, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: extraPath ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

const TWO = "describe('s', () => { it('t', () => { expect(1).toBe(1); expect(2).toBe(2); }); });\n";
const ONE = "describe('s', () => { it('t', () => { expect(1).toBe(1); }); });\n";

// ─── PATHS ──────────────────────────────────────────────────────────────────
for (const [label, name] of [
  ['a filename containing a space', 'my spaced.test.ts'],
  ['a filename containing shell metacharacters', 'sample$(echo).test.ts'],
]) {
  const dir = repo();
  writeFileSync(join(dir, name), TWO);
  commit(dir, 'two assertions');
  writeFileSync(join(dir, name), ONE);
  commit(dir, 'one assertion');
  const { code, out } = run(dir, ['HEAD~1', 'HEAD']);
  if (code === 1 && /contexts drifted   : 1/.test(out)) ok(`PATHS: detects a removal in ${label}`);
  else bad(`PATHS: detects a removal in ${label}`, `exit ${code}\n     ${out.trim().split('\n').join('\n     ')}`);
  rmSync(dir, { recursive: true, force: true });
}

// ─── LIFECYCLE ──────────────────────────────────────────────────────────────
{
  const dir = repo();
  writeFileSync(join(dir, 'kept.test.ts'), ONE);
  commit(dir, 'base');
  writeFileSync(join(dir, 'added.test.ts'), TWO);
  commit(dir, 'add a test file');
  const { code, out } = run(dir, ['HEAD~1', 'HEAD']);
  if (code === 1 && /0 -> 2/.test(out)) ok('LIFECYCLE: a newly added test file reads as added assertions');
  else bad('LIFECYCLE: a newly added test file reads as added assertions', `exit ${code}\n     ${out.trim()}`);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = repo();
  writeFileSync(join(dir, 'gone.test.ts'), TWO);
  commit(dir, 'base');
  rmSync(join(dir, 'gone.test.ts'));
  commit(dir, 'delete the test file');
  const { code, out } = run(dir, ['HEAD~1', 'HEAD']);
  if (code === 1 && /2 -> 0/.test(out)) ok('LIFECYCLE: a deleted test file reads as removed assertions, not an error');
  else bad('LIFECYCLE: a deleted test file reads as removed assertions, not an error', `exit ${code}\n     ${out.trim()}`);
  rmSync(dir, { recursive: true, force: true });
}

// ─── FAIL CLOSED ────────────────────────────────────────────────────────────
{
  const dir = repo();
  writeFileSync(join(dir, 'unreadable.test.ts'), TWO);
  commit(dir, 'base');
  writeFileSync(join(dir, 'unreadable.test.ts'), ONE);
  commit(dir, 'one assertion');

  // A git shim that behaves normally except that `show` always fails — the
  // shape of a corrupt object or a mid-run repository fault.
  const shimDir = mkdtempSync(join(tmpdir(), 'assertion-check-shim-'));
  const shim = join(shimDir, 'git');
  writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "show" ]; then exit 128; fi\ndone\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(shim, 0o755);

  const { code, out } = run(dir, ['HEAD~1', 'HEAD'], shimDir);
  if (code === 2 && /could not read/.test(out)) ok('FAIL CLOSED: an unreadable object exits 2 rather than reporting clean');
  else bad('FAIL CLOSED: an unreadable object exits 2 rather than reporting clean', `exit ${code}\n     ${out.trim()}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
}

// ─── PARAMETERIZED ──────────────────────────────────────────────────────────
{
  const dir = repo();
  const before = `describe('s', () => {
  it.each([1])('alpha %s', () => { expect(1).toBe(1); });
  it.each([1])('beta %s', () => { expect(2).toBe(2); });
});
`;
  // The assertion moves from the alpha block into the beta block. Totals are
  // unchanged, so only a per-context comparison can see it.
  const after = `describe('s', () => {
  it.each([1])('alpha %s', () => {});
  it.each([1])('beta %s', () => { expect(2).toBe(2); expect(1).toBe(1); });
});
`;
  writeFileSync(join(dir, 'table.test.ts'), before);
  commit(dir, 'base');
  writeFileSync(join(dir, 'table.test.ts'), after);
  commit(dir, 'relocate an assertion between it.each blocks');
  const { code, out } = run(dir, ['HEAD~1', 'HEAD']);
  if (code === 1 && /alpha/.test(out) && /beta/.test(out)) {
    ok('PARAMETERIZED: an assertion moved between it.each blocks is drift, and both titles are named');
  } else {
    bad('PARAMETERIZED: an assertion moved between it.each blocks is drift, and both titles are named',
        `exit ${code}\n     ${out.trim().split('\n').join('\n     ')}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ─── CONTROL ────────────────────────────────────────────────────────────────
{
  const dir = repo();
  writeFileSync(join(dir, 'stable.test.ts'), TWO);
  commit(dir, 'base');
  writeFileSync(join(dir, 'stable.test.ts'), TWO.replace("describe('s'", "describe(  's'"));
  commit(dir, 'reformat only');
  const { code, out } = run(dir, ['HEAD~1', 'HEAD']);
  if (code === 0 && /contexts drifted   : 0/.test(out)) ok('CONTROL: a formatting-only change is not drift');
  else bad('CONTROL: a formatting-only change is not drift', `exit ${code}\n     ${out.trim()}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CASES HOLD' : `${failures} CASE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
