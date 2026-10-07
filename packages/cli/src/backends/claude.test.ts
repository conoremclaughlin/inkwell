import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync as execFileSyncForTest, execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decodeContextToken, PRINT_MODE_CHANNEL_ENV } from '@inklabs/shared';
import {
  ClaudeAdapter,
  classifyMedia,
  encodeContextImageBlocks,
  encodeDocumentBlocks,
  encodeMediaBlocks,
  extractPdfTextSync,
  readMediaBounded,
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_MEDIA_FILE_BYTES,
  MAX_MEDIA_TOTAL_BYTES,
  MAX_PDF_PAGES,
  MAX_TEXT_DOCUMENT_BYTES,
  PDF_EXTRACT_TIMEOUT_MS,
} from './claude.js';

// Keep user-installed skills out of the merged MCP config.
// The CLI's own Inkwell checkout is the last inkmail plugin candidate (task
// 5cabaeeb); none here, so a tmp repo resolves only what a test put on disk.
vi.mock('../lib/ink-checkout.js', () => ({ inkCliMainWorktree: () => null }));

vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
}));

// Disable the `claude --help` partial-messages probe: no claude subprocess in
// unit tests. The PDF text extractor, a child of this same node binary, runs
// for real, so the documents tests exercise the actual extraction path.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string, ...rest: unknown[]) => {
      if (file === process.execPath) {
        return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      }
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
      expect(prepared.stdinData).toContain('goes again with your next message');
      expect(prepared).not.toHaveProperty('contextImagesDelivered');
    } finally {
      warn.mockRestore();
      prepared.cleanup();
    }
  });

  it('reports only the images its input carries, so a refused one is not counted as seen', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new ClaudeAdapter();
    const carried = { path: pngPath, mimeType: 'image/png', ref: 'img:0000000000000001' };
    const refused = {
      path: join(tmpDir, 'gone.png'),
      mimeType: 'image/png',
      ref: 'img:0000000000000002',
    };
    const prepared = adapter.prepare({
      sbSlug: 'myra',
      prompt: 'continue',
      promptParts: [],
      passthroughArgs: [],
      toolRouting: 'local',
      contextImages: [carried, refused] as never,
    });
    try {
      expect(prepared.contextImagesDelivered).toEqual([carried]);
      const line = JSON.parse(prepared.stdinData!.trim());
      const labels = line.message.content
        .filter((b: { type: string; text?: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text);
      expect(labels).toContain('[image img:0000000000000001]');
      expect(labels.join('\n')).not.toContain('[image img:0000000000000002]');
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

describe('ClaudeAdapter prepare — provider tools withheld (task 0321ccf1)', () => {
  // A synthetic home holding what an inkling must not reach: the shared media
  // directory, a studio checkout with its .env.local, and an upload of its own.
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  let home: string;
  let uploadDir: string;
  let savedCwd: string;
  let files: Record<'png' | 'pdf' | 'txt', string>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-withheld-')));
    mkdirSync(join(home, '.ink', 'files', 'telegram'), { recursive: true });
    mkdirSync(join(home, '.ink', 'studios', 'some-studio'), { recursive: true });
    writeFileSync(join(home, '.ink', 'studios', 'some-studio', '.env.local'), 'SYNTHETIC=1\n');
    const folder = join(home, '.ink', 'inklings', 'kindle-0a1b2c3d');
    mkdirSync(folder, { recursive: true });
    uploadDir = join(home, '.ink', 'uploads', 'u', 'w', 'up1');
    mkdirSync(uploadDir, { recursive: true });
    files = {
      png: join(uploadDir, 'up1.png'),
      pdf: join(uploadDir, 'up1.pdf'),
      txt: join(uploadDir, 'up1.txt'),
    };
    writeFileSync(files.png, PNG_BYTES);
    writeFileSync(files.pdf, 'not really a pdf');
    writeFileSync(files.txt, 'plain words');
    vi.stubEnv('HOME', home);
    vi.stubEnv('INK_STUDIOS_ROOT', join(home, '.ink', 'studios'));
    savedCwd = process.cwd();
    process.chdir(folder);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const MEDIA = {
    png: () => ({ path: files.png, mimeType: 'image/png' }),
    pdf: () => ({ path: files.pdf, mimeType: 'application/pdf' }),
    txt: () => ({ path: files.txt, mimeType: 'text/plain' }),
  };

  function prepare(extra: Record<string, unknown>) {
    return new ClaudeAdapter().prepare({
      sbSlug: 'kindle-0a1b2c3d',
      prompt: 'what did I send?',
      promptParts: ['what did I send?'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [uploadDir],
      ...extra,
    });
  }

  const toolsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === '--tools');
  const grantsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === '--add-dir');

  it('opens Read and grants the shared directories without it (the control)', () => {
    const prepared = prepare({ media: [MEDIA.pdf()], deliverMedia: true });
    try {
      expect(toolsOf(prepared.args)).toEqual(['Read']);
      expect(grantsOf(prepared.args)).toEqual([
        uploadDir,
        join(home, '.ink', 'files'),
        join(home, '.ink', 'studios'),
      ]);
    } finally {
      prepared.cleanup();
    }
  });

  it('keeps no native tool and grants nothing, for every attachment and every spawn of a turn', () => {
    const mediaSets = [[], [MEDIA.pdf()], [MEDIA.txt()], [MEDIA.png()], [MEDIA.png(), MEDIA.pdf()]];
    const spawns = [
      { deliverMedia: true }, // a fresh delivery
      { deliverMedia: true, backendSessionSeedId: 'seeded-provider-session' }, // a reseed
      { deliverMedia: true, backendSessionId: 'resumed-provider-session' }, // a resumed delivery
      { backendSessionId: 'resumed-provider-session' }, // a same-turn continuation
    ];
    let checked = 0;
    for (const media of mediaSets) {
      for (const spawn of spawns) {
        const prepared = prepare({ withholdProviderTools: true, media, ...spawn });
        const label = `${media.map((m) => m.mimeType).join('+') || 'no media'} ${JSON.stringify(spawn)}`;
        try {
          expect(toolsOf(prepared.args), label).toEqual(['']);
          expect(grantsOf(prepared.args), label).toEqual([]);
          expect(prepared.args, label).toContain('--strict-mcp-config');
          expect(prepared.args, label).not.toContain('--dangerously-skip-permissions');
          checked++;
        } finally {
          prepared.cleanup();
        }
      }
    }
    expect(checked).toBe(mediaSets.length * spawns.length);
  });

  it('appends no caller argument, so a trailing one cannot reopen tools or directories', () => {
    const prepared = prepare({
      withholdProviderTools: true,
      media: [MEDIA.pdf()],
      deliverMedia: true,
      passthroughArgs: [
        '--tools',
        'Bash,Read',
        '--add-dir',
        '/',
        '--mcp-config',
        '/synthetic/other.json',
        '--dangerously-skip-permissions',
      ],
    });
    try {
      expect(toolsOf(prepared.args)).toEqual(['']);
      expect(grantsOf(prepared.args)).toEqual([]);
      expect(prepared.args.filter((a) => a === '--mcp-config')).toHaveLength(1);
      expect(prepared.args).not.toContain('/synthetic/other.json');
      expect(prepared.args).not.toContain('--dangerously-skip-permissions');
    } finally {
      prepared.cleanup();
    }
  });

  it('shows a photo inline and a text file as text, and names a PDF it could not read', () => {
    const prepared = prepare({
      withholdProviderTools: true,
      media: [MEDIA.png(), MEDIA.pdf(), MEDIA.txt()],
      deliverMedia: true,
    });
    try {
      const line = JSON.parse(prepared.stdinData!.trim());
      const [text, image, document, ...rest] = line.message.content;
      expect(rest).toEqual([]);
      expect(image.type).toBe('image');
      expect(Buffer.from(image.source.data, 'base64').equals(PNG_BYTES)).toBe(true);
      expect(document.type).toBe('text');
      expect(document.text).toContain('[Attached file up1.txt (text/plain, 11 bytes).');
      expect(document.text).toContain('```\nplain words\n```');
      expect(text.text).toContain('[media note] These attached file(s) could NOT be opened');
      expect(text.text).toContain(
        '- up1.pdf (application/pdf) — its text could not be read as a PDF'
      );
      expect(text.text).not.toContain('up1.txt');
      expect(text.text).not.toContain('up1.png');
    } finally {
      prepared.cleanup();
    }
  });

  it('says it once, on the delivery spawn, and not on a continuation', () => {
    const prepared = prepare({
      withholdProviderTools: true,
      media: [MEDIA.pdf()],
      backendSessionId: 'resumed-provider-session',
    });
    try {
      expect(prepared.stdinData).not.toContain('[media note]');
    } finally {
      prepared.cleanup();
    }
  });

  it('refuses withheld tools without ink-owned routing, rather than spawn the provider with its own', () => {
    expect(() => prepare({ withholdProviderTools: true, toolRouting: 'backend' })).toThrow(
      'withholdProviderTools requires ink-owned (local) tool routing'
    );
    expect(() => prepare({ withholdProviderTools: true, toolRouting: undefined })).toThrow(
      'withholdProviderTools requires ink-owned (local) tool routing'
    );
  });
});

/**
 * A one-page PDF holding `lines` as real text, offsets computed, for the
 * extractor. A small `leading` keeps many lines on the page; text set below
 * the page is not extracted.
 */
function minimalPdf(lines: string[], leading = 16): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td ${lines
    .map((l, i) => (i ? `0 -${leading} Td (${l}) Tj` : `(${l}) Tj`))
    .join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('documents on a withheld turn (task 0321ccf1 follow-up)', () => {
  const doc = (path: string, mimeType?: string) => ({ path, mimeType });
  const reader =
    (files: Record<string, Buffer>) =>
    (path: string, maxBytes: number): Buffer | null => {
      const buf = files[path];
      return buf && buf.byteLength <= maxBytes ? buf : null;
    };
  const noPdf = () => null;

  describe('encodeDocumentBlocks', () => {
    it('shows a text file whole, fenced, under a label naming it', () => {
      const bom = String.fromCharCode(0xfeff);
      const out = encodeDocumentBlocks(
        [doc('/u/a.txt', 'text/plain; charset=utf-8')],
        0,
        reader({ '/u/a.txt': Buffer.from(`${bom}line one\nline two`, 'utf8') }),
        noPdf
      );
      expect(out.rejected).toEqual([]);
      expect(out.injected).toEqual([doc('/u/a.txt', 'text/plain; charset=utf-8')]);
      expect(out.blocks).toEqual([
        {
          type: 'text',
          text:
            '[Attached file a.txt (text/plain, 20 bytes). Its contents follow between the fences.]\n' +
            '```\nline one\nline two\n```',
        },
      ]);
      expect(out.totalBytes).toBe(Buffer.byteLength(out.blocks[0]!.text as string, 'utf8'));
    });

    it('takes any text/* and JSON as text', () => {
      const files = {
        '/u/a.md': Buffer.from('# heading'),
        '/u/b.csv': Buffer.from('a,b'),
        '/u/c.json': Buffer.from('{"k":1}'),
      };
      const out = encodeDocumentBlocks(
        [
          doc('/u/a.md', 'text/markdown'),
          doc('/u/b.csv', 'text/csv'),
          doc('/u/c.json', 'application/json'),
        ],
        0,
        reader(files),
        noPdf
      );
      expect(out.rejected).toEqual([]);
      expect(out.blocks).toHaveLength(3);
    });

    it('uses a fence longer than any run of backticks in the file', () => {
      const out = encodeDocumentBlocks(
        [doc('/u/a.txt', 'text/plain')],
        0,
        reader({ '/u/a.txt': Buffer.from('before\n`````\nafter') }),
        noPdf
      );
      const text = out.blocks[0]!.text as string;
      expect(text.endsWith('\n``````')).toBe(true);
      expect(text).toContain('\n``````\nbefore\n`````\nafter\n``````');
    });

    it('cuts long text at the character cap, says so, and never splits a surrogate pair', () => {
      const emoji = String.fromCodePoint(0x1f600);
      const body = 'x'.repeat(MAX_DOCUMENT_TEXT_CHARS - 1) + emoji + 'tail';
      const out = encodeDocumentBlocks(
        [doc('/u/a.txt', 'text/plain')],
        0,
        reader({ '/u/a.txt': Buffer.from(body, 'utf8') }),
        noPdf
      );
      const text = out.blocks[0]!.text as string;
      expect(text).toContain('x'.repeat(MAX_DOCUMENT_TEXT_CHARS - 1) + '\n```');
      expect(text).not.toContain(emoji);
      expect(text).not.toContain('tail');
      expect(
        text.endsWith('[The text was cut at 100,000 characters; the rest is not shown.]')
      ).toBe(true);
      expect(() => Buffer.from(text, 'utf8').toString('utf8')).not.toThrow();
    });

    it('names what it cannot show, with the reason, and shows the rest', () => {
      const bad = Buffer.from([0x66, 0x6f, 0xff, 0x6f]);
      const files = { '/u/bad.txt': bad, '/u/ok.txt': Buffer.from('fine') };
      const out = encodeDocumentBlocks(
        [
          doc('/u/bad.txt', 'text/plain'),
          doc('/u/big.txt', 'text/plain'),
          doc('/u/voice.m4a', 'audio/mp4'),
          doc('/u/photo.heic', 'image/heic'),
          doc('/u/none'),
          doc('/u/ok.txt', 'text/plain'),
        ],
        0,
        reader(files),
        noPdf
      );
      expect(out.rejected.map((r) => [r.media.path, r.reason])).toEqual([
        ['/u/bad.txt', 'not valid UTF-8 text'],
        ['/u/big.txt', 'unreadable, not a regular file, or over size cap'],
        ['/u/voice.m4a', 'not a type that can be shown in this conversation'],
        ['/u/photo.heic', 'not a type that can be shown in this conversation'],
        ['/u/none', 'not a type that can be shown in this conversation'],
      ]);
      expect(out.injected.map((m) => m.path)).toEqual(['/u/ok.txt']);
    });

    it('reads a text file up to its own cap, and a PDF up to the media file cap', () => {
      const seen: number[] = [];
      encodeDocumentBlocks(
        [doc('/u/a.txt', 'text/plain'), doc('/u/b.pdf', 'application/pdf')],
        0,
        (_path, max) => {
          seen.push(max);
          return null;
        }
      );
      expect(seen).toEqual([MAX_TEXT_DOCUMENT_BYTES, MAX_MEDIA_FILE_BYTES]);
    });

    it('reads and extracts nothing once the budget is spent', () => {
      const read = vi.fn(() => Buffer.from('x'));
      const extract = vi.fn(() => ({ text: 'x', pages: 1, total: 1 }));
      const out = encodeDocumentBlocks(
        [doc('/u/a.txt', 'text/plain'), doc('/u/b.pdf', 'application/pdf')],
        MAX_MEDIA_TOTAL_BYTES,
        read,
        extract
      );
      expect(out.rejected.map((r) => r.reason)).toEqual([
        'turn media budget exhausted',
        'turn media budget exhausted',
      ]);
      expect(read).not.toHaveBeenCalled();
      expect(extract).not.toHaveBeenCalled();
    });

    it('shows a PDF as the text of its first pages, saying which pages', () => {
      const pdf = Buffer.from('%PDF-synthetic');
      const asked: Array<[Buffer, number]> = [];
      const out = encodeDocumentBlocks(
        [doc('/u/r.pdf', 'application/pdf')],
        0,
        reader({ '/u/r.pdf': pdf }),
        (b, n) => {
          asked.push([b, n]);
          return { text: 'page one words', pages: MAX_PDF_PAGES, total: 45 };
        }
      );
      expect(asked).toEqual([[pdf, MAX_PDF_PAGES]]);
      expect(out.blocks[0]!.text).toBe(
        `[Attached file r.pdf (PDF, pages 1–${MAX_PDF_PAGES} of 45). The text extracted from it follows between the fences; its layout and images are not included.]\n` +
          '```\npage one words\n```'
      );
    });

    it("cuts a PDF's long text at the character cap, and says so", () => {
      const out = encodeDocumentBlocks(
        [doc('/u/r.pdf', 'application/pdf')],
        0,
        reader({ '/u/r.pdf': Buffer.from('%PDF') }),
        () => ({ text: 'y'.repeat(MAX_DOCUMENT_TEXT_CHARS + 1), pages: 1, total: 1 })
      );
      const text = out.blocks[0]!.text as string;
      expect(text).toContain('y'.repeat(MAX_DOCUMENT_TEXT_CHARS) + '\n```');
      expect(text).not.toContain('y'.repeat(MAX_DOCUMENT_TEXT_CHARS + 1));
      expect(
        text.endsWith('[The text was cut at 100,000 characters; the rest is not shown.]')
      ).toBe(true);
    });

    it('shares one extraction deadline across the turn, and names a PDF it had no time for', () => {
      let clock = 1_000;
      const given: number[] = [];
      const files = {
        '/u/a.pdf': Buffer.from('%PDF-a'),
        '/u/b.pdf': Buffer.from('%PDF-b'),
        '/u/c.pdf': Buffer.from('%PDF-c'),
      };
      const out = encodeDocumentBlocks(
        [
          doc('/u/a.pdf', 'application/pdf'),
          doc('/u/b.pdf', 'application/pdf'),
          doc('/u/c.pdf', 'application/pdf'),
        ],
        0,
        reader(files),
        (_b, _n, timeoutMs) => {
          given.push(timeoutMs);
          clock += 12_000; // each extraction takes 12 s of the turn
          return { text: 'words', pages: 1, total: 1 };
        },
        () => clock
      );
      expect(given).toEqual([PDF_EXTRACT_TIMEOUT_MS, PDF_EXTRACT_TIMEOUT_MS - 12_000]);
      expect(out.injected.map((m) => m.path)).toEqual(['/u/a.pdf', '/u/b.pdf']);
      expect(out.rejected.map((r) => [r.media.path, r.reason])).toEqual([
        ['/u/c.pdf', 'the time for reading attached files ran out'],
      ]);
    });

    it('says "2 pages" when it read the whole PDF', () => {
      const out = encodeDocumentBlocks(
        [doc('/u/r.pdf', 'application/pdf')],
        0,
        reader({ '/u/r.pdf': Buffer.from('%PDF') }),
        () => ({ text: 'words', pages: 2, total: 2 })
      );
      expect(out.blocks[0]!.text).toContain('(PDF, 2 pages)');
    });

    it('refuses a PDF it cannot parse, or one with no text, naming why', () => {
      const files = { '/u/a.pdf': Buffer.from('%PDF'), '/u/b.pdf': Buffer.from('%PDF') };
      const out = encodeDocumentBlocks(
        [
          doc('/u/a.pdf', 'application/pdf'),
          doc('/u/b.pdf', 'application/pdf'),
          doc('/u/c.pdf', 'application/pdf'),
        ],
        0,
        reader(files),
        (b) => (b === files['/u/a.pdf'] ? null : { text: ' \n\n ', pages: 3, total: 3 })
      );
      expect(out.rejected.map((r) => [r.media.path, r.reason])).toEqual([
        ['/u/a.pdf', 'its text could not be read as a PDF'],
        ['/u/b.pdf', 'no text could be extracted (it may hold only scanned images)'],
        ['/u/c.pdf', 'unreadable, not a regular file, or over size cap'],
      ]);
      expect(out.blocks).toEqual([]);
    });

    it('shares the request budget: what images used, and each block in turn', () => {
      const files = { '/u/a.txt': Buffer.from('a'.repeat(1000)), '/u/b.txt': Buffer.from('b') };
      const media = [doc('/u/a.txt', 'text/plain'), doc('/u/b.txt', 'text/plain')];
      const full = encodeDocumentBlocks(media, MAX_MEDIA_TOTAL_BYTES, reader(files), noPdf);
      expect(full.rejected.map((r) => r.reason)).toEqual([
        'turn media budget exhausted',
        'turn media budget exhausted',
      ]);
      // Room for the small block alone: the large one is refused, the small one shown.
      const small = encodeDocumentBlocks([media[1]!], 0, reader(files), noPdf);
      const tight = encodeDocumentBlocks(
        media,
        MAX_MEDIA_TOTAL_BYTES - small.totalBytes - 10,
        reader(files),
        noPdf
      );
      expect(tight.rejected.map((r) => [r.media.path, r.reason])).toEqual([
        ['/u/a.txt', 'turn media budget exhausted'],
      ]);
      expect(tight.injected.map((m) => m.path)).toEqual(['/u/b.txt']);
    });

    it('keeps the label to one line whatever the file name holds', () => {
      const name = '/u/a\nb\r.txt';
      const out = encodeDocumentBlocks(
        [doc(name, 'text/plain')],
        0,
        reader({ [name]: Buffer.from('x') }),
        noPdf
      );
      expect((out.blocks[0]!.text as string).split('\n')[0]).toBe(
        '[Attached file a?b?.txt (text/plain, 1 bytes). Its contents follow between the fences.]'
      );
    });
  });

  describe('extractPdfTextSync, the real child extraction', () => {
    it('reads the text of a real PDF', () => {
      const out = extractPdfTextSync(
        minimalPdf(['Hello from a PDF', 'Second line']),
        MAX_PDF_PAGES
      );
      expect(out).not.toBeNull();
      expect(out!.text).toContain('Hello from a PDF');
      expect(out!.text).toContain('Second line');
      expect(out!.total).toBe(1);
      expect(out!.pages).toBe(1);
    });

    it('brings back no more than one character past the cap, for the cut to be seen', () => {
      const line = 'Lorem ipsum dolor sit amet consectetur adipiscing elit';
      const lines = Array.from(
        { length: Math.ceil((MAX_DOCUMENT_TEXT_CHARS * 1.2) / line.length) },
        () => line
      );
      const out = extractPdfTextSync(minimalPdf(lines, 0.25), MAX_PDF_PAGES);
      expect(out).not.toBeNull();
      expect(out!.text.length).toBe(MAX_DOCUMENT_TEXT_CHARS + 1);
    });

    it('returns null for bytes that are not a PDF, never throwing', () => {
      expect(extractPdfTextSync(Buffer.from('%PDF-1.4 not really'), MAX_PDF_PAGES)).toBeNull();
      expect(extractPdfTextSync(Buffer.alloc(0), MAX_PDF_PAGES)).toBeNull();
    });

    it('kills a child that runs past its time, even one that ignores SIGTERM', async () => {
      // A controlled hanging child stands in for a PDF that stalls pdf.js: it
      // ignores SIGTERM, never answers, and leaves by itself after 15 s, so a
      // broken kill can't strand it.
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      const HANG = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 15000);";
      let signal: string | null = null;
      let options: Record<string, unknown> = {};
      vi.mocked(execFileSyncForTest).mockImplementationOnce(((
        file: string,
        _args: string[],
        opts: Record<string, unknown>
      ) => {
        options = opts;
        try {
          return actual.execFileSync(file, ['-e', HANG], opts);
        } catch (error) {
          signal = (error as { signal?: string }).signal ?? null;
          throw error;
        }
      }) as never);
      const started = Date.now();
      expect(extractPdfTextSync(minimalPdf(['never read']), 1, 300)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(signal).toBe('SIGKILL');
      expect(options).toMatchObject({ timeout: 300, killSignal: 'SIGKILL' });
    }, 30_000);

    it('waits 20 s by default', () => {
      const calls = vi.mocked(execFileSyncForTest).mock.calls.length;
      extractPdfTextSync(Buffer.from('%PDF-1.4 not really'), 1);
      const call = vi.mocked(execFileSyncForTest).mock.calls[calls]!;
      expect(PDF_EXTRACT_TIMEOUT_MS).toBe(20_000);
      expect(call[2]).toMatchObject({ timeout: PDF_EXTRACT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    });

    it('gives the child no environment of its own', () => {
      const leak = 'SYNTHETIC_DOC_PROBE_SECRET';
      vi.stubEnv(leak, 'should-not-reach-the-child');
      try {
        // Checked at the call: the child is this node binary, with an empty environment.
        const calls = vi.mocked(execFileSyncForTest).mock.calls.length;
        extractPdfTextSync(minimalPdf(['env check']), 1);
        const call = vi.mocked(execFileSyncForTest).mock.calls[calls]!;
        expect(call[0]).toBe(process.execPath);
        expect((call[2] as { env?: Record<string, string> }).env).toEqual({});
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('through prepare()', () => {
    let home: string;
    let uploadDir: string;

    beforeEach(() => {
      home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-documents-')));
      mkdirSync(join(home, '.ink', 'files'), { recursive: true });
      uploadDir = join(home, '.ink', 'uploads', 'u', 'w', 'up2');
      mkdirSync(uploadDir, { recursive: true });
      vi.stubEnv('HOME', home);
      vi.stubEnv('INK_STUDIOS_ROOT', join(home, '.ink', 'studios'));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });

    function prepare(extra: Record<string, unknown>) {
      return new ClaudeAdapter().prepare({
        sbSlug: 'kindle-0a1b2c3d',
        prompt: 'what did I send?',
        promptParts: ['what did I send?'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [uploadDir],
        ...extra,
      });
    }
    const toolsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === '--tools');
    const grantsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === '--add-dir');

    it('delivers a real PDF as its extracted text, with no tool and no grant', () => {
      const pdf = join(uploadDir, 'up2.pdf');
      writeFileSync(pdf, minimalPdf(['Quarterly numbers', 'are up']));
      const prepared = prepare({
        withholdProviderTools: true,
        media: [{ path: pdf, mimeType: 'application/pdf' }],
        deliverMedia: true,
      });
      try {
        expect(toolsOf(prepared.args)).toEqual(['']);
        expect(grantsOf(prepared.args)).toEqual([]);
        expect(prepared.args).toContain('--input-format');
        const line = JSON.parse(prepared.stdinData!.trim());
        const [text, document, ...rest] = line.message.content;
        expect(rest).toEqual([]);
        expect(text).toEqual({ type: 'text', text: 'what did I send?' });
        expect(document.text).toContain('[Attached file up2.pdf (PDF, 1 page).');
        expect(document.text).toContain('Quarterly numbers');
      } finally {
        prepared.cleanup();
      }
    });

    it('re-delivers on a reseed and a resumed delivery, and not on a continuation', () => {
      const txt = join(uploadDir, 'up2.txt');
      writeFileSync(txt, 'remember this');
      const media = [{ path: txt, mimeType: 'text/plain' }];
      for (const spawn of [
        { deliverMedia: true, backendSessionSeedId: 'seeded-provider-session' },
        { deliverMedia: true, backendSessionId: 'resumed-provider-session' },
      ]) {
        const prepared = prepare({ withholdProviderTools: true, media, ...spawn });
        try {
          expect(prepared.stdinData, JSON.stringify(spawn)).toContain('remember this');
          expect(toolsOf(prepared.args)).toEqual(['']);
        } finally {
          prepared.cleanup();
        }
      }
      const continuation = prepare({
        withholdProviderTools: true,
        media,
        backendSessionId: 'resumed-provider-session',
      });
      try {
        expect(continuation.stdinData).toBe('what did I send?');
        expect(toolsOf(continuation.args)).toEqual(['']);
        expect(grantsOf(continuation.args)).toEqual([]);
      } finally {
        continuation.cleanup();
      }
    });

    it('with attachment directories but no media (a later turn), shows and says nothing', () => {
      const prepared = prepare({ withholdProviderTools: true, deliverMedia: true });
      try {
        expect(prepared.stdinData).toBe('what did I send?');
        expect(toolsOf(prepared.args)).toEqual(['']);
        expect(grantsOf(prepared.args)).toEqual([]);
      } finally {
        prepared.cleanup();
      }
    });

    it('leaves a turn that is not withheld exactly as before: Read, grants, no document text', () => {
      const txt = join(uploadDir, 'up2.txt');
      writeFileSync(txt, 'not inlined here');
      const prepared = prepare({
        media: [{ path: txt, mimeType: 'text/plain' }],
        deliverMedia: true,
      });
      try {
        expect(toolsOf(prepared.args)).toEqual(['Read']);
        expect(grantsOf(prepared.args)).toContain(uploadDir);
        expect(prepared.args).not.toContain('--input-format');
        expect(prepared.stdinData).toBe('what did I send?');
      } finally {
        prepared.cleanup();
      }
    });

    it('refuses before reading any file when routing is not ink-owned', () => {
      const txt = join(uploadDir, 'up2.txt');
      writeFileSync(txt, 'x');
      const calls = vi.mocked(execFileSyncForTest).mock.calls.length;
      expect(() =>
        prepare({
          withholdProviderTools: true,
          toolRouting: 'backend',
          media: [{ path: join(uploadDir, 'up2.pdf'), mimeType: 'application/pdf' }],
          deliverMedia: true,
        })
      ).toThrow('withholdProviderTools requires ink-owned (local) tool routing');
      expect(vi.mocked(execFileSyncForTest).mock.calls.length).toBe(calls);
    });

    it("counts documents in the request budget before a tool's context images", () => {
      // Two 10 MiB photos leave exactly 5 MiB; a 5 MiB context image fits only
      // if the document beside them is not counted.
      const big = Buffer.alloc(MAX_MEDIA_FILE_BYTES, 1);
      const p1 = join(uploadDir, 'a.png');
      const p2 = join(uploadDir, 'b.png');
      writeFileSync(p1, big);
      writeFileSync(p2, big);
      const txt = join(uploadDir, 'note.txt');
      writeFileSync(txt, 'a short note');
      const context = join(home, 'ctx.png');
      writeFileSync(context, Buffer.alloc(MAX_MEDIA_TOTAL_BYTES - 2 * MAX_MEDIA_FILE_BYTES, 2));
      const prepared = prepare({
        withholdProviderTools: true,
        media: [
          { path: p1, mimeType: 'image/png' },
          { path: p2, mimeType: 'image/png' },
          { path: txt, mimeType: 'text/plain' },
        ],
        contextImages: [{ path: context, mimeType: 'image/png', ref: 'ctx' }],
        deliverMedia: true,
      });
      try {
        const line = JSON.parse(prepared.stdinData!.trim());
        const types = line.message.content.map((b: { type: string }) => b.type);
        expect(types).toEqual(['text', 'image', 'image', 'text']);
        expect(line.message.content[0].text).toContain('[image note]');
        expect(prepared.contextImagesDelivered).toBeUndefined();
      } finally {
        prepared.cleanup();
      }
    });
  });
});
