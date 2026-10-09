/**
 * Opt-in real-model acceptance, never part of unit/DB CI. Prepare an isolated
 * allowlisted Echo server first; this suite neither starts nor resets a server.
 * INK_LIVE_TESTS=1 and INK_RUNTIME_ACCEPTANCE_ROOT name a private fixture root:
 *   env.json: the isolated server's explicit env (including provider auth)
 *   fixture.json: { cliSessionId, cliToken, browserToken }
 *   cwd/, home/, tmp/: owned directories beneath that root
 * INK_RUNTIME_ACCEPTANCE_CLI names this checkout's built cli.js.
 * The server must route Echo to that pre-created session, on the hosted runner.
 * Keep credentials outside the repo, mode 0600. Use a disposable managed DB.
 * Run only this file through packages/api/vitest.live.config.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, readdir, realpath, rm } from 'fs/promises';
import { isAbsolute, join, relative } from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createClient } from '@supabase/supabase-js';

const exec = promisify(execFile);
const enabled = process.env.INK_LIVE_TESTS === '1' && !!process.env.INK_RUNTIME_ACCEPTANCE_ROOT;
type Entry = Record<string, unknown>;
function required(record: Entry, key: string): string {
  if (typeof record[key] !== 'string' || !record[key]) throw new Error(`Missing fixture ${key}`);
  return record[key];
}
function privateLoopback(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.port ||
    ['3001', '54321', '5432'].includes(url.port) ||
    url.username ||
    url.password
  )
    throw new Error('Live acceptance requires an explicit non-default loopback port');
  return url;
}
function parseEntries(text: string): Entry[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Entry);
}
function parseFrames(text: string): Entry[] {
  return text
    .split('\n\n')
    .slice(0, -1)
    .flatMap((block) => {
      const data = block.split('\n').find((line) => line.startsWith('data:'));
      if (!data) return [];
      const entry = JSON.parse(data.slice(5)) as Entry;
      return typeof entry.eid === 'number' ? [entry] : [];
    });
}

describe.skipIf(!enabled)('real hosted Ink and CLI continuity', () => {
  it('reads through both hosts, mirrors one ledger to two readers, and replays an exclusive cursor', async () => {
    const root = await realpath(process.env.INK_RUNTIME_ACCEPTANCE_ROOT!);
    const env = JSON.parse(await readFile(join(root, 'env.json'), 'utf8')) as Entry;
    const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')) as Entry;
    const server = privateLoopback(required(env, 'INK_SERVER_URL')).origin;
    privateLoopback(required(env, 'SUPABASE_URL'));
    const sessionId = required(fixture, 'cliSessionId');
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Invalid fixture session');
    const db = createClient(required(env, 'SUPABASE_URL'), required(env, 'SUPABASE_SECRET_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const launches = async () => {
      const { data, error } = await db
        .from('launched_processes')
        .select('id, backend, pid, exited_at')
        .eq('session_id', sessionId);
      if (error) throw new Error('Could not read isolated launch evidence');
      return data;
    };
    const priorLaunches = new Set((await launches()).map((row) => row.id));
    for (const name of ['home', 'cwd', 'tmp']) {
      const path = await realpath(join(root, name));
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unowned fixture path');
    }
    if ((await realpath(required(env, 'HOME'))) !== (await realpath(join(root, 'home'))))
      throw new Error('Fixture HOME is not owned');
    const cli = process.env.INK_RUNTIME_ACCEPTANCE_CLI;
    if (!cli || !isAbsolute(cli)) throw new Error('Name the built CLI explicitly');
    const cwd = join(root, 'cwd');
    const directory = join(cwd, '.ink', 'runtime', 'repl');
    const ledger = async () => {
      const files = (await readdir(directory)).filter(
        (name) =>
          name.startsWith(`${sessionId}-`) && name.endsWith('.jsonl') && !name.includes('.clone-')
      );
      if (files.length !== 1) throw new Error('Expected the one pre-created session ledger');
      return parseEntries(await readFile(join(directory, files[0]!), 'utf8'));
    };
    const cursor = Math.max(0, ...(await ledger()).map((e) => Number(e.eid) || 0));
    const filename = `acceptance-${randomUUID()}.txt`;
    const path = join(cwd, filename);
    let created = false;
    const nonce = randomUUID();
    const stop = new AbortController();
    const streams: Array<{ done: Promise<void>; text: string }> = [];
    const observerUrl = (after: number, follow = true) =>
      `${server}/api/sessions/${sessionId}/events?channel=obs&afterEid=${after}&follow=${follow}`;
    const headers = { Authorization: `Bearer ${required(fixture, 'cliToken')}` };
    try {
      await writeFile(path, `HOSTED-${nonce}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
      for (let i = 0; i < 2; i++) {
        const response = await fetch(observerUrl(cursor), { headers, signal: stop.signal });
        expect(response.status).toBe(200);
        const stream = { text: '', done: Promise.resolve() };
        stream.done = (async () => {
          const decoder = new TextDecoder();
          try {
            for await (const bytes of response.body!) {
              stream.text += decoder.decode(bytes, { stream: true });
              if (stream.text.length > 1024 * 1024) throw new Error('Fixture stream too large');
            }
          } catch (error) {
            if (!stop.signal.aborted) throw error;
          }
        })();
        void stream.done.catch(() => {}); // observed below even if HTTP fails first
        streams.push(stream);
      }
      const response = await fetch(`${server}/api/chat/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${required(fixture, 'browserToken')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sbSlug: 'echo',
          content: `Acceptance: use Ink's read tool to read ${filename}, then reply with exactly its contents. Do not guess, change files or contact anyone.`,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as Entry;
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionId);
      expect(result.response).toBe(`HOSTED-${nonce}`);
      const recorded = (await launches()).filter((row) => !priorLaunches.has(row.id));
      // Without this the old child-ink runner could pass the same chat assertions.
      // Hosted execution records each physical provider; the outer reservation
      // has no PID because no separate Ink process was launched.
      const providers = recorded.filter((row) => row.backend === 'claude-code');
      expect(providers.length).toBeGreaterThanOrEqual(2);
      expect(providers.every((row) => row.pid > 0 && row.exited_at !== null)).toBe(true);
      expect(recorded.filter((row) => row.backend === 'ink').every((row) => row.pid === null)).toBe(
        true
      );
      await expect
        .poll(
          () =>
            streams.every((s) =>
              parseFrames(s.text).some(
                (e) => e.type === 'assistant' && e.content === `HOSTED-${nonce}`
              )
            ),
          { timeout: 5000 }
        )
        .toBe(true);
      stop.abort();
      await Promise.all(streams.map((s) => s.done));
      const [a, b] = streams.map((s) => parseFrames(s.text));
      expect(a).toEqual(b);
      expect(a!.some((e) => e.type === 'local_tool_call')).toBe(true);
      expect(a!.some((e) => e.type === 'assistant' && e.content === `HOSTED-${nonce}`)).toBe(true);
      const nextCursor = Number(a![Math.floor(a!.length / 2)]!.eid);
      const replay = await fetch(observerUrl(nextCursor, false), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      expect(replay.status).toBe(200);
      expect(parseFrames(await replay.text())).toEqual(
        a!.filter((e) => Number(e.eid) > nextCursor)
      );

      await writeFile(path, `CLI-${nonce}\n`);
      const childEnv: NodeJS.ProcessEnv = {};
      for (const key of [
        'PATH',
        'HOME',
        'TMPDIR',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ])
        if (typeof env[key] === 'string') childEnv[key] = env[key];
      Object.assign(childEnv, {
        NODE_ENV: 'test',
        PI_OFFLINE: '1',
        INK_SERVER_URL: server,
        INK_ACCESS_TOKEN: required(fixture, 'cliToken'),
        INK_SESSION_ID: sessionId,
        SB_SLUG: 'echo',
      });
      const output = await exec(
        process.execPath,
        [
          cli,
          'chat',
          '--agent',
          'echo',
          '--backend',
          'claude',
          '--model',
          'sonnet',
          '--effort',
          'low',
          '--session-id',
          sessionId,
          '--non-interactive',
          '--message',
          `Acceptance: ${filename} changed. Use Ink's read tool to read it again, then reply exactly with its contents. No file changes or messages.`,
          '--max-turns',
          '1',
          '--require-bootstrap',
          '--tool-routing',
          'local',
          '--profile',
          'safe',
          '--no-provider-tools',
          '--backend-timeout-seconds',
          '90',
          '--sb-strict-tools',
        ],
        { cwd, env: childEnv, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
      );
      expect(output.stdout).toContain(`CLI-${nonce}`);
      const entries = (await ledger()).filter((e) => Number(e.eid) > cursor);
      for (const marker of [`HOSTED-${nonce}`, `CLI-${nonce}`]) {
        const read = entries.find(
          (e) =>
            e.type === 'local_tool_call' &&
            e.tool === 'read' &&
            JSON.stringify(e.result).includes(marker)
        );
        expect(read).toBeDefined();
        const intent = entries.find(
          (e) => e.type === 'tool_intent' && e.invocationId === read!.invocationId
        );
        expect(Number(intent?.eid)).toBeLessThan(Number(read!.eid));
        expect(
          entries.some((e) => e.type === 'assistant' && e.success === true && e.content === marker)
        ).toBe(true);
      }
    } finally {
      stop.abort();
      await Promise.allSettled(streams.map((s) => s.done));
      if (created) await rm(path, { force: true });
    }
  }, 270_000);
});
