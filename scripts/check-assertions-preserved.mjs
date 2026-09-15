#!/usr/bin/env node
/**
 * Check that a refactor still asserts the same things.
 *
 * A diff cannot answer that question. It shows lines, and a mechanical rewrite
 * moves lines — so a review of 23 restructured test files is exactly the place
 * where one deleted `expect` goes unnoticed. A green suite does not answer it
 * either: that proves the tests which ran still pass, not that the same number
 * of them ran, asserting the same things, in the same places.
 *
 * So this ignores text. It parses BOTH revisions of every changed test file,
 * walks the syntax tree for every `expect(...)` call, and tags each one with the
 * describe/it titles enclosing it:
 *
 *     packages/api/src/auth/pcp-tokens.test.ts :: pcp-tokens > signPcpAccessToken > returns a valid JWT
 *
 * Comparing the two multisets catches an assertion that vanished AND one that
 * quietly relocated into a different test — which a bare total would miss.
 * Formatting, quoting, import order and mock restructuring are invisible to it.
 *
 * Usage:
 *   node scripts/check-assertions-preserved.mjs <before-rev> <after-rev> [pathspec...]
 *
 * Examples:
 *   node scripts/check-assertions-preserved.mjs HEAD~1 HEAD
 *   node scripts/check-assertions-preserved.mjs origin/main HEAD
 *   node scripts/check-assertions-preserved.mjs origin/main HEAD 'packages/api/**'
 *
 * Exit codes: 0 clean, 1 drift (so it can gate a commit), 2 usage or
 * operational error. An operational error is never reported as clean — see
 * "fail closed" below.
 *
 * WHAT IT PROVES, precisely: that the number of bare `expect(...)` calls is
 * unchanged within each recognized test context. That is narrower than "every
 * assertion survived", and the difference matters:
 *   - It is a COUNT, not an identity. Weakening every `toBe` into
 *     `toBeDefined` passes cleanly.
 *   - `expect(x)` and `expect.soft(x)` are counted as assertions;
 *     `expect.objectContaining(y)` is a matcher ARGUMENT to one and is
 *     reported separately. Conflating them inflates the headline without
 *     adding a check.
 *   - It sees only files changed between the two revisions, and only
 *     `expect`-style assertions. A suite asserting via `assert()` or by
 *     throwing is invisible to it.
 *   - Runtime rows of a parameterized test group under their static template
 *     title, so `it.each` moves are detected between BLOCKS, not between rows.
 *
 * Two properties this tool has to hold, because it exists to catch what tests
 * miss and a verification tool that fails green is worse than none:
 *   NO SHELL.    Revisions and tracked filenames never reach a shell. Git is
 *                invoked as an executable with an argument array, refs are
 *                resolved to SHAs up front, and filenames arrive NUL-delimited
 *                so quoting and newlines cannot corrupt them. A tracked file
 *                named `sample$(echo).test.ts` is a path, not a command.
 *   FAIL CLOSED. Whether a file should exist at a revision is decided from the
 *                diff status, never inferred from a failed read. An unreadable
 *                object is an operational error and exits 2 — it is not
 *                silently counted as zero assertions.
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript', { paths: [process.cwd()] }));

/** Git as an executable, never a shell string. */
function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function die(message, code = 2) {
  console.error(`check-assertions-preserved: ${message}`);
  process.exit(code);
}

/**
 * Resolve a user-supplied ref to a commit SHA.
 *
 * Every later command then receives a 40-hex string rather than whatever the
 * caller typed, so a ref shaped like an option cannot become one.
 */
function resolveCommit(ref) {
  if (ref.startsWith('-')) die(`refusing a revision that looks like an option: ${ref}`);
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  if (!sha) die(`not a commit: ${ref}`);
  return sha.trim();
}

/**
 * Changed files, NUL-delimited, as the pair of paths each revision knows.
 *
 * A file can be called one thing before and another after, so one path is not
 * enough. Each record carries the path to read at each side — null where the
 * file legitimately does not exist there — plus ONE key both sides are counted
 * under. Keying a rename by its two different names would report every
 * assertion in it as simultaneously lost and gained.
 *
 *   A  ->  { before: null, after: path }
 *   D  ->  { before: path, after: null }
 *   M  ->  { before: path, after: path }
 *   R  ->  { before: old,  after: new  }   (same for C, whose source also exists)
 */
function changedFiles(before, after, pathspec) {
  const raw = git(['diff', '--name-status', '-z', before, after, '--', ...pathspec]);
  const fields = raw.split('\0').filter((field) => field !== '');
  const records = [];
  for (let i = 0; i < fields.length; ) {
    const letter = fields[i++][0];
    if (letter === 'R' || letter === 'C') {
      const from = fields[i++];
      const to = fields[i++];
      if (from === undefined || to === undefined) continue;
      records.push({ before: from, after: to, key: to });
    } else {
      const path = fields[i++];
      if (path === undefined) continue;
      records.push({
        before: letter === 'A' ? null : path,
        after: letter === 'D' ? null : path,
        key: path,
      });
    }
  }
  return records;
}

