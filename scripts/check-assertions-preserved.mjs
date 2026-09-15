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
 * So this ignores text entirely. It parses BOTH revisions of every changed test
 * file, walks the syntax tree for every `expect(...)` call, and tags each one
 * with the describe/it titles enclosing it:
 *
 *     packages/api/src/auth/pcp-tokens.test.ts :: pcp-tokens > signPcpAccessToken > returns a valid JWT
 *
 * Then it compares the two multisets. Identical means every assertion survived
 * AND stayed in the same test — an assertion silently relocated into a
 * different `it` shows as drift even when the totals match. Formatting,
 * quoting, import order and mock restructuring are invisible to it.
 *
 * Usage:
 *   node scripts/check-assertions-preserved.mjs <before-rev> <after-rev> [pathspec...]
 *
 * Examples:
 *   # a single commit
 *   node scripts/check-assertions-preserved.mjs HEAD~1 HEAD
 *
 *   # a whole branch against its base
 *   node scripts/check-assertions-preserved.mjs origin/main HEAD
 *
 *   # narrow it to one package
 *   node scripts/check-assertions-preserved.mjs origin/main HEAD 'packages/api/**'
 *
 * Exit code 0 when nothing drifted, 1 when something did (so it can gate a
 * commit), 2 on a usage error.
 *
 * Counting note: a bare `expect(x)` is an assertion. `expect.objectContaining(y)`
 * is a matcher *argument* to one, and is reported separately — conflating them
 * inflates the headline number without adding a check.
 *
 * Limits, so the number is not trusted further than it goes. This proves
 * assertions were preserved, never that they were CORRECT: a refactor that
 * weakens every `toBe` into `toBeDefined` passes here. It only sees files that
 * changed between the two revisions, and only `expect`-style assertions — a
 * suite asserting by `assert()` or by throwing is invisible to it. Dynamic
 * titles are recorded as `<dynamic>`, so `it.each` blocks group together.
 */
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript', { paths: [process.cwd()] }));

const [before, after, ...pathspec] = process.argv.slice(2);
if (!before || !after) {
  console.error('usage: node scripts/check-assertions-preserved.mjs <before-rev> <after-rev> [pathspec...]');
  process.exit(2);
}
const paths = pathspec.length ? pathspec : ['*.test.ts', '*.test.tsx'];

const git = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const show = (rev, file) => {
  try {
    return git(`git show ${rev}:${file}`);
  } catch {
    return null; // added or deleted at this revision
  }
};

const titleOf = (node) => {
  const first = node.arguments && node.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : '<dynamic>';
};

/** Every expect in one file, tagged with the test that encloses it. */
function assertionsIn(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  (function walk(node, context) {
    let inner = context;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `describe(...)`, `it.each(...)(...)`, `expect.objectContaining(...)` —
      // take the leading identifier in each case.
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          ? callee.expression.text
          : null;
      if (name === 'describe' || name === 'it' || name === 'test') {
        inner = context.concat(titleOf(node));
      }
      if (name === 'expect') {
        const kind = ts.isIdentifier(callee) ? 'assertion' : 'matcher';
        found.push({ kind, key: `${file} :: ${context.join(' > ')}` });
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner));
  })(sourceFile, []);
  return found;
}

const files = git(`git diff --name-only ${before} ${after} -- ${paths.map((p) => `'${p}'`).join(' ')}`)
  .trim().split('\n').filter(Boolean);

if (!files.length) {
  console.log('no test files changed between those revisions — nothing to compare');
  process.exit(0);
}

const gather = (rev) => {
  const out = [];
  for (const file of files) {
    const source = show(rev, file);
    if (source !== null) out.push(...assertionsIn(source, file));
  }
  return out;
};

const from = gather(before);
const to = gather(after);
const only = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.key);
const tally = (keys) => keys.reduce((acc, k) => ((acc[k] = (acc[k] || 0) + 1), acc), {});

const fromAssertions = tally(only(from, 'assertion'));
const toAssertions = tally(only(to, 'assertion'));
const contexts = [...new Set([...Object.keys(fromAssertions), ...Object.keys(toAssertions)])].sort();
const drift = contexts.filter((c) => (fromAssertions[c] || 0) !== (toAssertions[c] || 0));

const count = (rows, kind) => only(rows, kind).length;
console.log(`comparing ${before} -> ${after}`);
console.log(`  test files changed : ${files.length}`);
console.log(`  assertions before  : ${count(from, 'assertion')}`);
console.log(`  assertions after   : ${count(to, 'assertion')}`);
console.log(`  matcher helpers    : ${count(from, 'matcher')} -> ${count(to, 'matcher')}`);
console.log(`  contexts drifted   : ${drift.length}`);

for (const context of drift) {
  console.log(`\n  ${fromAssertions[context] || 0} -> ${toAssertions[context] || 0}`);
  console.log(`    ${context}`);
}

if (drift.length) {
  console.log('\nDRIFT: the contexts above gained or lost assertions. Intended, or an accident of the refactor?');
  process.exit(1);
}
console.log('\nOK: every assertion survived, in the same test context.');
