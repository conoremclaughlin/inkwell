import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Structural complement to the shared runtime's concurrent loop tests. */
describe('production chat signal binding', () => {
  it('allocates a sink inside each runChat and uses it for parent dispatch and continuation', () => {
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true);
    const chat = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'runChat'
    );
    expect(chat?.body).toBeDefined();
    const declarations = chat!
      .body!.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations]);
    const binding = declarations.find((node) => node.name.getText(ast) === 'sessionSignal');
    expect(binding?.initializer?.getText(ast)).toBe('createSignalSink()');
    const parentCalls: ts.CallExpression[] = [];
    const statusReads: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          node.expression.getText(ast) === 'handleClientLocalTool' &&
          node.arguments[2]?.getText(ast) === 'ledger'
        )
          parentCalls.push(node);
        if (
          node.expression.getText(ast) === 'sessionSignal.get' ||
          node.expression.getText(ast) === 'sessionSignal.clear'
        )
          statusReads.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(chat!);
    expect(parentCalls).toHaveLength(1);
    expect(parentCalls[0]!.arguments[3]?.getText(ast)).toBe('sessionSignal');
    expect(
      statusReads.filter((call) => call.expression.getText(ast) === 'sessionSignal.get')
    ).toHaveLength(3);
    expect(
      statusReads.filter((call) => call.expression.getText(ast) === 'sessionSignal.clear')
    ).toHaveLength(2);
    expect(source).not.toMatch(/\b(?:globalSignalSink|getLastSignal|clearLastSignal)\b/);
  });
});
