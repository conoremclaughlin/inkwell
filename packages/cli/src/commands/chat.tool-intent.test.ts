import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { ContextLedger } from '../repl/context-ledger.js';
import { hydrateLedgerFromTranscript } from './chat.js';

describe('chat tool-intent boundary', () => {
  it('does not hydrate an intent into model context, display replay or tool receipts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ink-intent-hydrate-'));
    try {
      const path = join(dir, 'fixture.jsonl');
      writeFileSync(
        path,
        JSON.stringify({
          type: 'tool_intent',
          eid: 31,
          invocationId: 'fixture-invocation',
          tool: 'recall',
          args: { query: 'private fixture' },
          content: 'not model context',
        }) + '\n'
      );
      const ledger = new ContextLedger();
      const hydrated = hydrateLedgerFromTranscript(ledger, path);
      expect(ledger.listEntries()).toEqual([]);
      expect(hydrated.tailPreview).toEqual([]);
      expect(hydrated.toolCalls).toEqual([]);
      expect(hydrated.maxEid).toBe(31);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires both production executors to their own log and links every outcome branch', () => {
    // Structural guard over production call sites, not a claim to run chat's
    // real backends. Behavioral barrier/sink tests use fake tools separately.
    const cli = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8');
    expect(cli).toContain('const clones = createSessionClones({');
    expect(cli).toContain('createLog: (path) => new SessionLog({ path })');
    const source =
      cli +
      '\n' +
      readFileSync(
        new URL('../../../shared/src/node-host/session-clones.ts', import.meta.url),
        'utf8'
      );
    const tree = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true);
    const committers: string[] = [];
    const outcomes: string[] = [];
    const batchLogs: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'createSessionTools') {
        const options = node.arguments[0];
        expect(ts.isObjectLiteralExpression(options)).toBe(true);
        if (ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find((p) => p.name?.getText(tree) === 'log');
          expect(property && ts.isPropertyAssignment(property)).toBe(true);
          if (property && ts.isPropertyAssignment(property))
            batchLogs.push(property.initializer.getText(tree));
        }
      }
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'executeToolCalls') {
        const options = node.arguments[1];
        expect(ts.isObjectLiteralExpression(options)).toBe(true);
        if (ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find((p) => p.name?.getText(tree) === 'commitIntent');
          expect(property && ts.isPropertyAssignment(property)).toBe(true);
          if (property && ts.isPropertyAssignment(property))
            committers.push(property.initializer.getText(tree));
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'append'
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const fields = new Map(
            arg.properties
              .filter(ts.isPropertyAssignment)
              .map((p) => [p.name.getText(tree), p.initializer.getText(tree)])
          );
          if (["'local_tool_call'", "'clone_tool_call'"].includes(fields.get('type') ?? '')) {
            expect(fields.get('invocationId')).toBe('result.invocationId');
            expect(fields.get('dispatchState')).toBe('result.dispatchState');
            outcomes.push(fields.get('type')!);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(committers).toEqual(['createToolIntentCommitter(opts.log)']);
    expect(outcomes).toEqual(["'clone_tool_call'"]);
    expect(batchLogs).toHaveLength(1);
    expect(batchLogs[0]).toMatch(/append: \(entry\) => runtime\.log\.append\(entry\)/);
    expect(batchLogs[0]).toMatch(/flush: \(\) => runtime\.log\.flush\(\)/);
    const parent = readFileSync(
      new URL('../../../shared/src/runtime/session-tools.ts', import.meta.url),
      'utf8'
    );
    expect(parent).toContain('runSessionToolBatch(calls,');
    expect(parent).toContain('log: ports.log,');
    const shared = readFileSync(
      new URL('../../../shared/src/runtime/session-tool-batch.ts', import.meta.url),
      'utf8'
    );
    expect(shared).toContain('commitIntent: createToolIntentCommitter(ports.log)');
    expect(shared).toContain("type: 'local_tool_call'");
    expect(shared).toContain('invocationId: result.invocationId');
    expect(shared).toContain('dispatchState: result.dispatchState');
    expect(shared.match(/ports\.log\.append\(\{\s*\.\.\.common,/g)).toHaveLength(3);
  });
});
