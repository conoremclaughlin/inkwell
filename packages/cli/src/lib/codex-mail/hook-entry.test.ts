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
import { modernCodexMailHooks } from './hooks.js';
import { capturedSubagentHooks } from './fixtures/subagent-hooks.js';

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
  it('registers only the root events, never SubagentStart or SubagentStop', () => {
    const legacy =
      '# ink-managed:hooks:start\n[hooks]\nsession_start = "ink hooks on-session-start --backend codex"\nsession_end = "ink hooks on-stop --backend codex"\nuser_prompt = "ink hooks on-prompt --backend codex"\n# ink-managed:hooks:end';
    const generated = modernCodexMailHooks(legacy, "'node' 'fixture-cli'");
    expect([...generated.content.matchAll(/^\[\[hooks\.(\w+)\]\]$/gm)].map((m) => m[1])).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(generated.hooks.map((h) => h.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
  });
  it.each(
    ['server', 'plain', 'parent', 'nested', 'subagent-replay', 'prebind', 'bridge'].flatMap(
      (mode) => ['on-session-start', 'on-prompt', 'on-stop'].map((hook) => [mode, hook])
    )
  )(
    '%s context: %s admits only the exact bound bridge thread',
    async (mode, hook) => {
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
      const bindingPath = join(root, 'binding.json');
      if (mode !== 'prebind')
        writeFileSync(
          bindingPath,
          JSON.stringify({
            version: 1,
            sessionId: context.sessionId,
            studioId: context.studioId,
            sbSlug: context.sbSlug,
            threadId: 'parent-thread',
            ownerPid: process.pid,
          }),
          { mode: 0o600 }
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
        INK_CODEX_INKMAIL_BINDING: bindingPath,
        INK_CONTEXT: Buffer.from(JSON.stringify(context)).toString('base64url'),
        ...(mode !== 'plain' ? { INK_CODEX_INKMAIL: '1' } : {}),
        ...(mode === 'parent' ? { INK_TURN_OWNER: 'parent' } : {}),
      };
      const running = run(
        process.execPath,
        [cli, 'hooks', hook, '--backend', 'codex', '--codex-inkmail-only'],
        { env, cwd, timeout: 12000 }
      );
      running.child.stdin?.end(
        JSON.stringify({
          session_id: mode === 'nested' ? 'child-thread' : 'parent-thread',
          // Captured UserPromptSubmit is an actual child invocation. The
          // SubagentStart/Stop replays through root handlers are defensive;
          // the generated block above never registers those native events.
          ...(mode === 'subagent-replay'
            ? capturedSubagentHooks[hook as keyof typeof capturedSubagentHooks]
            : {}),
        })
      );
      const { stdout, stderr } = await running;
      if (mode === 'bridge') {
        // Positive control for EVERY handler; an always-skip guard must fail CI.
        expect(calls.length).toBeGreaterThan(0);
      } else {
        expect(stdout).toBe('');
        expect(stderr).toBe('');
        expect(calls).toEqual([]);
        expect(readdirSync(join(cwd, '.ink'))).toEqual(['identity.json']);
        expect(readdirSync(join(home, '.ink')).sort()).toEqual(['config.json', 'logs']);
      }
      const logs = readFileSync(join(home, '.ink', 'logs', 'hooks.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      if (mode === 'bridge') {
        expect(logs.some((row) => row.event === 'codex_inkmail_hook_skipped')).toBe(false);
        expect(logs.some((row) => row.event === hook.replaceAll('-', '_'))).toBe(true);
      } else {
        expect(logs.map((row) => row.event)).toEqual(['codex_inkmail_hook_skipped']);
        expect(logs[0].hook).toBe(hook);
      }
    },
    45000
  );
});
