import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// This is a fixture audit, not a shell security filter. Any new executor
// command must be explicitly reviewed for harmlessness even if guards fail.
const HARMLESS_COMMANDS = new Set([
  'echo hello',
  'ls',
  'cat hello.txt',
  'pwd',
  'echo harmless',
  'echo guarded-hello',
  'echo unguarded',
]);

function unsafeExecutorLines(source: string): number[] {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const unsafe: number[] = [];
  const reject = (node: ts.Node) =>
    unsafe.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'execute'
    ) {
      const input = node.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input)) {
        reject(node);
      } else {
        for (const property of input.properties) {
          if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
            reject(property);
          } else if (property.name.getText(file).replace(/['"]/g, '') === 'command') {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isStringLiteral(property.initializer) ||
              !HARMLESS_COMMANDS.has(property.initializer.text)
            )
              reject(property);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return unsafe;
}

describe('Pi adapter executor fixture safety', () => {
  it('sends only explicitly reviewed harmless literals to real executors', () => {
    // Optional path supports read-only negative audits of a pre-fix blob.
    // The source is parsed as text, NEVER imported or executed.
    const source =
      process.env.INK_EXECUTOR_FIXTURE_SOURCE ||
      new URL('./pi-coding-tools.test.ts', import.meta.url);
    expect(unsafeExecutorLines(readFileSync(source, 'utf8'))).toEqual([]);
  });

  it.each([
    'tool.execute({ command: "synthetic-unreviewed" })',
    'tool.execute({ command: variable })',
    'tool.execute({ command })',
    'tool.execute({ ...params })',
    'tool.execute(params)',
    'tool.execute({ [name]: value })',
  ])('rejects an unreviewed or dynamic executor fixture without executing it', (source) => {
    expect(unsafeExecutorLines(source)).toHaveLength(1);
  });

  it('accepts reviewed harmless commands and non-command tool inputs', () => {
    expect(
      unsafeExecutorLines(
        'tool.execute({ command: "echo harmless" }); tool.execute({path: "hello.txt"})'
      )
    ).toEqual([]);
  });
});
