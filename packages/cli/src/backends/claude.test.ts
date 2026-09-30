import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decodeContextToken, PRINT_MODE_CHANNEL_ENV } from '@inklabs/shared';
import {
  ClaudeAdapter,
  classifyMedia,
  encodeContextImageBlocks,
  encodeMediaBlocks,
  readMediaBounded,
  MAX_MEDIA_FILE_BYTES,
  MAX_MEDIA_TOTAL_BYTES,
} from './claude.js';

// Keep user-installed skills out of the merged MCP config.
vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
}));

// Disable the `claude --help` partial-messages probe — no subprocesses in unit tests.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('probe disabled in tests');
    }),
  };
});

function mcpConfigFrom(args: string[]): Record<string, unknown> {
  const idx = args.indexOf('--mcp-config');
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(readFileSync(args[idx + 1]!, 'utf-8')).mcpServers;
}

describe('ClaudeAdapter prepare — tool routing', () => {
  let tmpDir: string;
  let savedCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          github: { type: 'http', url: 'https://api.github.com/mcp' },
          inkmail: { command: 'npx', args: ['tsx', 'packages/channel-plugin/index.ts'] },
        },
      })
    );
    // The on-disk plugin the withholding boundary's resolver authenticates
    // against — the retained inkmail entry is constructed from this path.
    mkdirSync(join(tmpDir, 'packages', 'channel-plugin'), { recursive: true });
    writeFileSync(join(tmpDir, 'packages', 'channel-plugin', 'index.ts'), '// stub\n');
    savedCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ink-owned routing ('local') withholds tool servers AND built-ins, pinning the config strictly", () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      // Without strict mode claude merges user/project-scope MCP configs on
      // its own and the withheld servers leak back in.
      expect(prepared.args).toContain('--strict-mcp-config');
      // Built-ins are part of the boundary: with no attachments this session
      // gets NO native tools at all — Bash/Edit/WebSearch/ToolSearch would
      // bypass ink's tool policy.
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(prepared.args[toolsIdx + 1]).toBe('');
      const servers = mcpConfigFrom(prepared.args);
      expect(Object.keys(servers)).toEqual(['inkmail']);
      // Channel loading still references the surviving inkmail entry.
      expect(prepared.args).toContain('--dangerously-load-development-channels');
    } finally {
      prepared.cleanup();
    }
  });

  it('threads a per-SB effort to the claude CLI, and sends none when unset (task 7ea6cdf7)', () => {
    const adapter = new ClaudeAdapter();
    const withEffort = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
      effort: 'xhigh',
    });
    try {
      const idx = withEffort.args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(withEffort.args[idx + 1]).toBe('xhigh');
    } finally {
      withEffort.cleanup();
    }
    const without = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      expect(without.args).not.toContain('--effort');
    } finally {
      without.cleanup();
    }
  });

  it('local routing exposes native Read ONLY for attachment-bearing sessions (named exception)', () => {
    // The multimodal render path: --attach-file media is read natively
    // (images cannot flow through ink-block tools). This is a documented
    // exception to wholly-in-ink, not the default.
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'what is in this image?',
      promptParts: ['what is in this image?'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
    });
    try {
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('Read');
      expect(prepared.args).toContain('--strict-mcp-config');
    } finally {
      prepared.cleanup();
    }
  });

  it('an adversarial inkmail entry is replaced by the constructed canonical entry', () => {
    // Lumen's repro family: the project entry's launcher/args are never
    // copied — the retained entry is constructed from the resolver's on-disk
    // candidate, so the attacker string cannot reach the provider.
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          inkmail: {
            type: 'stdio',
            command: 'node',
            args: ['/tmp/evil.js', 'packages/channel-plugin/index.ts'],
          },
        },
      })
    );
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      const servers = mcpConfigFrom(prepared.args) as Record<
        string,
        { command?: string; args?: string[] }
      >;
      expect(Object.keys(servers)).toEqual(['inkmail']);
      expect(servers.inkmail!.command).toBe('npx');
      // realpath: chdir resolves the tmpdir symlink (/var → /private/var on
      // macOS), and the resolver constructs from process.cwd().
      expect(servers.inkmail!.args).toEqual([
        'tsx',
        join(realpathSync(tmpDir), 'packages', 'channel-plugin', 'index.ts'),
      ]);
      expect(JSON.stringify(servers)).not.toContain('/tmp/evil.js');
      expect(prepared.args).toContain('--dangerously-load-development-channels');
    } finally {
      prepared.cleanup();
    }
  });

  it('a declared inkmail with no resolvable plugin yields no bridge and no channel flag', () => {
    // Channel loading keys off the RETAINED entry, never the raw project
    // file — claude must not be asked to load `server:inkmail` from a strict
    // config that does not define it.
    rmSync(join(tmpDir, 'packages'), { recursive: true, force: true });
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      expect(mcpConfigFrom(prepared.args)).toEqual({});
      expect(prepared.args).not.toContain('--dangerously-load-development-channels');
    } finally {
      prepared.cleanup();
    }
  });

  it('provider-owned routing (undefined/backend) passes the full config, no strict flag', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'wren',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
    });
    try {
      expect(prepared.args).not.toContain('--strict-mcp-config');
      expect(prepared.args).not.toContain('--tools');
      const servers = mcpConfigFrom(prepared.args);
      expect(Object.keys(servers).sort()).toEqual(['github', 'inkmail', 'inkwell']);
    } finally {
      prepared.cleanup();
    }
  });

  // Task 2f892701: `-p` cannot show a channel notification, and both routings
  // can still load the inkmail plugin (local keeps the bridge; backend is not
  // strict). Every print-mode spawn must tell the plugin to stay inert, and an
  // interactive one must not, or live CLIs lose channel delivery.
  it('declares print mode to the channel plugin on every -p spawn, and only there', () => {
    const adapter = new ClaudeAdapter();
    for (const toolRouting of ['local', undefined] as const) {
      const printed = adapter.prepare({
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        ...(toolRouting ? { toolRouting } : {}),
      });
      try {
        expect(printed.args).toContain('-p');
        expect(printed.env).toMatchObject(PRINT_MODE_CHANNEL_ENV);
      } finally {
        printed.cleanup();
      }
    }

    const interactive = adapter.prepare({
      sbSlug: 'wren',
      prompt: '',
      promptParts: [],
      passthroughArgs: [],
    });
    try {
      expect(interactive.args).not.toContain('-p');
      expect(interactive.args).toContain('--dangerously-load-development-channels');
      expect(interactive.env).not.toHaveProperty('INK_CHANNEL_HOST');
    } finally {
      interactive.cleanup();
    }
  });

  // `ink -b claude -p hello` parses to no prompt and passthrough
  // ['-p', 'hello']: the flag is unknown to extractArgs and takes the next
  // word as its value. The Claude it launches is print mode, so the plugin
  // must go inert there too (PR #685, Lumen).
  it.each([[['-p', 'hello']], [['--print', 'hello']], [['--model', 'sonnet', '-p']]])(
    'treats a print flag in passthrough %j as print mode',
    (passthroughArgs) => {
      const prepared = new ClaudeAdapter().prepare({
        sbSlug: 'wren',
        promptParts: [],
        passthroughArgs: [...passthroughArgs],
      });
      try {
        expect(prepared.env).toMatchObject(PRINT_MODE_CHANNEL_ENV);
        // The user's flag is the only one: nothing is added in front of it.
        const printFlags = prepared.args.filter((a) => a === '-p' || a === '--print');
        expect(printFlags).toHaveLength(1);
      } finally {
        prepared.cleanup();
      }
    }
  );

  // Two separate questions: can this host render a channel message (never,
  // in print mode), and does the spawner own an attached session (its call).
  // An attached `ink chat` REPL's children keep the plugin inert, and a
  // headless run's children declare themselves unattached. The default stays
  // attached: an attached prompt is what claims the turn epoch and renews the
  // studio lease for a human's one-shot `ink "…"`.
  it('keeps print-mode attachment the spawner’s call, and the plugin inert either way', () => {
    const adapter = new ClaudeAdapter();
    const cases = [
      { cliAttached: undefined, expected: true },
      { cliAttached: true, expected: true },
      { cliAttached: false, expected: false },
    ];
    for (const { cliAttached, expected } of cases) {
      const prepared = adapter.prepare({
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        ...(cliAttached !== undefined ? { cliAttached } : {}),
      });
      try {
        expect(decodeContextToken(prepared.env.INK_CONTEXT)?.cliAttached).toBe(expected);
        expect(prepared.env).toMatchObject(PRINT_MODE_CHANNEL_ENV);
      } finally {
        prepared.cleanup();
      }
    }

    const interactive = adapter.prepare({ sbSlug: 'wren', promptParts: [], passthroughArgs: [] });
    try {
      expect(decodeContextToken(interactive.env.INK_CONTEXT)?.cliAttached).toBe(true);
    } finally {
      interactive.cleanup();
    }
  });
});

