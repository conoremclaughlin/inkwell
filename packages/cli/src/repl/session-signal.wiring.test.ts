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
        ts.isFunctionDeclaration(node) && node.name?.text === 'runChatSession'
    );
    expect(chat?.body).toBeDefined();
    const wrapper = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'runChat'
    );
    expect(wrapper?.body?.getText(ast)).toContain('await runChatSession(options,');
    expect(wrapper?.body?.getText(ast)).toMatch(/finally\s*\{[\s\S]*await disposeTools\?\.\(\)/);
    const declarations = chat!
      .body!.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations]);
    const binding = declarations.find((node) => node.name.getText(ast) === 'sessionSignal');
    expect(binding?.initializer?.getText(ast)).toBe('createSignalSink()');
    const parentCalls: ts.CallExpression[] = [];
    const headlessCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          node.expression.getText(ast) === 'handleClientLocalTool' &&
          node.arguments[2]?.getText(ast) === 'ledger'
        )
          parentCalls.push(node);
        if (node.expression.getText(ast) === 'runHeadlessSession') headlessCalls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(chat!);
    expect(parentCalls).toHaveLength(1);
    expect(parentCalls[0]!.arguments[3]?.getText(ast)).toBe('sessionSignal');
    expect(headlessCalls).toHaveLength(1);
    const ports = headlessCalls[0]!.arguments[1]!;
    expect(ts.isObjectLiteralExpression(ports)).toBe(true);
    const signalProperty = (ports as ts.ObjectLiteralExpression).properties.find(
      (node) => node.name?.getText(ast) === 'sessionSignal'
    );
    expect(signalProperty && ts.isShorthandPropertyAssignment(signalProperty)).toBe(true);
    // The shared function, not a second CLI loop, owns reads/clears. Its tests
    // exercise stale-signal clearing and independence between concurrent runs.
    const shared = readFileSync(
      new URL('../../../shared/src/runtime/headless-session.ts', import.meta.url),
      'utf8'
    );
    expect(shared).toContain('ports.sessionSignal.clear()');
    expect(shared).toContain('ports.sessionSignal.get()');
    expect(source).not.toMatch(/\b(?:globalSignalSink|getLastSignal|clearLastSignal)\b/);
  });
});
