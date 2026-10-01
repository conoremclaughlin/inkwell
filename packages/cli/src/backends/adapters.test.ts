import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { buildIdentityPrompt } from './identity.js';
import { createCliBackendHost } from './cli-host.js';
import { decodeContextToken } from '@inklabs/shared';

// These cases prepare as a launcher does: the CLI's own host, in the test
// process's directory, attached to its terminal.
const cliHost = createCliBackendHost();
const LAUNCHER_DEFAULTS = { cwd: process.cwd(), cliAttached: true };

describe('buildIdentityPrompt conditional bootstrap', () => {
  it('includes conditional self-healing instructions when no startup context is provided', () => {
    const prompt = buildIdentityPrompt('wren');

    expect(prompt).toContain('You are wren');
    // Should tell agent to check for existing docs first, not bootstrap unconditionally
    expect(prompt).toContain('check whether your constitution docs are already present');
    expect(prompt).toContain('If these are present');
    expect(prompt).toContain('do NOT call bootstrap again');
    expect(prompt).toContain('If these are NOT present');
    expect(prompt).toContain('call the `bootstrap` MCP tool manually');
    expect(prompt).not.toContain('Bootstrap has already been completed');
    // Should NOT unconditionally instruct bootstrap
    expect(prompt).not.toContain('Skip directly to loading user config');
    // Should NOT have the actual startup context section
    expect(prompt).not.toContain('## Bootstrapped Startup Context (Inkwell)');
  });

  it('skips manual bootstrap when startup context is provided', () => {
    const prompt = buildIdentityPrompt('lumen', '### Identity\nI am Lumen.');

    expect(prompt).toContain('You are lumen');
    expect(prompt).toContain('Bootstrap has already been completed');
    expect(prompt).toContain('Do NOT call bootstrap again');
    expect(prompt).toContain('## Bootstrapped Startup Context (Inkwell)');
    expect(prompt).toContain('### Identity');
    expect(prompt).toContain('I am Lumen.');
    expect(prompt).not.toContain('check whether your constitution docs are already present');
  });
});

describe('backend adapters prompt transport declarations', () => {
  // Context budgeting depends on these (repl/context-limits.ts): stdin
  // transports may take the large 1M cap; argv transports MUST stay at the
  // ARG_MAX-safe 200K cap. Flipping one of these is a budget decision, not a
  // refactor — an adapter may only declare 'stdin' when its prepare() really
  // delivers the prompt via stdinData (Lumen, PR #477 review — finding 1).
  it('claude delivers the prompt via stdin', () => {
    expect(new ClaudeAdapter().promptTransport).toBe('stdin');
  });

  it('codex and gemini deliver the prompt via argv', () => {
    expect(new CodexAdapter().promptTransport).toBe('argv');
    expect(new GeminiAdapter().promptTransport).toBe('argv');
  });
});