describe('classifyMedia (IO-free mime buckets)', () => {
  it('supported images are candidates; everything else is the native-read bucket', () => {
    const c = classifyMedia([
      { path: '/a.png', mimeType: 'image/png' },
      { path: '/b.pdf', mimeType: 'application/pdf' },
      { path: '/c.heic', mimeType: 'image/heic' },
      { path: '/d.bin' },
    ]);
    expect(c.candidates.map((m) => m.path)).toEqual(['/a.png']);
    expect(c.nativeRead.map((m) => m.path)).toEqual(['/b.pdf', '/c.heic', '/d.bin']);
  });
});

describe('encodeMediaBlocks (bounded IO, fail-closed rejection)', () => {
  const fakeRead =
    (map: Record<string, number | null>) =>
    (path: string, maxBytes: number): Buffer | null => {
      const size = map[path];
      if (size === null || size === undefined || size > maxBytes) return null;
      return Buffer.alloc(size, 1);
    };

  it('rejects unreadable and over-cap candidates instead of falling back', () => {
    const out = encodeMediaBlocks(
      [
        { path: '/big.png', mimeType: 'image/png' },
        { path: '/gone.png', mimeType: 'image/png' },
        { path: '/ok.png', mimeType: 'image/png' },
      ],
      fakeRead({ '/big.png': MAX_MEDIA_FILE_BYTES + 1, '/gone.png': null, '/ok.png': 10 })
    );
    expect(out.injected.map((m) => m.path)).toEqual(['/ok.png']);
    expect(out.rejected.map((r) => r.media.path)).toEqual(['/big.png', '/gone.png']);
    expect(out.blocks).toHaveLength(1);
  });

  it('enforces the running total cap across files', () => {
    const nineMb = 9 * 1024 * 1024;
    const out = encodeMediaBlocks(
      [
        { path: '/one.png', mimeType: 'image/png' },
        { path: '/two.png', mimeType: 'image/png' },
        { path: '/three.png', mimeType: 'image/png' },
      ],
      fakeRead({ '/one.png': nineMb, '/two.png': nineMb, '/three.png': nineMb })
    );
    expect(out.injected.map((m) => m.path)).toEqual(['/one.png', '/two.png']);
    expect(out.rejected.map((r) => r.media.path)).toEqual(['/three.png']);
  });
});

