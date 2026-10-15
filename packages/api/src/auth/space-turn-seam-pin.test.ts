/**
 * Exactly one seam admits a space-turn token: the MCP endpoint, where the
 * tool allowlist applies (ink://specs/inkling-multi-person-groups). Every
 * other route is closed by verifyAccessToken's default. This pin keeps it
 * that way: a second opt-in anywhere in the server source fails here, in
 * review, instead of opening a route to a shared conversation's token.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const OPT_IN = /allowSpaceTurn\s*:\s*true/g;

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
  it('appears exactly once in the server source, at the MCP endpoint', () => {
    const files = sourceFiles(SRC);
    // The scan is over the real tree, not an empty directory.
    expect(files.length).toBeGreaterThan(200);
    const hits = files.flatMap((file) => {
      const count = readFileSync(file, 'utf8').match(OPT_IN)?.length ?? 0;
      return count ? [{ file: relative(SRC, file), count }] : [];
    });
    expect(hits).toEqual([{ file: join('mcp', 'server.ts'), count: 1 }]);
  });
});
