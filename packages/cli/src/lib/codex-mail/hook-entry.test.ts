/** Actual built CLI entry points, isolated before imports/spawn. Any regression
 * can reach only this synthetic loopback API; never a real account or server. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const dirs: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('guarded hook CLI entry points', () => {
  it.each(['server', 'plain', 'parent'])(
    'leaves %s lifecycle and intake entirely to its existing owner',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'ink-hook-entry-'));
      dirs.push(root);
      const home = join(root, 'home'),
        cwd = join(root, 'work');
      mkdirSync(join(home, '.ink'), { recursive: true });
      mkdirSync(join(cwd, '.ink'), { recursive: true });
      const context = {
        sessionId: '00000000-0000-4000-8000-000000000001',
        studioId: '00000000-0000-4000-8000-000000000002',
        sbSlug: 'fixture',
        runtime: 'codex',
        cliAttached: mode !== 'server',
      };
      writeFileSync(
        join(home, '.ink', 'config.json'),
        JSON.stringify({ email: 'fixture@example.com' })
      );
      writeFileSync(
        join(cwd, '.ink', 'identity.json'),
        JSON.stringify({ sbSlug: 'fixture', studioId: context.studioId })
      );
      const calls: string[] = [];
      const server = createServer((req, res) => {
        calls.push(req.url || '');
        req.resume();
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"success":false}');
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture address');
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        TMPDIR: root,
        INK_SERVER_URL: `http://127.0.0.1:${address.port}`,
        INK_ACCESS_TOKEN: 'synthetic-fixture-token',
        INK_SESSION_ID: context.sessionId,
        INK_STUDIO_ID: context.studioId,
        SB_SLUG: context.sbSlug,
        INK_CONTEXT: Buffer.from(JSON.stringify(context)).toString('base64url'),
        ...(mode !== 'plain' ? { INK_CODEX_INKMAIL: '1' } : {}),
        ...(mode === 'parent' ? { INK_TURN_OWNER: 'parent' } : {}),
      };
      for (const hook of ['on-session-start', 'on-prompt', 'on-stop']) {
        const { stdout, stderr } = await run(
          process.execPath,
          [cli, 'hooks', hook, '--backend', 'codex', '--codex-inkmail-only'],
          { env, cwd, timeout: 12000 }
        );
        expect(stdout).toBe('');
        expect(stderr).toBe('');
      }
      expect(calls).toEqual([]);
      expect(readdirSync(join(cwd, '.ink'))).toEqual(['identity.json']);
      expect(readdirSync(join(home, '.ink')).sort()).toEqual(['config.json', 'logs']);
      const logs = readFileSync(join(home, '.ink', 'logs', 'hooks.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(logs.map((row) => row.event)).toEqual(Array(3).fill('codex_inkmail_hook_skipped'));
      expect(logs.map((row) => row.hook)).toEqual(['on-session-start', 'on-prompt', 'on-stop']);
    },
    45000
  );
});