describe('readMediaBounded (single-descriptor, regular files only)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-bounded-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a regular file fully within the cap', () => {
    const p = join(dir, 'f.bin');
    writeFileSync(p, Buffer.alloc(1024, 7));
    const buf = readMediaBounded(p, 2048);
    expect(buf?.byteLength).toBe(1024);
    expect(buf?.every((b) => b === 7)).toBe(true);
  });

  it('returns null for oversize, missing, and non-regular paths', () => {
    const p = join(dir, 'f.bin');
    writeFileSync(p, Buffer.alloc(1024, 7));
    expect(readMediaBounded(p, 1023)).toBeNull();
    expect(readMediaBounded(join(dir, 'nope.bin'), 4096)).toBeNull();
    // A directory is not a regular file.
    expect(readMediaBounded(dir, 4096)).toBeNull();
  });

  it(
    'a FIFO is rejected without blocking — verified in a killable child',
    { timeout: 20000 },
    () => {
      // Opening a FIFO for read normally BLOCKS until a writer appears — a
      // hostile/accidental media path must not hang the spawn (Lumen, review
      // 4900202375). An in-worker vitest timeout cannot guard this: a
      // blocking openSync freezes the worker's event loop and the timer
      // never fires (review 4900276464). So the REAL readMediaBounded runs
      // in a child process with an external kill timeout — an O_NONBLOCK
      // regression hangs the CHILD, execSync kills it, and the assertion
      // fails instead of the suite wedging.
      const p = join(dir, 'pipe.fifo');
      execSync(`mkfifo ${JSON.stringify(p)}`);
      const moduleUrl = new URL('./claude.ts', import.meta.url).href;
      const script =
        `import(${JSON.stringify(moduleUrl)})` +
        `.then((m) => console.log(JSON.stringify(m.readMediaBounded(${JSON.stringify(p)}, 4096))))`;
      const out = execSync(`npx tsx -e ${JSON.stringify(script)}`, {
        timeout: 15000,
        encoding: 'utf-8',
      });
      expect(out.trim()).toBe('null');
    }
  );
});

