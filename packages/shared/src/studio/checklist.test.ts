/**
 * The studio checklist (task c3b34be8): one list of what a worktree must
 * carry before a session in it has its tools, identity and hooks, read by
 * `ink init` (what to write), `ink doctor` (what to print) and the server's
 * pre-spawn check. These pin that every item is judged on the file that
 * actually carries it, that a linked worktree needs its studio id while the
 * main worktree does not, and that a complete studio reads as complete.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { auditStudio, STUDIO_CHECK_IDS } from './checklist';
import { syncMcpConfig } from './mcp-config-sync';

const INK = 'node /repo/packages/cli/dist/cli.js';
const claudeHooks = () => ({
  PreCompact: [
    {
      hooks: [
        {
          type: 'command',
          command: `${INK} hooks pre-compact --backend claude-code # ink-managed`,
        },
      ],
    },
  ],
  SessionStart: [
    {
      matcher: 'compact',
      hooks: [
        {
          type: 'command',
          command: `${INK} hooks post-compact --backend claude-code # ink-managed`,
        },
      ],
    },
    {
      matcher: 'startup',
      hooks: [
        {
          type: 'command',
          command: `${INK} hooks on-session-start --backend claude-code # ink-managed`,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      hooks: [
        {
          type: 'command',
          command: `${INK} hooks on-tool-approval --backend claude-code # ink-managed`,
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: `${INK} hooks on-prompt --backend claude-code # ink-managed` },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: `${INK} hooks on-stop --backend claude-code # ink-managed` },
      ],
    },
  ],
});
const geminiHooks = () => ({
  SessionStart: [
    {
      matcher: 'startup',
      hooks: [{ type: 'command', command: `${INK} hooks on-session-start --backend gemini` }],
    },
  ],
  BeforeAgent: [
    { hooks: [{ type: 'command', command: `${INK} hooks on-prompt --backend gemini` }] },
  ],
  AfterAgent: [{ hooks: [{ type: 'command', command: `${INK} hooks on-stop --backend gemini` }] }],
});
const codexToml = () =>
  [
    '# ink-managed:start mcp_servers',
    '[mcp_servers.inkwell]',
    'url = "http://localhost:3001/mcp"',
    'required = true',
    '# ink-managed:end mcp_servers',
    '',
    '# ink-managed:hooks:start',
    '[hooks]',
    `session_start = "${INK} hooks on-session-start --backend codex"`,
    `session_end = "${INK} hooks on-stop --backend codex"`,
    `user_prompt = "${INK} hooks on-prompt --backend codex"`,
    '# ink-managed:hooks:end',
    '',
  ].join('\n');

/** A studio carrying every item. */
async function completeStudio(root: string, opts: { studioId?: string } = {}) {
  await mkdir(path.join(root, '.ink'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.gemini'), { recursive: true });
  await writeFile(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } } })
  );
  await writeFile(path.join(root, '.env.local'), 'SUPABASE_URL=http://127.0.0.1:54321\n');
  await writeFile(
    path.join(root, '.ink', 'identity.json'),
    JSON.stringify({
      sbSlug: 'wren',
      studio: 'alpha',
      ...(opts.studioId ? { studioId: opts.studioId } : {}),
    })
  );
  await writeFile(
    path.join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: [] }, hooks: claudeHooks() })
  );
  await writeFile(path.join(root, '.codex', 'config.toml'), codexToml());
  await writeFile(
    path.join(root, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } },
      hooks: geminiHooks(),
    })
  );
}

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';

