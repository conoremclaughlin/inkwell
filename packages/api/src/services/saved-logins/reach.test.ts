/**
 * Who can reach a saved login. Only the admin routes (routes/admin-vault.ts,
 * mounted behind admin auth) use the stores, and nothing else in the server,
 * the CLI or the shared package names their tables, the decrypted view, the
 * function that writes a secret, Vault's own schema or the routes' address.
 * So no MCP tool, agent runner, integration or prompt builder reads them: an
 * agent's model context and transcript can't receive a saved login through
 * the code. This is the absence of a path, not isolation from an agent with
 * generic shell or database access on the same machine.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.resolve(__dirname, '../../../..');
// The server, and everything an agent runs: the CLI, the shared package, the
// InkMail channel plugin and the OpenClaw plugin. The phone app and the web
// dashboard are the person's own screens and may call the routes.
const ROOTS = ['api/src', 'cli/src', 'shared/src', 'channel-plugin', 'openclaw-plugin'].map(
  (root) => path.join(PACKAGES, root)
);

/** Where a saved login may be named. */
const ALLOWED = [
  'api/src/services/saved-logins/',
  'api/src/routes/admin-vault.ts',
  // Generated database types list every table, view and function.
  'api/src/data/supabase/types.ts',
  // A test double for the Vault store's database half.
  'api/src/test/fake-vault-db.ts',
];

/** Tests exercise the routes in-process; nothing at runtime runs them. */
const isTest = (relative: string) => /\.test\.tsx?$/.test(relative);

const NAMES = [
  'services/saved-logins',
  './saved-logins',
  'saved_logins',
  'saved_login_secrets',
  'saved_logins_opened',
  'create_saved_login_secret',
  'decrypted_secrets',
  'vault.secrets',
  'vault/logins',
  './admin-vault',
];

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`));
}

describe('who can reach a saved login', () => {
  it('only the admin routes name the stores, their tables or Vault', async () => {
    const files = (await Promise.all(ROOTS.map(sources))).flat();
    // The walk itself found the code: this would pass vacuously on an empty list.
    expect(files.length).toBeGreaterThan(500);
    for (const known of [
      path.join('routes', 'admin-vault.ts'),
      path.join('channel-plugin', 'index.ts'),
      path.join('openclaw-plugin', 'index.ts'),
    ]) {
      expect(files.some((file) => file.endsWith(known))).toBe(true);
    }
    const reached: string[] = [];
    for (const file of files) {
      const relative = path.relative(PACKAGES, file).split(path.sep).join('/');
      if (isTest(relative) || ALLOWED.some((allowed) => relative.startsWith(allowed))) continue;
      const text = await readFile(file, 'utf8');
      for (const name of NAMES) {
        // routes/admin.ts mounts the router; that is the one sanctioned import.
        if (relative === 'api/src/routes/admin.ts' && name === './admin-vault') continue;
        if (text.includes(name)) reached.push(`${relative}: ${name}`);
      }
    }
    expect(reached).toEqual([]);
  });

  it('the routes are mounted only behind admin auth', async () => {
    const admin = await readFile(path.join(PACKAGES, 'api/src/routes/admin.ts'), 'utf8');
    const auth = admin.indexOf('router.use(adminAuthMiddleware);');
    const mount = admin.indexOf("router.use('/vault', vaultRouter);");
    expect(auth).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(auth);
    expect(admin.split("'/vault'").length - 1).toBe(1);
  });
});
