import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { decodeContextToken, PRINT_MODE_CHANNEL_ENV } from '../runner/mcp-config.js';
import {
  ClaudeAdapter,
  classifyMedia,
  encodeMediaBlocks,
  readMediaBounded,
  MAX_MEDIA_FILE_BYTES,
} from './claude.js';
import type { BackendHost } from './types.js';

// The host's directories live in a temp root, so no case touches the real
// ~/.ink. It discovers no skills and runs no `claude --help` probe.
const hostRoot = mkdtempSync(join(tmpdir(), 'claude-host-'));
afterAll(() => rmSync(hostRoot, { recursive: true, force: true }));

function testHost(overrides: Partial<BackendHost> = {}): BackendHost {
  return {
    paths: {
      inkFiles: join(hostRoot, 'files'),
      studiosRoot: join(hostRoot, 'studios'),
      tempDir: hostRoot,
    },
    ambientSession: () => ({}),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    sessionEnv: async () => ({}),
    resolveBinary: async (name) => name,
    warn: () => undefined,
    ...overrides,
  };
}

let host = testHost();
beforeEach(() => {
  host = testHost();
});

/** A launcher's config: the directory each case changed into, attached. */
function adapterDefaults() {
  return { cwd: process.cwd(), cliAttached: true };
}

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

  it("ink-owned routing ('local') withholds tool servers AND built-ins, pinning the config strictly", async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
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

  it('threads a per-SB effort to the claude CLI, and sends none when unset (task 7ea6cdf7)', async () => {
    const adapter = new ClaudeAdapter();
    const withEffort = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
        effort: 'xhigh',
      },
      host
    );
    try {
      const idx = withEffort.args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(withEffort.args[idx + 1]).toBe('xhigh');
    } finally {
      withEffort.cleanup();
    }
    const without = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
    try {
      expect(without.args).not.toContain('--effort');
    } finally {
      without.cleanup();
    }
  });

  it('local routing exposes native Read ONLY for attachment-bearing sessions (named exception)', async () => {
    // The multimodal render path: --attach-file media is read natively
    // (images cannot flow through ink-block tools). This is a documented
    // exception to wholly-in-ink, not the default.
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'what is in this image?',
        promptParts: ['what is in this image?'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [tmpDir],
      },
      host
    );
    try {
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('Read');
      expect(prepared.args).toContain('--strict-mcp-config');
    } finally {
      prepared.cleanup();
    }
  });

  it('an adversarial inkmail entry is replaced by the constructed canonical entry', async () => {
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
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
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

  it('a declared inkmail with no resolvable plugin yields no bridge and no channel flag', async () => {
    // Channel loading keys off the RETAINED entry, never the raw project
    // file — claude must not be asked to load `server:inkmail` from a strict
    // config that does not define it.
    rmSync(join(tmpDir, 'packages'), { recursive: true, force: true });
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
    try {
      expect(mcpConfigFrom(prepared.args)).toEqual({});
      expect(prepared.args).not.toContain('--dangerously-load-development-channels');
    } finally {
      prepared.cleanup();
    }
  });

  it('provider-owned routing (undefined/backend) passes the full config, no strict flag', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'wren',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
      },
      host
    );
    try {
      expect(prepared.args).not.toContain('--strict-mcp-config');
      expect(prepared.args).not.toContain('--tools');
      const servers = mcpConfigFrom(prepared.args);
      expect(Object.keys(servers).sort()).toEqual(['github', 'inkmail', 'inkwell']);
    } finally {
      prepared.cleanup();
    }
  });

  // A launcher's MCP headers fall back to the session it runs in, which its
  // host names; a spawn that named its own session (startBackendTurn's
  // always do) never consults it, even to fill an id it left undefined.
  it('routes a launcher by its host’s ambient session, and an explicit spawn never', async () => {
    // Blank in the process env, so only the host can supply them.
    vi.stubEnv('INK_SESSION_ID', '');
    vi.stubEnv('INK_STUDIO_ID', '');
    host = testHost({
      ambientSession: () => ({ inkSessionId: 'ambient-session', studioId: 'ambient-studio' }),
    });
    const config = {
      ...adapterDefaults(),
      sbSlug: 'wren',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
    };
    const launcher = await new ClaudeAdapter().prepare(config, host);
    const explicit = await new ClaudeAdapter().prepare({ ...config, explicitSession: true }, host);
    const headersOf = (args: string[]) =>
      (mcpConfigFrom(args).inkwell as { headers: Record<string, string> }).headers;
    try {
      expect(headersOf(launcher.args)).toMatchObject({
        'x-ink-session-id': '${INK_SESSION_ID}',
        'x-ink-studio-id': '${INK_STUDIO_ID}',
      });
      expect(headersOf(explicit.args)['x-ink-session-id']).toBeUndefined();
      expect(headersOf(explicit.args)['x-ink-studio-id']).toBeUndefined();
    } finally {
      launcher.cleanup();
      explicit.cleanup();
      vi.unstubAllEnvs();
    }
  });

  // Hosted parity for skills is the host's: whatever it discovers reaches the
  // provider's config, and under local routing it is not asked at all
  // (Myra's surviving `skillServers: []` mutant, P2b-2a review).
  it('merges the skill servers its host discovers, and asks for none under local routing', async () => {
    const skillMcpServers = vi.fn(async () => [
      { name: 'synthetic-skill', command: 'npx', args: ['synthetic-skill-server'] },
    ]);
    host = testHost({ skillMcpServers });
    const config = {
      ...adapterDefaults(),
      sbSlug: 'wren',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
    };

    const provider = await new ClaudeAdapter().prepare(config, host);
    try {
      expect(skillMcpServers).toHaveBeenCalledWith(config.cwd);
      expect(mcpConfigFrom(provider.args)).toMatchObject({
        'synthetic-skill': { command: 'npx', args: ['synthetic-skill-server'] },
      });
    } finally {
      provider.cleanup();
    }

    skillMcpServers.mockClear();
    const local = await new ClaudeAdapter().prepare({ ...config, toolRouting: 'local' }, host);
    try {
      expect(skillMcpServers).not.toHaveBeenCalled();
      expect(mcpConfigFrom(local.args)).not.toHaveProperty('synthetic-skill');
    } finally {
      local.cleanup();
    }
  });

  it('writes its MCP config under the host’s temp directory, and its cleanup removes it', async () => {
    const prepared = await new ClaudeAdapter().prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'wren',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
    const path = prepared.args[prepared.args.indexOf('--mcp-config') + 1]!;
    expect(path.startsWith(join(host.paths.tempDir, 'sb-mcp'))).toBe(true);
    expect(existsSync(path)).toBe(true);
    await prepared.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('removes its MCP config when a later host call fails', async () => {
    const sbMcp = join(host.paths.tempDir, 'sb-mcp');
    const before = existsSync(sbMcp) ? readdirSync(sbMcp) : [];
    host = testHost({
      claudeSupportsPartialMessages: async () => {
        throw new Error('synthetic probe failure');
      },
    });
    await expect(
      new ClaudeAdapter().prepare(
        {
          ...adapterDefaults(),
          sbSlug: 'wren',
          prompt: 'hello',
          promptParts: ['hello'],
          passthroughArgs: [],
          toolRouting: 'local',
          stream: true,
        },
        host
      )
    ).rejects.toThrow('synthetic probe failure');
    // Only new files count: other cases' unawaited cleanups may still be
    // removing theirs.
    const after = existsSync(sbMcp) ? readdirSync(sbMcp) : [];
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
  });

  it('asks its host whether claude streams partial messages', async () => {
    for (const supported of [true, false]) {
      host = testHost({ claudeSupportsPartialMessages: async () => supported });
      const prepared = await new ClaudeAdapter().prepare(
        {
          ...adapterDefaults(),
          sbSlug: 'wren',
          prompt: 'hello',
          promptParts: ['hello'],
          passthroughArgs: [],
          stream: true,
        },
        host
      );
      try {
        expect(prepared.args.includes('--include-partial-messages')).toBe(supported);
      } finally {
        prepared.cleanup();
      }
    }
  });

  it('grants the host’s studios root, created, and its media directory when it exists', async () => {
    const config = {
      ...adapterDefaults(),
      sbSlug: 'wren',
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
    };
    const grants = (args: string[]) =>
      args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1]] : []));

    rmSync(host.paths.inkFiles, { recursive: true, force: true });
    const without = await new ClaudeAdapter().prepare(config, host);
    mkdirSync(host.paths.inkFiles, { recursive: true });
    const withFiles = await new ClaudeAdapter().prepare(config, host);
    try {
      expect(grants(without.args)).toEqual([host.paths.studiosRoot]);
      expect(existsSync(host.paths.studiosRoot)).toBe(true);
      expect(grants(withFiles.args)).toEqual([host.paths.inkFiles, host.paths.studiosRoot]);
    } finally {
      without.cleanup();
      withFiles.cleanup();
    }
  });

  // Task 2f892701: `-p` cannot show a channel notification, and both routings
  // can still load the inkmail plugin (local keeps the bridge; backend is not
  // strict). Every print-mode spawn must tell the plugin to stay inert, and an
  // interactive one must not, or live CLIs lose channel delivery.
  it('declares print mode to the channel plugin on every -p spawn, and only there', async () => {
    const adapter = new ClaudeAdapter();
    for (const toolRouting of ['local', undefined] as const) {
      const printed = await adapter.prepare(
        {
          ...adapterDefaults(),
          sbSlug: 'myra',
          prompt: 'hello',
          promptParts: ['hello'],
          passthroughArgs: [],
          ...(toolRouting ? { toolRouting } : {}),
        },
        host
      );
      try {
        expect(printed.args).toContain('-p');
        expect(printed.env).toMatchObject(PRINT_MODE_CHANNEL_ENV);
      } finally {
        printed.cleanup();
      }
    }

    const interactive = await adapter.prepare(
      { ...adapterDefaults(), sbSlug: 'wren', prompt: '', promptParts: [], passthroughArgs: [] },
      host
    );
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
    async (passthroughArgs) => {
      const prepared = await new ClaudeAdapter().prepare(
        {
          ...adapterDefaults(),
          sbSlug: 'wren',
          promptParts: [],
          passthroughArgs: [...passthroughArgs],
        },
        host
      );
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
  // headless run's children declare themselves unattached. There is no
  // default any more: a human's one-shot `ink "…"` launcher passes true,
  // since an attached prompt is what claims the turn epoch and renews the
  // studio lease.
  it('keeps print-mode attachment the spawner’s call, and the plugin inert either way', async () => {
    const adapter = new ClaudeAdapter();
    for (const cliAttached of [true, false]) {
      const prepared = await adapter.prepare(
        {
          ...adapterDefaults(),
          sbSlug: 'myra',
          prompt: 'hello',
          promptParts: ['hello'],
          passthroughArgs: [],
          cliAttached,
        },
        host
      );
      try {
        expect(decodeContextToken(prepared.env.INK_CONTEXT)?.cliAttached).toBe(cliAttached);
        expect(prepared.env).toMatchObject(PRINT_MODE_CHANNEL_ENV);
      } finally {
        prepared.cleanup();
      }
    }

    const interactive = await adapter.prepare(
      { ...adapterDefaults(), sbSlug: 'wren', promptParts: [], passthroughArgs: [] },
      host
    );
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

  it('rejects unreadable and over-cap candidates instead of falling back', async () => {
    const out = await encodeMediaBlocks(
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

  it('enforces the running total cap across files', async () => {
    const nineMb = 9 * 1024 * 1024;
    const out = await encodeMediaBlocks(
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

  it('reads a regular file fully within the cap', async () => {
    const p = join(dir, 'f.bin');
    writeFileSync(p, Buffer.alloc(1024, 7));
    const buf = await readMediaBounded(p, 2048);
    expect(buf?.byteLength).toBe(1024);
    expect(buf?.every((b) => b === 7)).toBe(true);
  });

  it('returns null for oversize, missing, and non-regular paths', async () => {
    const p = join(dir, 'f.bin');
    writeFileSync(p, Buffer.alloc(1024, 7));
    expect(await readMediaBounded(p, 1023)).toBeNull();
    expect(await readMediaBounded(join(dir, 'nope.bin'), 4096)).toBeNull();
    // A directory is not a regular file.
    expect(await readMediaBounded(dir, 4096)).toBeNull();
  });

  it(
    'a FIFO is rejected without blocking — verified in a killable child',
    { timeout: 20000 },
    () => {
      // Opening a FIFO for read normally BLOCKS until a writer appears — a
      // hostile/accidental media path must not hang the spawn (Lumen, review
      // 4900202375). An in-worker vitest timeout cannot guard this: a
      // blocking open holds the worker (review 4900276464). So the REAL
      // readMediaBounded runs in a child process with an external kill
      // timeout — an O_NONBLOCK regression hangs the CHILD, the timeout
      // SIGKILLs it, and the assertion fails instead of the suite wedging.
      //
      // The child is ONE node process, with tsx as an import loader. Through
      // `npx tsx` the timeout reached only the outermost process, while the
      // node grandchild stayed blocked in open() holding the output pipe,
      // so the run hung instead of failing (measured with the O_NONBLOCK
      // mutant, #701 P2b-2b part 3).
      const p = join(dir, 'pipe.fifo');
      execSync(`mkfifo ${JSON.stringify(p)}`);
      const moduleUrl = new URL('./claude.ts', import.meta.url).href;
      const script =
        `import(${JSON.stringify(moduleUrl)})` +
        `.then(async (m) => console.log(JSON.stringify(await m.readMediaBounded(${JSON.stringify(p)}, 4096))))`;
      const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        timeout: 15000,
        killSignal: 'SIGKILL',
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

  it('fully-injected media: stream-json stdin envelope, --tools stays empty', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'what is in this image?',
        promptParts: ['what is in this image?'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [tmpDir],
        media: [{ path: pngPath, mimeType: 'image/png' }],
        deliverMedia: true,
      },
      host
    );
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

  it('partially-injected media keeps the gated Read fallback for the rest', async () => {
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, 'not really a pdf');
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
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
      },
      host
    );
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

  it('text-only turns keep the plain stdin path', async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'hello',
        promptParts: ['hello'],
        passthroughArgs: [],
        toolRouting: 'local',
      },
      host
    );
    try {
      expect(prepared.args).not.toContain('--input-format');
      expect(prepared.stdinData).toBe('hello');
    } finally {
      prepared.cleanup();
    }
  });

  it('resume spawns keep the delivery disposition: no re-embed, --tools stays empty', async () => {
    // Lumen's round-1 repro (review 4900120086): a tool-loop continuation
    // resumes the provider session that already holds the injected image.
    // It must NOT reopen native Read — the boundary decision derives from
    // the same mime classification as the delivery spawn.
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'continue',
        promptParts: ['continue'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [tmpDir],
        media: [{ path: pngPath, mimeType: 'image/png' }],
        backendSessionId: 'live-session-abc',
      },
      host
    );
    try {
      expect(prepared.args).not.toContain('--input-format');
      expect(prepared.stdinData).toBe('continue');
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');
    } finally {
      prepared.cleanup();
    }
  });

  it('injection failure fails CLOSED and the rejection rides the prompt itself', async () => {
    // A supported image that cannot be read (missing file) is rejected —
    // it neither injects nor reopens the native-read exception. And because
    // stderr is invisible on successful headless runs, the note is embedded
    // in the provider input so the user hears about it.
    const adapter = new ClaudeAdapter();
    // Through the host, which is where a server would log it.
    const warn = vi.fn();
    host = testHost({ warn });
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'look at this',
        promptParts: ['look at this'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [tmpDir],
        media: [{ path: join(tmpDir, 'vanished.png'), mimeType: 'image/png' }],
        deliverMedia: true,
      },
      host
    );
    try {
      expect(prepared.args).not.toContain('--input-format');
      const toolsIdx = prepared.args.indexOf('--tools');
      expect(prepared.args[toolsIdx + 1]).toBe('');
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0])).toContain('vanished.png');
      expect(prepared.stdinData).toContain('[media note]');
      expect(prepared.stdinData).toContain('vanished.png');
    } finally {
      prepared.cleanup();
    }
  });

  it('new media on a RESUMED conversation embeds when marked as delivery', async () => {
    // Lumen's round-2 repro (review 4900202375): a server heartbeat or
    // reattach can recover an existing provider session AND deliver brand
    // new media in the same spawn. backendSessionId alone must not suppress
    // embedding — deliverMedia is the explicit signal.
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(
      {
        ...adapterDefaults(),
        sbSlug: 'myra',
        prompt: 'here is a new photo',
        promptParts: ['here is a new photo'],
        passthroughArgs: [],
        toolRouting: 'local',
        attachmentDirs: [tmpDir],
        media: [{ path: pngPath, mimeType: 'image/png' }],
        deliverMedia: true,
        backendSessionId: 'recovered-session-xyz',
      },
      host
    );
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