describe('auditStudio', () => {
  async function scratch() {
    return mkdtemp(path.join(tmpdir(), 'studio-checklist-'));
  }

  it('a complete linked studio passes every check, and the list names every id once', async () => {
    const root = await scratch();
    try {
      await completeStudio(root, { studioId: STUDIO_ID });
      const audit = auditStudio(root, { linked: true });
      expect(audit.complete).toBe(true);
      expect(audit.missing).toEqual([]);
      expect(audit.checks.map((c) => c.id)).toEqual([...STUDIO_CHECK_IDS]);
      expect(new Set(STUDIO_CHECK_IDS).size).toBe(STUDIO_CHECK_IDS.length);
      for (const check of audit.checks) expect(check.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an empty worktree fails every required check and names the repair for each', async () => {
    const root = await scratch();
    try {
      const audit = auditStudio(root, { linked: true });
      expect(audit.complete).toBe(false);
      const required = audit.checks.filter((c) => c.required);
      expect(required.length).toBeGreaterThan(0);
      for (const check of required) {
        expect(check.ok).toBe(false);
        expect(check.repair).toMatch(/ink init/);
      }
      expect(audit.missing).toEqual(required.map((c) => c.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('each item is judged on the file that carries it: removing one fails exactly that check', async () => {
    const cases: Array<{ id: string; break: (root: string) => Promise<void> }> = [
      {
        id: 'mcp-json',
        break: (r) =>
          writeFile(path.join(r, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } })),
      },
      { id: 'env-local', break: (r) => rm(path.join(r, '.env.local')) },
      {
        id: 'identity',
        break: (r) =>
          writeFile(
            path.join(r, '.ink', 'identity.json'),
            JSON.stringify({ studio: 'x', studioId: STUDIO_ID })
          ),
      },
      {
        id: 'studio-id',
        break: (r) =>
          writeFile(
            path.join(r, '.ink', 'identity.json'),
            JSON.stringify({ sbSlug: 'wren', studioId: 'main' })
          ),
      },
      {
        id: 'claude-permissions',
        break: (r) =>
          writeFile(
            path.join(r, '.claude', 'settings.local.json'),
            JSON.stringify({ permissions: { allow: [] }, hooks: claudeHooks() })
          ),
      },
      {
        id: 'claude-hooks',
        break: (r) =>
          writeFile(
            path.join(r, '.claude', 'settings.local.json'),
            JSON.stringify({
              permissions: { allow: ['Bash(*)'] },
              // on-stop missing: the one hook a lease boundary cannot do without
              hooks: { ...claudeHooks(), Stop: [] },
            })
          ),
      },
      {
        id: 'codex-mcp',
        break: (r) =>
          writeFile(
            path.join(r, '.codex', 'config.toml'),
            codexToml().replace('[mcp_servers.inkwell]', '[mcp_servers.other]')
          ),
      },
      {
        id: 'codex-hooks',
        break: (r) =>
          writeFile(
            path.join(r, '.codex', 'config.toml'),
            codexToml().replace(/^user_prompt = .*$/m, '')
          ),
      },
      {
        id: 'gemini-mcp',
        break: (r) =>
          writeFile(
            path.join(r, '.gemini', 'settings.json'),
            JSON.stringify({ mcpServers: {}, hooks: geminiHooks() })
          ),
      },
      {
        id: 'gemini-hooks',
        break: (r) =>
          writeFile(
            path.join(r, '.gemini', 'settings.json'),
            JSON.stringify({
              mcpServers: { inkwell: {} },
              hooks: { SessionStart: geminiHooks().SessionStart },
            })
          ),
      },
    ];
    expect(cases.map((c) => c.id).sort()).toEqual([...STUDIO_CHECK_IDS].sort());
    for (const c of cases) {
      const root = await scratch();
      try {
        await completeStudio(root, { studioId: STUDIO_ID });
        await c.break(root);
        const audit = auditStudio(root, { linked: true });
        const failed = audit.checks.filter((x) => !x.ok).map((x) => x.id);
        expect(failed, c.id).toEqual([c.id]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('the main worktree needs no identity file, no studio id and no default permissions; a linked one needs all three', async () => {
    const root = await scratch();
    try {
      await completeStudio(root);
      // No studioId, empty allow list: the main worktree is complete...
      await writeFile(
        path.join(root, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: claudeHooks() })
      );
      await rm(path.join(root, '.ink', 'identity.json'));
      const main = auditStudio(root, { linked: false });
      expect(main.complete).toBe(true);
      expect(main.checks.find((c) => c.id === 'identity')?.required).toBe(false);
      expect(main.checks.find((c) => c.id === 'studio-id')?.required).toBe(false);
      expect(main.checks.find((c) => c.id === 'claude-permissions')?.required).toBe(false);
      // ...and the same files in a linked worktree are not.
      const linked = auditStudio(root, { linked: true });
      expect(linked.complete).toBe(false);
      expect(linked.missing).toEqual(['identity', 'studio-id', 'claude-permissions']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('.env.local is reported, never required: a repo may have none', async () => {
    const root = await scratch();
    try {
      await completeStudio(root, { studioId: STUDIO_ID });
      await rm(path.join(root, '.env.local'));
      const audit = auditStudio(root, { linked: true });
      const env = audit.checks.find((c) => c.id === 'env-local');
      expect(env?.ok).toBe(false);
      expect(env?.required).toBe(false);
      expect(audit.complete).toBe(true);
      expect(audit.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a pre-rename identity file (agentId, no sbSlug) still counts as an identity', async () => {
    const root = await scratch();
    try {
      await completeStudio(root, { studioId: STUDIO_ID });
      await writeFile(
        path.join(root, '.ink', 'identity.json'),
        JSON.stringify({ agentId: 'wren', studioId: STUDIO_ID })
      );
      const audit = auditStudio(root, { linked: true });
      expect(audit.checks.find((c) => c.id === 'identity')?.ok).toBe(true);
      expect(audit.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an unparseable file fails its checks without throwing', async () => {
    const root = await scratch();
    try {
      await completeStudio(root, { studioId: STUDIO_ID });
      await writeFile(path.join(root, '.mcp.json'), '{not json');
      await writeFile(path.join(root, '.claude', 'settings.local.json'), '{not json');
      const audit = auditStudio(root, { linked: true });
      expect(audit.missing).toEqual(['mcp-json', 'claude-permissions', 'claude-hooks']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A table declared twice is a parse error: Codex refused every spawn in
  // lumen-alpha on 2026-09-29 (#701), while this check called it complete.
  it('fails the Codex check on a table declared twice, until one sync repairs it', async () => {
    const root = await scratch();
    try {
      await completeStudio(root, { studioId: STUDIO_ID });
      await writeFile(
        path.join(root, '.codex', 'config.toml'),
        `${codexToml()}\n[mcp_servers.inkwell]\nurl = "http://localhost:3001/mcp"\n`
      );
      const broken = auditStudio(root, { linked: true });
      expect(broken.missing).toEqual(['codex-mcp']);
      expect(broken.checks.find((c) => c.id === 'codex-mcp')?.detail).toContain(
        '[mcp_servers.inkwell] more than once'
      );

      syncMcpConfig(root);

      expect(auditStudio(root, { linked: true }).complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
