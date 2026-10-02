/**
 * The dry-run runner: what counts as evidence that a session held a
 * conversation, and where the private manifest may be written.
 *
 * Adapted from Lumen's review harness for PR #720: database reads are mocked
 * and every file lives in a temporary directory this test owns. Each case
 * failed against the first head (1645ce34).
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, chmod, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  written: false,
}));

vi.mock('../data/supabase/client', () => ({
  createSupabaseClient: () => ({
    from: (table: string) => {
      let rows = [...(harness.rows[table] ?? [])];
      const q = {
        select: () => q,
        order: () => q,
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((r) => values.includes(r[column]));
          return q;
        },
        not: (column: string, _operator: string, value: unknown) => {
          rows = rows.filter((r) => r[column] != value);
          return q;
        },
        range: async (start: number, end: number) => ({
          data: rows.slice(start, end + 1),
          error: null,
        }),
      };
      return q;
    },
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...args);
      harness.written = true;
    },
  };
});

let dir: string;
let out: string;
let errors: ReturnType<typeof vi.spyOn>;

const sessionRow = (patch: Record<string, unknown> = {}) => ({
  id: 'session-one',
  user_id: 'user-one',
  sb_id: 'sb-one',
  agent_id: 'example-agent',
  backend: 'codex-cli',
  backend_session_id: null,
  claude_session_id: null,
  alias: null,
  ended_at: '2026-09-01T00:00:00Z',
  lifecycle: 'completed',
  status: 'completed',
  message_count: 0,
  ...patch,
});

beforeEach(async () => {
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), 'session-archive-manifest-'));
  out = join(dir, 'manifest.json');
  vi.stubEnv('SESSION_ARCHIVE_MANIFEST_OUT', out);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.rows = {};
  harness.written = false;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Run the script; resolve once it has written the manifest or refused. */
async function run(): Promise<void> {
  // Setup writes go through the same mocked writeFile; only the script's count.
  harness.written = false;
  await import('./session-archive-manifest');
  await vi.waitFor(() => expect(harness.written || errors.mock.calls.length > 0).toBe(true));
}

async function manifest() {
  await run();
  return JSON.parse(await readFile(out, 'utf8'));
}

describe('session archive manifest runner', () => {
  describe('evidence that a session held a conversation', () => {
    it('a stopped interactive turn keeps a row out of `empty`', async () => {
      harness.rows.sessions = [sessionRow({ cli_turn_stopped_at: '2026-09-01T00:00:00Z' })];

      expect((await manifest()).archive).toEqual([
        { sessionId: 'session-one', reason: 'backfill' },
      ]);
    });

    it('a recorded tool call keeps a row out of `empty`', async () => {
      harness.rows.sessions = [sessionRow()];
      harness.rows.activity_stream = [
        { id: 'activity-one', session_id: 'session-one', type: 'tool_call' },
      ];

      expect((await manifest()).archive).toEqual([
        { sessionId: 'session-one', reason: 'backfill' },
      ]);
    });

    it('an authored thread message keeps a row out of `empty` and its pointer valid', async () => {
      harness.rows.sessions = [sessionRow()];
      harness.rows.agent_identities = [
        {
          id: 'sb-one',
          user_id: 'user-one',
          workspace_id: 'ws-one',
          agent_id: 'example-agent',
          backend: 'codex',
        },
      ];
      harness.rows.inbox_threads = [{ id: 'thread-one', workspace_id: 'ws-one' }];
      harness.rows.inbox_thread_messages = [
        {
          id: 'message-one',
          thread_id: 'thread-one',
          sender_sb_id: 'sb-one',
          created_at: '2026-09-01T00:00:00Z',
          sender_session: 'session-one',
        },
      ];

      expect((await manifest()).preserved).toEqual([
        { sessionId: 'session-one', references: ['latest-sender'] },
      ]);
    });

    it('a row with a zero counter and no evidence is still not proven empty', async () => {
      // No historical row carries trusted loser provenance, and an old activity
      // row from another session proves nothing about this one.
      harness.rows.sessions = [sessionRow({ started_at: '2026-09-01T00:00:00Z' })];
      harness.rows.activity_stream = [
        {
          id: 'activity-other',
          session_id: 'session-other',
          type: 'agent_spawn',
          created_at: '2026-02-03T00:00:00Z',
        },
      ];

      expect((await manifest()).archive).toEqual([
        { sessionId: 'session-one', reason: 'backfill' },
      ]);
    });
  });

  describe('private output', () => {
    it('replaces an existing 0644 file with a 0600 one', async () => {
      await writeFile(out, 'synthetic prior output');
      await chmod(out, 0o644);

      await manifest();

      expect((await stat(out)).mode & 0o777).toBe(0o600);
    });

    it('refuses to write through a symlink and leaves its target untouched', async () => {
      const target = join(dir, 'unrelated.json');
      await writeFile(target, 'synthetic unrelated file');
      await symlink(target, out);

      await run();

      expect(errors).toHaveBeenCalledWith(expect.stringContaining('symlink'));
      expect(process.exitCode).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('synthetic unrelated file');
    });

    it('refuses to write inside a git checkout', async () => {
      await mkdir(join(dir, '.git'));
      vi.stubEnv('SESSION_ARCHIVE_MANIFEST_OUT', join(dir, 'nested', 'manifest.json'));

      await run();

      expect(errors).toHaveBeenCalledWith(expect.stringContaining('git checkout'));
      expect(harness.written).toBe(false);
    });
  });
});

describe('session archive manifest runner: physical destination (review round 2)', () => {
  it('refuses a parent symlink that leads into a checkout subdirectory', async () => {
    const repo = join(dir, 'checkout');
    const nested = join(repo, 'nested');
    const link = join(dir, 'outside-link');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(nested);
    await symlink(nested, link);
    vi.stubEnv('SESSION_ARCHIVE_MANIFEST_OUT', join(link, 'manifest.json'));

    await run();

    expect(await stat(join(nested, 'manifest.json')).catch(() => null)).toBeNull();
    expect(harness.written).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('session archive manifest runner: positive usage evidence (review round 3)', () => {
  it('recorded token usage keeps a row out of `empty`', async () => {
    harness.rows.sessions = [sessionRow({ started_at: '2026-09-01T00:00:00Z', token_count: 42 })];
    // An unrelated older event, which an earlier head mistook for coverage.
    harness.rows.activity_stream = [
      {
        id: 'unrelated-event',
        session_id: 'unrelated-session',
        type: 'agent_spawn',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    expect((await manifest()).archive).toEqual([{ sessionId: 'session-one', reason: 'backfill' }]);
  });
});