describe('ClaudeAdapter prepare — media injection', () => {
  // 1x1 transparent PNG — a real image so base64 round-trips honestly.
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  let tmpDir: string;
  let savedCwd: string;
  let pngPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-media-'));
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    pngPath = join(tmpDir, 'photo.png');
    writeFileSync(pngPath, PNG_BYTES);
    savedCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fully-injected media: stream-json stdin envelope, --tools stays empty', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'what is in this image?',
      promptParts: ['what is in this image?'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [{ path: pngPath, mimeType: 'image/png' }],
      deliverMedia: true,
    });
    try {
      expect(prepared.args).toContain('--input-format');
      expect(prepared.args[prepared.args.indexOf('--input-format') + 1]).toBe('stream-json');
      // Delivery turn is fully injected — the boundary stays closed.
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');

      const line = JSON.parse(prepared.stdinData!.trim());
      expect(line.type).toBe('user');
      expect(line.message.role).toBe('user');
      expect(line.message.content[0]).toEqual({ type: 'text', text: 'what is in this image?' });
      expect(line.message.content[1].type).toBe('image');
      expect(line.message.content[1].source.media_type).toBe('image/png');
      expect(Buffer.from(line.message.content[1].source.data, 'base64').equals(PNG_BYTES)).toBe(
        true
      );
    } finally {
      prepared.cleanup();
    }
  });

  it('partially-injected media keeps the gated Read fallback for the rest', () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, 'not really a pdf');
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'summarize these',
      promptParts: ['summarize these'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [
        { path: pngPath, mimeType: 'image/png' },
        { path: pdfPath, mimeType: 'application/pdf' },
      ],
      deliverMedia: true,
    });
    try {
      // Image still injected…
      expect(prepared.args).toContain('--input-format');
      // …but the uninjectable pdf keeps native Read on.
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('Read');
    } finally {
      prepared.cleanup();
    }
  });

  it('text-only turns keep the plain stdin path', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      toolRouting: 'local',
    });
    try {
      expect(prepared.args).not.toContain('--input-format');
      expect(prepared.stdinData).toBe('hello');
    } finally {
      prepared.cleanup();
    }
  });

  it('resume spawns keep the delivery disposition: no re-embed, --tools stays empty', () => {
    // Lumen's round-1 repro (review 4900120086): a tool-loop continuation
    // resumes the provider session that already holds the injected image.
    // It must NOT reopen native Read — the boundary decision derives from
    // the same mime classification as the delivery spawn.
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'continue',
      promptParts: ['continue'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [{ path: pngPath, mimeType: 'image/png' }],
      backendSessionId: 'live-session-abc',
    });
    try {
      expect(prepared.args).not.toContain('--input-format');
      expect(prepared.stdinData).toBe('continue');
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');
    } finally {
      prepared.cleanup();
    }
  });

  it('injection failure fails CLOSED and the rejection rides the prompt itself', () => {
    // A supported image that cannot be read (missing file) is rejected —
    // it neither injects nor reopens the native-read exception. And because
    // stderr is invisible on successful headless runs, the note is embedded
    // in the provider input so the user hears about it.
    const adapter = new ClaudeAdapter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'look at this',
      promptParts: ['look at this'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [{ path: join(tmpDir, 'vanished.png'), mimeType: 'image/png' }],
      deliverMedia: true,
    });
    try {
      expect(prepared.args).not.toContain('--input-format');
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0])).toContain('vanished.png');
      expect(prepared.stdinData).toContain('[media note]');
      expect(prepared.stdinData).toContain('vanished.png');
    } finally {
      warn.mockRestore();
      prepared.cleanup();
    }
  });

  it('new media on a RESUMED conversation embeds when marked as delivery', () => {
    // Lumen's round-2 repro (review 4900202375): a server heartbeat or
    // reattach can recover an existing provider session AND deliver brand
    // new media in the same spawn. backendSessionId alone must not suppress
    // embedding — deliverMedia is the explicit signal.
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'here is a new photo',
      promptParts: ['here is a new photo'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [{ path: pngPath, mimeType: 'image/png' }],
      deliverMedia: true,
      backendSessionId: 'recovered-session-xyz',
    });
    try {
      expect(prepared.args).toContain('--resume');
      expect(prepared.args).toContain('--input-format');
      const line = JSON.parse(prepared.stdinData!.trim());
      expect(line.message.content[1].type).toBe('image');
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');
    } finally {
      prepared.cleanup();
    }
  });
});