/**
 * Read one object that the diff says exists at this revision.
 *
 * Callers skip the null paths themselves, so reaching here means the file is
 * supposed to be readable. A failure is therefore operational and stops the
 * run — the whole point is that a failed read never masquerades as an absent
 * file, quietly contributing zero assertions.
 */
function readAt(rev, file) {
  const source = git(['show', `${rev}:${file}`], { allowFailure: true });
  if (source === null) {
    die(`could not read ${file} at ${rev.slice(0, 8)}, though the diff says it exists there`);
  }
  return source;
}

/** The leading identifier of a call, unwrapping curried and tagged forms. */
function calleeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return calleeName(node.expression);
  if (ts.isCallExpression(node)) return calleeName(node.expression); // it.each([...])( ... )
  if (ts.isTaggedTemplateExpression(node)) return calleeName(node.tag); // it.each`...`( ... )
  return null;
}

const TEST_DECLARATIONS = new Set(['describe', 'it', 'test', 'suite']);

/**
 * Is this the call that DECLARES a test, rather than the inner table call?
 *
 * `it.each([1])('alpha %s', cb)` is two nested calls. Only the outer one
 * carries the title and the callback; the inner one carries the table. Keying
 * on "has a function argument" picks the outer one in every curried, tagged and
 * plain form, so assertions inside a parameterized callback keep their title
 * instead of inheriting the bare suite.
 */
function isTestDeclaration(node) {
  const name = calleeName(node.expression);
  if (!name || !TEST_DECLARATIONS.has(name)) return false;
  return node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
}

function declaredTitle(node) {
  const literal = node.arguments.find((arg) => ts.isStringLiteralLike(arg));
  return literal ? literal.text : '<dynamic>';
}

/** Every expect in one file, tagged with the test that encloses it. */
function assertionsIn(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  (function walk(node, context) {
    let inner = context;
    if (ts.isCallExpression(node)) {
      if (isTestDeclaration(node)) inner = context.concat(declaredTitle(node));
      // Deliberately NOT calleeName() here. That unwraps nested calls, which is
      // right for curried test declarations and wrong for expect: it also
      // resolves the matcher chain `expect(x).toBe(y)` back to `expect`, so
      // every assertion would be counted twice — once bare, once as its own
      // matcher. Match the two literal shapes instead.
      const callee = node.expression;
      const bare = ts.isIdentifier(callee) && callee.text === 'expect';
      const member =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'expect';
      if (bare || member) {
        // expect(x) asserts, and so does expect.soft(x). Everything else on
        // `expect` is a matcher built to be passed INTO an assertion.
        const isAssertion = bare || callee.name.text === 'soft';
        found.push({ kind: isAssertion ? 'assertion' : 'matcher', key: `${file} :: ${context.join(' > ')}` });
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner));
  })(sourceFile, []);
  return found;
}

const [beforeRef, afterRef, ...pathspecArgs] = process.argv.slice(2);
if (!beforeRef || !afterRef) {
  die('usage: node scripts/check-assertions-preserved.mjs <before-rev> <after-rev> [pathspec...]');
}
const pathspec = pathspecArgs.length ? pathspecArgs : ['*.test.ts', '*.test.tsx'];

const before = resolveCommit(beforeRef);
const after = resolveCommit(afterRef);
const files = changedFiles(before, after, pathspec);

if (files.length === 0) {
  console.log('no test files changed between those revisions — nothing to compare');
  process.exit(0);
}

const gather = (rev, side) => {
  const rows = [];
  for (const record of files) {
    const path = side === 'before' ? record.before : record.after;
    if (path === null) continue; // legitimately absent at this revision
    rows.push(...assertionsIn(readAt(rev, path), record.key));
  }
  return rows;
};

const from = gather(before, 'before');
const to = gather(after, 'after');
const keysOf = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.key);
const tally = (keys) => keys.reduce((acc, k) => ((acc[k] = (acc[k] || 0) + 1), acc), {});

const fromAssertions = tally(keysOf(from, 'assertion'));
const toAssertions = tally(keysOf(to, 'assertion'));
const contexts = [...new Set([...Object.keys(fromAssertions), ...Object.keys(toAssertions)])].sort();
const drift = contexts.filter((c) => (fromAssertions[c] || 0) !== (toAssertions[c] || 0));

console.log(`comparing ${before.slice(0, 8)} -> ${after.slice(0, 8)}`);
console.log(`  test files changed : ${files.length}`);
console.log(`  bare expect() calls: ${keysOf(from, 'assertion').length} -> ${keysOf(to, 'assertion').length}`);
console.log(`  matcher helpers    : ${keysOf(from, 'matcher').length} -> ${keysOf(to, 'matcher').length}`);
console.log(`  contexts drifted   : ${drift.length}`);

for (const context of drift) {
  console.log(`\n  ${fromAssertions[context] || 0} -> ${toAssertions[context] || 0}`);
  console.log(`    ${context}`);
}

if (drift.length) {
  console.log('\nDRIFT: the contexts above gained or lost bare expect() calls. Intended, or an accident of the refactor?');
  process.exit(1);
}
console.log('\nOK: bare expect() counts are unchanged in every recognized context.');
