import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Inspect constructor calls, including aliases, namespaces and type arguments. */
function clientConstructorLines(text: string): number[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@supabase/supabase-js'
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'createClient') {
          factories.add(binding.name.text);
        }
      }
    }
  }

  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isFactory =
        (ts.isIdentifier(callee) && factories.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          callee.name.text === 'createClient');
      if (isFactory) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

describe('server Supabase construction policy', () => {
  it('finds default constructors, including generics and renamed imports', () => {
    expect(
      clientConstructorLines(`
      import { createClient as database } from '@supabase/supabase-js';
      database(url, key);
      database<Database>(url, key);
      database(url, key, { auth: { persistSession: false } });
    `)
    ).toHaveLength(3);
    expect(
      clientConstructorLines(`
      import * as supabase from '@supabase/supabase-js';
      supabase.createClient<Database>(url, key);
    `)
    ).toHaveLength(1);
  });

  it('routes API production constructors through the safe factory', async () => {
    const root = resolve(__dirname, '../..');
    const constructors: Record<string, number[]> = {};
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Standalone scripts and test infrastructure are not API request paths.
          if (entry.name !== 'scripts' && entry.name !== 'test') await scan(path);
        } else if (
          entry.name.endsWith('.ts') &&
          !/\.(test|spec|test-support|d)\.ts$/.test(entry.name)
        ) {
          const lines = clientConstructorLines(await readFile(path, 'utf8'));
          if (lines.length) constructors[relative(root, path)] = lines;
        }
      }
    }
    await scan(root);
    // A positive control in the scanned tree catches an empty or misrooted scan.
    expect(constructors).toEqual({ 'data/supabase/client.ts': [expect.any(Number)] });
  });
});
