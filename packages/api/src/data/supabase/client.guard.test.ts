import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const FACTORY = path.join(SRC, 'data', 'supabase', 'client.ts');

/** Server source only: tests, test support and the test folder build their own fixtures. */
function serverSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(SRC, 'test') ? [] : serverSources(full);
    if (!entry.name.endsWith('.ts') || /\.(test|spec|test-support)\.ts$/.test(entry.name))
      return [];
    return [full];
  });
}

const VALUE_IMPORT =
  /import\s+(?!type\b)[^;]*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*['"]@supabase\/supabase-js['"]/;
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+\w+\s+from\s*['"]@supabase\/supabase-js['"]/;
const RUNTIME_IMPORT = /(?:require|import)\(\s*['"]@supabase\/supabase-js['"]\s*\)/;

/**
 * Every Supabase client this server makes goes through
 * createServerSupabaseClient, which turns token refresh off. A client made
 * with the library's defaults keeps a refresh timer alive forever, so one
 * created per request is never collected (thread
 * inkwell:debug:api-memory-growth).
 */
describe('Supabase clients in packages/api', () => {
  it('are made only by createServerSupabaseClient', () => {
    const offenders = serverSources(SRC)
      .filter((file) => file !== FACTORY)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          VALUE_IMPORT.test(source) || NAMESPACE_IMPORT.test(source) || RUNTIME_IMPORT.test(source)
        );
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('recognises each way of reaching createClient (control)', () => {
    expect(VALUE_IMPORT.test("import { createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(
      VALUE_IMPORT.test(
        "import { type SupabaseClient, createClient } from '@supabase/supabase-js';"
      )
    ).toBe(true);
    expect(VALUE_IMPORT.test("import type { SupabaseClient } from '@supabase/supabase-js';")).toBe(
      false
    );
    expect(NAMESPACE_IMPORT.test("import * as supabase from '@supabase/supabase-js';")).toBe(true);
    expect(RUNTIME_IMPORT.test("await import('@supabase/supabase-js')")).toBe(true);
    expect(RUNTIME_IMPORT.test("require('@supabase/supabase-js')")).toBe(true);
  });
});
