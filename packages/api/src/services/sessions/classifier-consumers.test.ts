/**
 * Every place the API decides a category, pinned.
 *
 * Two review rounds in a row found a consumer still re-deriving its verdict
 * from `result.error` — an excerpt, cut to a size chosen for a log field.
 * Round three wired four of them; round four found the queue flush and the
 * trigger retry still doing it (Lumen). Fixing the two that were named would
 * leave the next one to the round after, so this pins the whole set instead.
 *
 * It is an inventory, not a behaviour test: the behaviour lives in
 * `carried-classification.test.ts` and `trigger-retry-listener.test.ts`, which
 * assert what each consumer does differently because of the carried value.
 * What this adds is that a NEW call site cannot appear unnoticed — adding one
 * turns this red, and the fix is to decide, in review, whether the new site is
 * on the producer's path and must prefer a carried verdict.
 *
 * The producer itself lives in `@inklabs/shared` (`describeExitResult`) and is
 * out of this file's scope: it classifies the full readable output by
 * construction, which is the property the whole design rests on.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import ts from 'typescript';

const API_SRC = resolve(__dirname, '../..');

/**
 * Where `classifyError` is called in the API's shipping source, and why each
 * one is allowed to be there.
 *
 * ON THE PRODUCER'S PATH — these classify text that may be an excerpt, so each
 * prefers the verdict the runner carried and falls back only when none came:
 *
 *   session-service.ts        x2  the turn's own verdict (decides
 *                                 refusedBeforeAcceptance), and the queue
 *                                 flush (decides whether queued work is
 *                                 discarded)
 *   server.ts                 x1  the trigger:error listener (decides whether
 *                                 a retry is scheduled)
 *   heartbeat-escalation.ts   x1  the channel alert and the durable inbox copy
 *
 * A fallback is not a loophole: a spawn failure, an internal throw, or a
 * runner with no classification seam carries no verdict, and classifying the
 * text is the only thing left to do — and correct, because that text was
 * never cut.
 */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'server.ts': 1,
  'services/heartbeat-escalation.ts': 1,
  'services/sessions/session-service.ts': 2,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Count `classifyError(...)` CALLS — not imports, not mentions in comments. */
function countCalls(file: string): number {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('classifyError')) return 0;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let calls = 0;
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'classifyError') calls++;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return calls;
}

describe('the set of places that decide a category is the set we reviewed', () => {
  it('has no classifyError call site outside the reviewed inventory', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(API_SRC)) {
      const calls = countCalls(file);
      if (calls > 0) found[relative(API_SRC, file)] = calls;
    }

    // A plain equality, so both directions are caught: a NEW call site fails
    // (decide in review whether it is on the producer's path and must prefer
    // a carried verdict, then add it here), and a REMOVED one fails too
    // (delete its line, and check nothing lost a fallback it needed).
    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it('counts calls rather than mentions, so the inventory means what it says', () => {
    // The control. `countCalls` reading the word instead of the call would
    // make the inventory above pass for the wrong reason — session-service.ts
    // names classifyError in an import and in prose, and terminal-output.ts's
    // doc comments discuss it at length without calling it.
    const importAndProse = `
      import { classifyError } from '@inklabs/shared';
      // classifyError matches prose, which is why classifyError is not called here.
      /** See classifyError for the rules. */
      const unrelated = classifyErrorLike({ errorText: 'x' });
    `;
    const ast = ts.createSourceFile('probe.ts', importAndProse, ts.ScriptTarget.Latest, true);
    let calls = 0;
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'classifyError') calls++;
      ts.forEachChild(node, walk);
    };
    walk(ast);

    expect(calls).toBe(0);
    expect(importAndProse.split('classifyError').length - 1).toBeGreaterThan(3);
  });
});
