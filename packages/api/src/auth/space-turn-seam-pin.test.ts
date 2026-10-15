/**
 * Exactly one seam admits a space-turn token: the MCP endpoint, where the
 * tool allowlist applies (ink://specs/inkling-multi-person-groups). Every
 * other route is closed by verifyAccessToken's default. This pin keeps it
 * that way: a second opt-in anywhere in the server source fails here, in
 * review, instead of opening a route to a shared conversation's token.
 *
 * It counts the option's name, not one spelling of it. A shorthand
 * `{ allowSpaceTurn }` or a computed `allowSpaceTurn: isMcp` opens a seam as
 * surely as the literal does, so any mention outside the provider that
 * defines the option counts as an opt-in.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const DEFINED_IN = join('mcp', 'auth', 'ink-auth-provider.ts');
const OPTION = /\ballowSpaceTurn\b/g;
const LITERAL_OPT_IN = /allowSpaceTurn\s*:\s*true\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) return [];
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe('the space-turn opt-in', () => {
  it('is named exactly once outside its definition, at the MCP endpoint', () => {
    const files = sourceFiles(SRC);
    // The scan is over the real tree, not an empty directory.
    expect(files.length).toBeGreaterThan(200);
    const hits = files.flatMap((file) => {
      const path = relative(SRC, file);
      if (path === DEFINED_IN) return [];
      const count = readFileSync(file, 'utf8').match(OPTION)?.length ?? 0;
      return count ? [{ file: path, count }] : [];
    });
    expect(hits).toEqual([{ file: join('mcp', 'server.ts'), count: 1 }]);
  });

  it('is the literal opt-in there, not a value computed at the call', () => {
    const server = readFileSync(join(SRC, 'mcp', 'server.ts'), 'utf8');
    expect(server.match(LITERAL_OPT_IN)?.length ?? 0).toBe(1);
  });
});