describe('backend adapters session resume wiring', () => {
  it('passes claude backendSessionId through --resume', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        backendSessionId: 'claude-session-789',
      },
      cliHost
    );

    expect(prepared.args).toContain('--resume');
    expect(prepared.args).toContain('claude-session-789');
  });

  it('does not force claude --session-id from Inkwell session id', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'ink-session-123',
      },
      cliHost
    );

    expect(prepared.args).not.toContain('--session-id');
    expect(prepared.args).not.toContain('ink-session-123');
  });

  it('passes claude backendSessionSeedId through --session-id', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'ink-session-123',
        backendSessionSeedId: 'ink-session-123',
      },
      cliHost
    );

    const sessionIdFlagIndex = prepared.args.indexOf('--session-id');
    expect(sessionIdFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.args[sessionIdFlagIndex + 1]).toBe('ink-session-123');
  });

  it('passes backendSessionId through codex resume subcommand', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: ['continue', 'work'],
        passthroughArgs: [],
        backendSessionId: 'codex-session-123',
      },
      cliHost
    );

    try {
      expect(prepared.args).toContain('resume');
      expect(prepared.args).toContain('codex-session-123');
    } finally {
      prepared.cleanup();
    }
  });

  it('injects image media as parse-safe --image= flags terminated by --', async () => {
    // Variadic `-i <FILE>...` swallows the following positional prompt
    // (Lumen probe, codex 0.146.1, PR #463 review 4900120086). The
    // single-value `--image=` binding plus a `--` options terminator keeps
    // the prompt a positional under all parse rules.
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: ['exec', 'what is in this image?'],
        passthroughArgs: [],
        media: [
          { path: '/tmp/photo.png', mimeType: 'image/png' },
          { path: '/tmp/pic.jpg', mimeType: 'image/jpeg' },
          { path: '/tmp/doc.pdf', mimeType: 'application/pdf' },
        ],
      },
      cliHost
    );

    try {
      const execIndex = prepared.args.indexOf('exec');
      const promptIndex = prepared.args.indexOf('what is in this image?');
      expect(prepared.args.slice(execIndex + 1, promptIndex)).toEqual([
        '--image=/tmp/photo.png',
        '--image=/tmp/pic.jpg',
        '--',
      ]);
      expect(prepared.args).not.toContain('/tmp/doc.pdf');
      expect(prepared.args).not.toContain('-i');
    } finally {
      prepared.cleanup();
    }
  });

  it('media-free exec turns get no --image flags, and the prompt still follows a -- terminator', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: ['exec', 'plain work'],
        passthroughArgs: [],
      },
      cliHost
    );
    try {
      expect(prepared.args.slice(-3)).toEqual(['exec', '--', 'plain work']);
      expect(prepared.args.some((a) => a.startsWith('--image='))).toBe(false);
    } finally {
      prepared.cleanup();
    }
  });

  // A dash-leading prompt with no `--` before it is read as an option:
  // `--config=…` becomes a config override the effective-config check never
  // saw (Lumen, #701, measured on codex 0.159.2).
  it('keeps a dash-leading exec prompt behind the -- terminator, with or without images', async () => {
    const prompt = '--config=mcp_servers.inkwell.url="http://127.0.0.1:4001/mcp"';
    for (const media of [undefined, [{ path: '/tmp/photo.png', mimeType: 'image/png' }]]) {
      const prepared = await new CodexAdapter().prepare(
        {
          ...LAUNCHER_DEFAULTS,
          sbSlug: 'lumen',
          model: undefined,
          promptParts: ['exec', prompt],
          passthroughArgs: [],
          ...(media ? { media } : {}),
        },
        cliHost
      );
      try {
        expect(prepared.args.slice(-2)).toEqual(['--', prompt]);
        expect(prepared.args.filter((a) => a === '--')).toHaveLength(1);
        // Data, so not part of the configuration the check is run with.
        expect(JSON.stringify(prepared.launchConfig)).not.toContain('4001');
      } finally {
        prepared.cleanup();
      }
    }
  });

  it('takes a pass-through -- as the terminator: images before it, its positionals after, never a second --', async () => {
    const prepared = await new CodexAdapter().prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: ['exec', 'do work'],
        passthroughArgs: ['--skip-git-repo-check', '--', 'extra'],
        media: [{ path: '/tmp/photo.png', mimeType: 'image/png' }],
      },
      cliHost
    );
    try {
      const execIndex = prepared.args.indexOf('exec');
      expect(prepared.args.slice(execIndex)).toEqual([
        'exec',
        '--skip-git-repo-check',
        '--image=/tmp/photo.png',
        '--',
        'extra',
        'do work',
      ]);
    } finally {
      prepared.cleanup();
    }
  });

  it('places codex passthrough args after exec subcommand', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: ['exec', 'do work'],
        passthroughArgs: ['--sandbox', 'read-only', '--skip-git-repo-check'],
      },
      cliHost
    );

    try {
      const execIndex = prepared.args.indexOf('exec');
      expect(execIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args.slice(execIndex, execIndex + 6)).toEqual([
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--',
        'do work',
      ]);
    } finally {
      prepared.cleanup();
    }
  });

  it('injects startup context into codex model instructions file when provided', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        startupContextBlock: '### STARTUP TEST\nInjected from bootstrap.',
      },
      cliHost
    );

    try {
      const modelInstructionsArg = prepared.args.find((arg) =>
        arg.startsWith('model_instructions_file=')
      );
      expect(modelInstructionsArg).toBeDefined();
      const promptPath = modelInstructionsArg!.slice('model_instructions_file='.length);
      const promptBody = readFileSync(promptPath, 'utf-8');
      expect(promptBody).toContain('## Bootstrapped Startup Context (Inkwell)');
      expect(promptBody).toContain('### STARTUP TEST');
      expect(promptBody).toContain('Injected from bootstrap.');
    } finally {
      prepared.cleanup();
    }
  });

  it('maps --yolo to claude --dangerously-skip-permissions', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        dangerous: true,
      },
      cliHost
    );

    expect(prepared.args).toContain('--dangerously-skip-permissions');
  });

  it('maps --yolo to codex --dangerously-bypass-approvals-and-sandbox', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        dangerous: true,
      },
      cliHost
    );

    try {
      expect(prepared.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      prepared.cleanup();
    }
  });

  it('maps --yolo to gemini --yolo', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        dangerous: true,
      },
      cliHost
    );

    try {
      expect(prepared.args).toContain('--yolo');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not add auto-approve flags when dangerous is false', async () => {
    const claude = new ClaudeAdapter();
    const claudePrep = await claude.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );
    expect(claudePrep.args).not.toContain('--dangerously-skip-permissions');

    const codex = new CodexAdapter();
    const codexPrep = await codex.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );
    try {
      expect(codexPrep.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      codexPrep.cleanup();
    }

    const gemini = new GeminiAdapter();
    const geminiPrep = await gemini.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );
    try {
      expect(geminiPrep.args).not.toContain('--yolo');
    } finally {
      geminiPrep.cleanup();
    }
  });

  // ── Attachment directory grants ──
  // Files attached to a turn (--attach-file) live outside the cwd
  // (~/.ink/files/<channel>/). The claude adapter must grant read access
  // via --add-dir or the backend's Read silently fails on the paths the
  // prompt references.

  it('claude adapter grants --add-dir for each attachment directory', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        attachmentDirs: ['/home/u/.ink/files/telegram', '/tmp/uploads'],
      },
      cliHost
    );

    try {
      const grantedDirs = prepared.args
        .map((arg, i) => (arg === '--add-dir' ? prepared.args[i + 1] : null))
        .filter(Boolean);
      expect(grantedDirs).toContain('/home/u/.ink/files/telegram');
      expect(grantedDirs).toContain('/tmp/uploads');
    } finally {
      prepared.cleanup();
    }
  });

  it('claude adapter adds no attachment --add-dir without attachment directories', async () => {
    // Keep the standing studios-root grant off the real home dir.
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-adapter-${process.pid}`);
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );

    try {
      // Without attachments the only grants are Inkwell's own standing dirs:
      // ~/.ink/files (if present) and the ephemeral-studio root
      // (spec:studio-materialization v8). No attachment-specific dirs.
      const addDirPairs = prepared.args
        .map((arg, i) => (arg === '--add-dir' ? prepared.args[i + 1] : null))
        .filter(Boolean);
      for (const dir of addDirPairs) {
        expect(dir).toMatch(/\.ink\/files$|ink-studios-adapter-/);
      }
      // The studios root is granted unconditionally — a live session can
      // never be granted a new directory after spawn.
      expect(addDirPairs).toContain(process.env.INK_STUDIOS_ROOT);
    } finally {
      prepared.cleanup();
      rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });

  // PR #544 r1 P1 — the studios-root grant is a per-backend obligation, not a
  // Claude feature. Codex defaults to workspace-write: without --add-dir the
  // host MCP can mint a studio the session cannot edit, build, or test. The
  // flag must ride BOTH shapes; codex scopes flags to the subcommand they
  // follow, so on resume it must land after `resume`.
  it('codex adapter grants --add-dir for the ephemeral-studio root (fresh and resume)', async () => {
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-codex-${process.pid}`);
    try {
      for (const backendSessionId of [undefined, 'codex-sess-1']) {
        const prepared = await new CodexAdapter().prepare(
          {
            ...LAUNCHER_DEFAULTS,
            sbSlug: 'lumen',
            model: undefined,
            promptParts: [],
            passthroughArgs: [],
            backendSessionId,
          },
          cliHost
        );
        try {
          const granted = prepared.args
            .map((arg, i) => (arg === '--add-dir' ? prepared.args[i + 1] : null))
            .filter(Boolean);
          expect(granted).toContain(process.env.INK_STUDIOS_ROOT);
          if (backendSessionId) {
            expect(prepared.args.indexOf('--add-dir')).toBeGreaterThan(
              prepared.args.indexOf('resume')
            );
          }
        } finally {
          prepared.cleanup();
        }
      }
    } finally {
      rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });

  it('gemini adapter grants --include-directories for the ephemeral-studio root', async () => {
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-gemini-${process.pid}`);
    try {
      const prepared = await new GeminiAdapter().prepare(
        {
          ...LAUNCHER_DEFAULTS,
          sbSlug: 'aster',
          model: undefined,
          promptParts: [],
          passthroughArgs: [],
        },
        cliHost
      );
      try {
        const granted = prepared.args
          .map((arg, i) => (arg === '--include-directories' ? prepared.args[i + 1] : null))
          .filter(Boolean);
        expect(granted).toContain(process.env.INK_STUDIOS_ROOT);
      } finally {
        prepared.cleanup();
      }
    } finally {
      rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });

  // ── INK_SESSION_ID env propagation ──
  // These tests verify the most fragile link in the session identity chain:
  // the CLI backends must inject INK_SESSION_ID into the spawned process's
  // environment so hooks + buildMergedMcpConfig can propagate it to the server.

  it('injects INK_SESSION_ID into claude env when inkSessionId is provided', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'ink-sess-abc-123',
      },
      cliHost
    );

    expect(prepared.env).toBeDefined();
    expect(prepared.env!.INK_SESSION_ID).toBe('ink-sess-abc-123');
  });

  it('does not inject INK_SESSION_ID into claude env when inkSessionId is absent', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );

    expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
  });

  it('injects INK_SESSION_ID into codex env when inkSessionId is provided', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'ink-sess-def-456',
      },
      cliHost
    );

    try {
      expect(prepared.env).toBeDefined();
      expect(prepared.env!.INK_SESSION_ID).toBe('ink-sess-def-456');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not inject INK_SESSION_ID into codex env when inkSessionId is absent', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );

    try {
      expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
  });

  it('injects INK_SESSION_ID into gemini env when inkSessionId is provided', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'ink-sess-ghi-789',
      },
      cliHost
    );

    try {
      expect(prepared.env).toBeDefined();
      expect(prepared.env!.INK_SESSION_ID).toBe('ink-sess-ghi-789');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not inject INK_SESSION_ID into gemini env when inkSessionId is absent', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
      },
      cliHost
    );

    try {
      expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
  });

  it('injects both AGENT_ID and INK_SESSION_ID into all backend envs', async () => {
    const configs = [
      { adapter: new ClaudeAdapter(), sbSlug: 'wren', cleanup: false },
      { adapter: new CodexAdapter(), sbSlug: 'lumen', cleanup: true },
      { adapter: new GeminiAdapter(), sbSlug: 'aster', cleanup: true },
    ] as const;

    for (const { adapter, sbSlug, cleanup } of configs) {
      const prepared = await (
        adapter as { prepare: typeof ClaudeAdapter.prototype.prepare }
      ).prepare(
        {
          ...LAUNCHER_DEFAULTS,
          sbSlug,
          model: undefined,
          promptParts: [],
          passthroughArgs: [],
          inkSessionId: 'ink-sess-shared',
        },
        cliHost
      );

      try {
        expect(prepared.env).toBeDefined();
        expect(prepared.env!.AGENT_ID).toBe(sbSlug);
        expect(prepared.env!.INK_SESSION_ID).toBe('ink-sess-shared');
      } finally {
        if (cleanup) prepared.cleanup();
      }
    }
  });

  it('passes backendSessionId through gemini --resume flag', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        backendSessionId: 'gemini-session-456',
      },
      cliHost
    );

    try {
      const resumeFlagIndex = prepared.args.indexOf('--resume');
      expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args[resumeFlagIndex + 1]).toBe('gemini-session-456');
    } finally {
      prepared.cleanup();
    }
  });

  // ── INK_CONTEXT + auth header regression ──
  // Codex and Gemini adapters must produce INK_CONTEXT in env and
  // wire x-ink-context + Authorization via env_http_headers. Without these,
  // MCP tool calls go to Inkwell unauthenticated and without session context,
  // causing "Session context missing — triggers suppressed."

  it('claude adapter produces INK_CONTEXT with session/studio/agent', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'wren',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'sess-claude-123',
        studioId: 'studio-wren-456',
      },
      cliHost
    );

    try {
      expect(prepared.env.INK_CONTEXT).toBeDefined();
      const token = decodeContextToken(prepared.env.INK_CONTEXT);
      expect(token).not.toBeNull();
      expect(token!.sessionId).toBe('sess-claude-123');
      expect(token!.studioId).toBe('studio-wren-456');
      expect(token!.sbSlug).toBe('wren');
      expect(token!.runtime).toBe('claude');
      expect(token!.cliAttached).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  it('codex adapter produces INK_CONTEXT with session/studio/agent', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'sess-codex-123',
        studioId: 'studio-lumen-456',
      },
      cliHost
    );

    try {
      expect(prepared.env.INK_CONTEXT).toBeDefined();
      const token = decodeContextToken(prepared.env.INK_CONTEXT);
      expect(token).not.toBeNull();
      expect(token!.sessionId).toBe('sess-codex-123');
      expect(token!.studioId).toBe('studio-lumen-456');
      expect(token!.sbSlug).toBe('lumen');
      expect(token!.runtime).toBe('codex');
      expect(token!.cliAttached).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  it('codex adapter injects x-ink-context and a static bearer (not Authorization OAuth)', async () => {
    const adapter = new CodexAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'lumen',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'sess-codex-123',
      },
      cliHost
    );

    try {
      const contextArg = prepared.args.find((a) => a.includes('x-ink-context'));
      expect(contextArg).toBeDefined();
      expect(contextArg).toContain('INK_CONTEXT');

      // Auth goes through codex's static-bearer mechanism, which also suppresses
      // codex's own managed OAuth refresh for the inkwell server.
      const bearerArg = prepared.args.find((a) => a.includes('bearer_token_env_var'));
      expect(bearerArg).toBeDefined();
      expect(bearerArg).toContain('INK_ACCESS_TOKEN');

      // The old Authorization env_http_header must NOT be present — it would
      // leave codex running its independent (expiry-prone) OAuth dance.
      const authHeaderArg = prepared.args.find((a) => a.includes('env_http_headers.Authorization'));
      expect(authHeaderArg).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
  });

  it('gemini adapter produces INK_CONTEXT with session/studio/agent', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'sess-gemini-789',
        studioId: 'studio-aster-012',
      },
      cliHost
    );

    try {
      expect(prepared.env.INK_CONTEXT).toBeDefined();
      const token = decodeContextToken(prepared.env.INK_CONTEXT);
      expect(token).not.toBeNull();
      expect(token!.sessionId).toBe('sess-gemini-789');
      expect(token!.studioId).toBe('studio-aster-012');
      expect(token!.sbSlug).toBe('aster');
      expect(token!.runtime).toBe('gemini');
      expect(token!.cliAttached).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  // A headless `ink chat` hands its children its own INK_SESSION_ID, and each
  // child's on-prompt hook writes the token's cliAttached onto that session.
  // An adapter that asserts attachment regardless marks a headless run
  // attached, and every trigger during it is delivered inline to nobody
  // (PR #685, Lumen). The spawner's declaration must reach the token as given.
  it.each([
    ['claude', () => new ClaudeAdapter(), ['hello']],
    ['codex', () => new CodexAdapter(), ['exec', 'hello']],
    ['gemini', () => new GeminiAdapter(), ['hello']],
  ] as const)(
    '%s adapter carries the spawner’s cliAttached into INK_CONTEXT',
    async (_name, make, promptParts) => {
      for (const cliAttached of [false, true]) {
        const prepared = await make().prepare(
          {
            ...LAUNCHER_DEFAULTS,
            sbSlug: 'myra',
            prompt: 'hello',
            promptParts: [...promptParts],
            passthroughArgs: [],
            cliAttached,
          },
          cliHost
        );
        try {
          expect(decodeContextToken(prepared.env.INK_CONTEXT)?.cliAttached).toBe(cliAttached);
        } finally {
          prepared.cleanup();
        }
      }
    }
  );

  it('gemini adapter generates settings.json with auth + context headers', async () => {
    const adapter = new GeminiAdapter();
    const prepared = await adapter.prepare(
      {
        ...LAUNCHER_DEFAULTS,
        sbSlug: 'aster',
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        inkSessionId: 'sess-gemini-789',
      },
      cliHost
    );

    try {
      // Should have GEMINI_CLI_SYSTEM_SETTINGS_PATH pointing to temp file
      expect(prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeDefined();
      const settingsContent = readFileSync(prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(settingsContent);

      // Inkwell server should have auth + context headers
      expect(settings.mcpServers.inkwell).toBeDefined();
      expect(settings.mcpServers.inkwell.headers.Authorization).toBe('Bearer ${INK_ACCESS_TOKEN}');
      const contextToken = settings.mcpServers.inkwell.headers['x-ink-context'];
      const decoded = JSON.parse(Buffer.from(contextToken, 'base64url').toString());
      expect(decoded.sessionId).toBe('sess-gemini-789');
      expect(decoded.sbSlug).toBe('aster');
      expect(decoded.runtime).toBe('gemini');
      expect(settings.mcpServers.inkwell.headers['x-ink-session-id']).toBe('sess-gemini-789');
    } finally {
      prepared.cleanup();
    }
  });
});
