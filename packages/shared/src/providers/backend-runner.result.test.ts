import { describe, expect, it, vi } from 'vitest';
import type { BackendHost } from './types.js';
import type { BackendTurnEvent } from './stream.js';

const state = vi.hoisted(() => ({ events: [] as BackendTurnEvent[], exitCode: 0 }));
vi.mock('./registry.js', () => ({
  getBackend: () => ({
    prepare: () => ({ binary: 'synthetic-provider', args: [], env: {}, cleanup: () => {} }),
    createStreamParser: () => ({ push: () => [], end: () => state.events }),
  }),
}));
vi.mock('../runner/spawn-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner/spawn-backend.js')>()),
  spawnBackend: () => ({
    child: { kill: vi.fn() },
    result: Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: state.exitCode,
      durationMs: 1,
      childExited: true,
    }),
  }),
}));
vi.mock('child_process', () => ({
  spawn: () => {
    throw new Error('Unexpected real process launch');
  },
}));
import { runBackendTurn } from './backend-runner.js';

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
  resolveBinary: async () => 'synthetic-provider',
  warn: () => undefined,
};

// Exercise the provider-neutral dispatch contract under Claude's backend name.
// ClaudeStreamParser's own assembly policy remains covered separately.
describe('stream result semantics across backends', () => {
  it('keeps an explicit empty final result rather than earlier progress', async () => {
    state.events = [
      { kind: 'text', text: 'progress' },
      { kind: 'result', text: '' },
    ];
    state.exitCode = 0;
    const result = await runBackendTurn({
      backend: 'claude',
      sbSlug: 'synthetic-sb',
      prompt: 'hello',
      stream: true,
      cliAttached: false,
      workingDirectory: '/synthetic/studio',
      inkSessionId: undefined,
      studioId: undefined,
      host,
    });
    expect(result.success).toBe(true);
    expect(result.responseText).toBe('');
  });

  it('still falls back to completed text when the parser has no final text', async () => {
    state.events = [{ kind: 'text', text: 'answer' }, { kind: 'result' }];
    state.exitCode = 0;
    const result = await runBackendTurn({
      backend: 'claude',
      sbSlug: 'synthetic-sb',
      prompt: 'hello',
      stream: true,
      cliAttached: false,
      workingDirectory: '/synthetic/studio',
      inkSessionId: undefined,
      studioId: undefined,
      host,
    });
    expect(result.success).toBe(true);
    expect(result.responseText).toBe('answer');
  });

  it('retains terminal errors and nonzero child exits independently', async () => {
    state.events = [{ kind: 'result', text: '', error: 'synthetic terminal error' }];
    for (const exitCode of [0, 7]) {
      state.exitCode = exitCode;
      const result = await runBackendTurn({
        backend: 'claude',
        sbSlug: 'synthetic-sb',
        prompt: 'hello',
        stream: true,
        cliAttached: false,
        workingDirectory: '/synthetic/studio',
        inkSessionId: undefined,
        studioId: undefined,
        host,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(exitCode || 1);
      expect(result.stderr).toBe('synthetic terminal error');
    }
  });
});
