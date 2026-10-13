/** Real async adapters, synthetic directories, and no parser/provider processes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BackendConfig, BackendHost } from './types.js';

const extract = vi.hoisted(() =>
  vi.fn(async () => ({ text: 'synthetic PDF text', pages: 1, total: 1 }))
);
vi.mock('./pdf-extractor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdf-extractor.js')>()),
  extractPdfText: extract,
}));
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { acceptsContextImagesFor } from './registry.js';

let root: string;
let host: BackendHost;
let config: BackendConfig;
const flagValues = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'withheld-provider-fixture-'));
  await mkdir(join(root, 'files'));
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        arbitrary: { command: '/synthetic/not-run' },
      },
    })
  );
  await writeFile(join(root, 'photo.png'), Buffer.from('synthetic-image'));
  await writeFile(join(root, 'doc.pdf'), Buffer.from('%PDF-synthetic'));
  await writeFile(join(root, 'notes.txt'), 'synthetic text');
  host = {
    paths: { inkFiles: join(root, 'files'), studiosRoot: join(root, 'studios'), tempDir: root },
    ambientSession: vi.fn(() => ({})),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: vi.fn(async () => []),
    sessionEnv: async () => ({}),
    baseEnv: async () => ({ HOME: root }),
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    resolveBinary: async () => {
      throw new Error('must not spawn');
    },
    warn: vi.fn(),
  };
  config = {
    sbSlug: 'synthetic',
    cliAttached: false,
    cwd: root,
    explicitSession: true,
    prompt: 'show this',
    promptParts: [],
    passthroughArgs: [],
    toolRouting: 'local',
    attachmentDirs: [root],
    withholdProviderTools: true,
  };
  extract.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('withheld adapters with fake PDF extraction', () => {
  it('keeps tools and every grant closed for all media and delivery/resume/reseed shapes', async () => {
    const image = { path: join(root, 'photo.png'), mimeType: 'image/png' };
    const pdf = { path: join(root, 'doc.pdf'), mimeType: 'application/pdf' };
    const text = { path: join(root, 'notes.txt'), mimeType: 'text/plain' };
    for (const media of [[], [image], [pdf], [text], [image, pdf, text]]) {
      for (const spawn of [
        { deliverMedia: true },
        { deliverMedia: true, backendSessionSeedId: 'seed' },
        { deliverMedia: true, backendSessionId: 'resume' },
        { backendSessionId: 'resume' },
      ]) {
        const prepared = await new ClaudeAdapter().prepare({ ...config, media, ...spawn }, host);
        try {
          expect(flagValues(prepared.args, '--tools')).toEqual(['']);
          expect(flagValues(prepared.args, '--add-dir')).toEqual([]);
          expect(prepared.args).toContain('--strict-mcp-config');
          const mcpPath = flagValues(prepared.args, '--mcp-config')[0]!;
          expect(JSON.parse(await readFile(mcpPath, 'utf8')).mcpServers).toEqual({});
          if (media.includes(pdf) && spawn.deliverMedia)
            expect(prepared.stdinData).toContain('synthetic PDF text');
          if (!spawn.deliverMedia) expect(prepared.stdinData).toBe('show this');
        } finally {
          await prepared.cleanup();
        }
      }
    }
    expect(host.skillMcpServers).not.toHaveBeenCalled();
    expect(
      await stat(host.paths.studiosRoot).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it('drops adversarial trailing flags at the adapter too', async () => {
    const prepared = await new ClaudeAdapter().prepare(
      {
        ...config,
        passthroughArgs: [
          '--tools',
          'Bash,Read',
          '--add-dir',
          '/',
          '--mcp-config',
          '/synthetic/reopen',
          '--dangerously-skip-permissions',
        ],
      },
      host
    );
    try {
      expect(flagValues(prepared.args, '--tools')).toEqual(['']);
      expect(flagValues(prepared.args, '--add-dir')).toEqual([]);
      expect(flagValues(prepared.args, '--mcp-config')).toHaveLength(1);
      expect(prepared.args).not.toContain('/synthetic/reopen');
      expect(prepared.args).not.toContain('--dangerously-skip-permissions');
    } finally {
      await prepared.cleanup();
    }
  });

  it('refuses incoherent routing before host callbacks, reads or parser calls', async () => {
    for (const toolRouting of ['backend', undefined] as const) {
      await expect(
        new ClaudeAdapter().prepare(
          {
            ...config,
            toolRouting,
            explicitSession: false,
            deliverMedia: true,
            media: [{ path: join(root, 'doc.pdf'), mimeType: 'application/pdf' }],
          },
          host
        )
      ).rejects.toThrow('withholdProviderTools requires ink-owned');
    }
    expect(host.ambientSession).not.toHaveBeenCalled();
    expect(host.skillMcpServers).not.toHaveBeenCalled();
    expect(host.warn).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it('also refuses unsupported direct-adapter calls before any preparation', async () => {
    for (const adapter of [new CodexAdapter(), new GeminiAdapter()]) {
      await expect(adapter.prepare(config, host)).rejects.toThrow("can't withhold its own tools");
    }
    expect(host.skillMcpServers).not.toHaveBeenCalled();
    expect(
      await stat(host.paths.studiosRoot).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it('captures only for declared image-capable providers, and fails closed for unknown keys', () => {
    expect(acceptsContextImagesFor('claude')).toBe(true);
    expect(acceptsContextImagesFor('codex')).toBe(true);
    for (const backend of ['gemini', 'unknown', '__proto__', 'toString']) {
      expect(acceptsContextImagesFor(backend)).toBe(false);
    }
  });

  it('codex reports image delivery only when the exec input actually carries the flags', async () => {
    const image = { path: join(root, 'photo.png'), mimeType: 'image/png' };
    for (const promptParts of [
      ['exec', '--dash-leading prompt'],
      ['mcp', 'list'],
    ]) {
      const prepared = await new CodexAdapter().prepare(
        {
          ...config,
          withholdProviderTools: false,
          promptParts,
          contextImages: [image],
        },
        host
      );
      try {
        if (promptParts[0] === 'exec') {
          expect(prepared.contextImagesDelivered).toEqual([image]);
          expect(prepared.args.slice(-3)).toEqual([
            `--image=${image.path}`,
            '--',
            '--dash-leading prompt',
          ]);
        } else {
          expect(prepared.contextImagesDelivered).toBeUndefined();
          expect(prepared.args.some((arg) => arg.startsWith('--image='))).toBe(false);
        }
      } finally {
        await prepared.cleanup();
      }
    }
  });
});
