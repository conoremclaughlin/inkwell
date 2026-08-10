import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ClaudeAdapter,
  planMediaInjection,
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

describe('planMediaInjection (mime + size policy)', () => {
  const sizes = (map: Record<string, number | null>) => (path: string) => map[path] ?? null;

  it('injects supported images, falls back non-images and unknown mimes', () => {
    const plan = planMediaInjection(
      [
        { path: '/a.png', mimeType: 'image/png' },
        { path: '/b.pdf', mimeType: 'application/pdf' },
        { path: '/c.heic', mimeType: 'image/heic' },
        { path: '/d.bin' },
      ],
      sizes({ '/a.png': 1000 })
    );
    expect(plan.inject.map((m) => m.path)).toEqual(['/a.png']);
    expect(plan.fallback.map((m) => m.path)).toEqual(['/b.pdf', '/c.heic', '/d.bin']);
  });

  it('falls back oversize files and unstatable files', () => {
    const plan = planMediaInjection(
      [
        { path: '/big.png', mimeType: 'image/png' },
        { path: '/gone.png', mimeType: 'image/png' },
        { path: '/ok.png', mimeType: 'image/png' },
      ],
      sizes({ '/big.png': MAX_MEDIA_FILE_BYTES + 1, '/gone.png': null, '/ok.png': 10 })
    );
    expect(plan.inject.map((m) => m.path)).toEqual(['/ok.png']);
    expect(plan.fallback.map((m) => m.path)).toEqual(['/big.png', '/gone.png']);
  });

  it('enforces the running total cap across files', () => {
    // Each file passes the per-file cap; the third breaches the turn total.
    const nineMb = 9 * 1024 * 1024;
    expect(nineMb).toBeLessThan(MAX_MEDIA_FILE_BYTES);
    const plan = planMediaInjection(
      [
        { path: '/one.png', mimeType: 'image/png' },
        { path: '/two.png', mimeType: 'image/png' },
        { path: '/three.png', mimeType: 'image/png' },
      ],
      sizes({ '/one.png': nineMb, '/two.png': nineMb, '/three.png': nineMb })
    );
    expect(plan.inject.map((m) => m.path)).toEqual(['/one.png', '/two.png']);
    expect(plan.fallback.map((m) => m.path)).toEqual(['/three.png']);
  });
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
    expect(adapter.injectsMedia).toBe(true);
    const prepared = adapter.prepare({
      agentId: 'myra',
      prompt: 'what is in this image?',
      promptParts: ['what is in this image?'],
      passthroughArgs: [],
      toolRouting: 'local',
      attachmentDirs: [tmpDir],
      media: [{ path: pngPath, mimeType: 'image/png' }],
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
});
