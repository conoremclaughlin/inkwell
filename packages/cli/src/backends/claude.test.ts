import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ClaudeAdapter,
  classifyMedia,
  encodeMediaBlocks,
  readMediaBounded,
  MAX_MEDIA_FILE_BYTES,
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
      agentId: 'myra',
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

  it('local routing exposes native Read ONLY for attachment-bearing sessions (named exception)', () => {
    // The multimodal render path: --attach-file media is read natively
    // (images cannot flow through ink-block tools). This is a documented
    // exception to wholly-in-ink, not the default.
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'wren',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
      agentId: 'myra',
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
