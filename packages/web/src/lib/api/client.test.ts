import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The workspace scope header has to be spelled the same on both sides, and
 * nothing enforced that. 01b9047b moved the server to `x-ink-workspace-id` and
 * left this client sending `X-PCP-Workspace-Id`, so from then until #655 every
 * workspace the user picked in the sidebar was dropped on the floor: the header
 * arrived, no handler looked for it, and the request quietly resolved to the
 * personal workspace instead. No test failed, because no test knew the two
 * spellings were supposed to match.
 *
 * `packages/web` does not depend on `@inklabs/shared`, so the honest fix — one
 * exported constant — is not available without pulling that dependency into the
 * Next.js build. Until then, read both sides and make them agree here. HTTP
 * header names are case-insensitive on the wire, so the comparison is too; what
 * broke was the name itself, not its casing.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

/** Header names passed to `req.header('…')` next to a workspace-scope read. */
function serverWorkspaceHeaders(source: string): string[] {
  const found = new Set<string>();
  const pattern = /req\.header\(\s*['"]([^'"]*workspace[^'"]*)['"]\s*\)/gi;
  for (const match of source.matchAll(pattern)) found.add(match[1].toLowerCase());
  return [...found];
}

describe('workspace scope header', () => {
  const clientSource = read('packages/web/src/lib/api/client.ts');

  const clientHeaders = [
    ...clientSource.matchAll(/config\.headers\[\s*['"]([^'"]+)['"]\s*\]\s*=/g),
  ].map((match) => match[1].toLowerCase());

  it('the client sets exactly one workspace header', () => {
    const workspaceHeaders = clientHeaders.filter((name) => name.includes('workspace'));
    expect(workspaceHeaders).toHaveLength(1);
  });

  it('is the header the API server actually reads', () => {
    const sent = clientHeaders.find((name) => name.includes('workspace'));
    const serverReads = [
      ...serverWorkspaceHeaders(read('packages/api/src/mcp/server.ts')),
      ...serverWorkspaceHeaders(read('packages/api/src/routes/admin.ts')),
    ];

    expect(serverReads.length).toBeGreaterThan(0);
    expect(
      serverReads,
      `packages/web sends "${sent}" but the API server reads ${JSON.stringify(serverReads)}. ` +
        'A workspace header nobody reads is dropped silently — the request falls back ' +
        'to the personal workspace and nothing reports an error. Make them match.'
    ).toContain(sent);
  });

  it('every server read agrees on one spelling', () => {
    const serverReads = new Set([
      ...serverWorkspaceHeaders(read('packages/api/src/mcp/server.ts')),
      ...serverWorkspaceHeaders(read('packages/api/src/routes/admin.ts')),
    ]);
    expect([...serverReads]).toHaveLength(1);
  });
});
