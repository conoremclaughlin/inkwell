import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from './codex.js';

vi.mock('./identity-prompt.js', () => ({
  createIdentityPromptFile: () => ({ promptFile: '/synthetic/identity.txt', cleanup: () => {} }),
}));

import type { BackendConfig, BackendHost } from './types.js';
vi.mock('fs/promises', () => ({ mkdir: async () => undefined }));
vi.mock('child_process', () => ({
  execFile: () => {
    throw new Error('Unexpected provider probe');
  },
}));
const host: BackendHost = {
  paths: {
    inkFiles: '/synthetic/files',
    studiosRoot: '/synthetic/studios',
    tempDir: '/synthetic/tmp',
  },
  ambientSession: () => ({}),
  claudeSupportsPartialMessages: async () => false,
  skillMcpServers: async () => [],
  sessionEnv: async () => ({}),
  baseEnv: async () => ({}),
  inkwellMcpUrl: 'http://127.0.0.1:9/mcp',
  resolveBinary: async () => {
    throw new Error('Unexpected binary lookup');
  },
  warn: () => undefined,
};
const prepare = (config: Omit<BackendConfig, 'cwd'>) =>
  new CodexAdapter().prepare({ ...config, cwd: '/synthetic/studio' }, host);

// Preparation only: no provider process, login or session lookup occurs.
describe('Codex non-interactive resume argument scope', () => {
  it('uses exec resume, not interactive resume followed by an exec positional', async () => {
    const prepared = await prepare({
      sbSlug: 'synthetic-sb',
      promptParts: ['exec', 'continue'],
      cliAttached: false,
      passthroughArgs: ['--sandbox', 'read-only', '--skip-git-repo-check'],
      backendSessionId: 'synthetic-session',
      stream: true,
    });
    try {
      expect(prepared.args.slice(prepared.args.indexOf('exec'))).toEqual([
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        'resume',
        '--',
        'synthetic-session',
        'continue',
      ]);
      expect(prepared.args.filter((arg) => arg === 'resume')).toHaveLength(1);
      expect(prepared.args.indexOf('exec')).toBeLessThan(prepared.args.indexOf('resume'));
    } finally {
      await prepared.cleanup();
    }
  });

  it('puts follow-up images after resume and protects session and prompt positionals', async () => {
    const prepared = await prepare({
      sbSlug: 'synthetic-sb',
      promptParts: ['exec', '--not-a-real-option'],
      cliAttached: false,
      passthroughArgs: ['--color', 'never', '--'],
      backendSessionId: 'synthetic-session',
      media: [{ path: '/synthetic/attachment.png', mimeType: 'image/png' }],
      contextImages: [{ path: '/synthetic/tool.png', mimeType: 'image/png' }],
    });
    try {
      expect(prepared.args.slice(prepared.args.indexOf('exec'))).toEqual([
        'exec',
        '--color',
        'never',
        'resume',
        '--image=/synthetic/attachment.png',
        '--image=/synthetic/tool.png',
        '--',
        'synthetic-session',
        '--not-a-real-option',
      ]);
      expect(prepared.contextImagesDelivered).toEqual([
        { path: '/synthetic/tool.png', mimeType: 'image/png' },
      ]);
    } finally {
      await prepared.cleanup();
    }
  });

  it('protects dash-leading prompts and places image flags before the terminator on fresh exec', async () => {
    for (const media of [[], [{ path: '/synthetic/fresh.png', mimeType: 'image/png' }]]) {
      const prepared = await prepare({
        sbSlug: 'synthetic-sb',
        promptParts: ['exec', '--not-a-real-option'],
        cliAttached: false,
        passthroughArgs: ['--color', 'never', '--'],
        media,
        stream: true,
      });
      try {
        expect(prepared.args.slice(prepared.args.indexOf('exec'))).toEqual([
          'exec',
          '--json',
          '--color',
          'never',
          ...media.map((m) => `--image=${m.path}`),
          '--',
          '--not-a-real-option',
        ]);
      } finally {
        await prepared.cleanup();
      }
    }
  });

  it('inserts its own terminator for a fresh media-free dash-leading prompt', async () => {
    const prepared = await prepare({
      sbSlug: 'synthetic-sb',
      promptParts: ['exec', '--not-a-real-option'],
      passthroughArgs: [],
      cliAttached: false,
    });
    try {
      expect(prepared.args.slice(-3)).toEqual(['exec', '--', '--not-a-real-option']);
    } finally {
      await prepared.cleanup();
    }
  });

  it('keeps the interactive resume contract unchanged', async () => {
    const prepared = await prepare({
      sbSlug: 'synthetic-sb',
      promptParts: ['continue'],
      cliAttached: true,
      passthroughArgs: [],
      backendSessionId: 'synthetic-session',
    });
    try {
      expect(prepared.args.slice(0, 2)).toEqual(['resume', 'synthetic-session']);
      expect(prepared.args).not.toContain('exec');
      expect(prepared.args).not.toContain('--json');
      expect(prepared.args.at(-1)).toBe('continue');
    } finally {
      await prepared.cleanup();
    }
  });
});

describe('Codex stream preparation', () => {
  it('requests JSON only for streaming exec, leaving interactive and buffered modes alone', async () => {
    for (const [promptParts, stream, json] of [
      [['exec', 'hello'], true, true],
      [['exec', 'hello'], false, false],
      [['hello'], true, false],
    ] as const) {
      const prepared = await prepare({
        sbSlug: 'synthetic-sb',
        promptParts: [...promptParts],
        cliAttached: promptParts[0] !== 'exec',
        passthroughArgs: [],
        stream,
      });
      expect(prepared.args.includes('--json')).toBe(json);
      if (json)
        expect(prepared.args.indexOf('--json')).toBeGreaterThan(prepared.args.indexOf('exec'));
      await prepared.cleanup();
    }
  });
});