describe('ClaudeAdapter prepare — images a tool put in context', () => {
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  let tmpDir: string;
  let savedCwd: string;
  let pngPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-context-images-'));
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    pngPath = join(tmpDir, 'viewed.png');
    writeFileSync(pngPath, PNG_BYTES);
    savedCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('embeds them on a resumed continuation, each labelled with its ref', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: '[Tool results from previous turn]\nTool view_image (executed): {...}',
      promptParts: [],
      passthroughArgs: [],
      toolRouting: 'local',
      backendSessionId: 'live-session',
      contextImages: [
        { path: pngPath, mimeType: 'image/png', ref: 'img:0123456789abcdef' } as never,
      ],
    });
    try {
      expect(prepared.args).toContain('--resume');
      expect(prepared.args[prepared.args.indexOf('--input-format') + 1]).toBe('stream-json');
      const line = JSON.parse(prepared.stdinData!.trim());
      const content = line.message.content;
      expect(content[0].text).toContain('Tool view_image (executed)');
      expect(content[1]).toEqual({ type: 'text', text: '[image img:0123456789abcdef]' });
      expect(content[2].type).toBe('image');
      expect(Buffer.from(content[2].source.data, 'base64').equals(PNG_BYTES)).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  it('never move the --tools gate, which stays a function of the turn media alone', () => {
    // A legacy caller: attachment dirs and no threaded media keeps native Read
    // open. Adding a context image must not close it — nor would its absence
    // open it on a turn whose media had closed it.
    const adapter = new ClaudeAdapter();
    const base = {
      sbSlug: 'myra',
      prompt: 'continue',
      promptParts: [],
      passthroughArgs: [],
      toolRouting: 'local' as const,
      attachmentDirs: [tmpDir],
    };
    const without = adapter.prepare(base);
    const withImage = adapter.prepare({
      ...base,
      contextImages: [{ path: pngPath, mimeType: 'image/png' }],
    });
    try {
      const gate = (args: string[]) => args[args.indexOf('--tools') + 1];
      expect(gate(without.args)).toBe('Read');
      expect(gate(withImage.args)).toBe('Read');
    } finally {
      without.cleanup();
      withImage.cleanup();
    }
  });

  it('names an image that could not be attached, and tells the model it has not seen it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'continue',
      promptParts: [],
      passthroughArgs: [],
      toolRouting: 'local',
      contextImages: [
        {
          path: join(tmpDir, 'gone.png'),
          mimeType: 'image/png',
          ref: 'img:feedfacefeedface',
        } as never,
      ],
    });
    try {
      expect(prepared.args).not.toContain('--input-format');
      expect(prepared.stdinData).toContain('[image note]');
      expect(prepared.stdinData).toContain('img:feedfacefeedface');
      expect(prepared.stdinData).toContain('you have not seen them');
    } finally {
      warn.mockRestore();
      prepared.cleanup();
    }
  });

  it('share one request budget with the turn media, which is encoded first', () => {
    const reader = (_path: string, maxBytes: number) =>
      maxBytes >= 1024 ? Buffer.alloc(1024) : null;
    const nearlyFull = encodeContextImageBlocks(
      [{ path: '/virtual/a.png', mimeType: 'image/png' }],
      MAX_MEDIA_TOTAL_BYTES - 10,
      reader
    );
    expect(nearlyFull.blocks).toEqual([]);
    expect(nearlyFull.rejected).toHaveLength(1);

    const roomy = encodeContextImageBlocks(
      [{ path: '/virtual/a.png', mimeType: 'image/png' }],
      0,
      reader
    );
    expect(roomy.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(roomy.totalBytes).toBe(1024);
  });
});
