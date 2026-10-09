/** Actual CLI command dispatch with inert providers/network and an owned policy directory. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BackendRunRequest } from '@inklabs/shared/providers';
import type { DiscoveredSkill } from '../repl/skills.js';

const fixture = vi.hoisted(() => ({
  inputs: [] as string[],
  requests: [] as BackendRunRequest[],
  load: vi.fn(),
  onSpawn: undefined as (() => void) | undefined,
  beforeClear: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../backends/identity.js', async (original) => ({
  ...(await original<typeof import('../backends/identity.js')>()),
  resolveSlug: () => 'echo',
  readIdentityJson: () => ({ studioId: 'fixture-studio' }),
}));
vi.mock('../lib/ink-client.js', () => ({
  InkClient: class {
    async callTool(name: string) {
      if (name === 'bootstrap')
        return { user: { timezone: 'America/Los_Angeles' }, identityFiles: { soul: 'Fixture' } };
      if (name === 'get_inbox') return { messages: [] };
      if (name === 'recall') return { success: true, memories: [] };
      if (name === 'list_sessions') return { sessions: [] };
      return { success: true };
    }
  },
}));
function start(request: BackendRunRequest) {
  fixture.requests.push(request);
  fixture.onSpawn?.();
  return {
    abort() {},
    result: Promise.resolve({
      success: true,
      stdout: 'Fixture reply',
      responseText: 'Fixture reply',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      childExited: true,
      command: 'inert fixture',
    }),
  };
}
vi.mock('../repl/backend-runner.js', () => ({
  withholdProviderToolsForThisProcess: () => {},
  startBackendTurn: (request: BackendRunRequest) => start(request),
  runBackendTurn: (request: BackendRunRequest) => start(request).result,
}));
vi.mock('../repl/credential-resolver.js', async (original) => ({
  ...(await original<typeof import('../repl/credential-resolver.js')>()),
  loadKeychainCredentials: async () => ({}),
}));
vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [
    { name: 'review', path: '/fixture/review', source: 'repo:.ink/skills', trustLevel: 'trusted' },
  ],
  loadSkillInstruction: (skill: DiscoveredSkill) => fixture.load(skill),
}));
vi.mock('../repl/turn-signal.js', async (original) => ({
  ...(await original<typeof import('../repl/turn-signal.js')>()),
  createTurnSignal: () => ({
    open: async () => true,
    close: async () => true,
    detach: async () => true,
  }),
}));
vi.mock('../repl/ink/index.js', () => ({
  renderInkChat: async () => null,
  InkExitSignal: class extends Error {},
}));
vi.mock('readline/promises', () => ({
  createInterface: () => ({
    question: async () => {
      const next = fixture.inputs.shift();
      if (next === undefined) throw new Error('No scripted CLI input');
      if (next.startsWith('/skill-clear')) await fixture.beforeClear?.();
      return next;
    },
    on() {},
    close() {},
  }),
}));
import { runChat } from './chat.js';

describe('CLI consumes shared session controls', () => {
  const cwd = process.cwd();
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-controls-')));
    process.chdir(root);
    vi.stubEnv('INK_TOOL_POLICY_PATH', join(root, 'policy.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected network');
      })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.inputs = [];
    fixture.requests = [];
    fixture.onSpawn = undefined;
    fixture.beforeClear = undefined;
    fixture.load.mockReset().mockImplementation((skill: DiscoveredSkill) => ({
      ...skill,
      content: 'UNIQUE_SKILL_INSTRUCTION',
    }));
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const run = () =>
    runChat({
      agent: 'echo',
      backend: 'claude',
      sessionId: 'fixture-session',
      pollSeconds: '999',
      ui: 'scroll',
    });
  it('activates, clears and reseeds the next native session rather than retaining old skill context', async () => {
    // CLI input is enqueued, not awaited by readline. The second control is
    // submitted after the first provider has actually consumed its envelope.
    const started = new Promise<void>((resolve) => {
      fixture.onSpawn = resolve;
    });
    fixture.beforeClear = () => started;
    fixture.inputs = [
      '/skill-use review',
      'First request',
      '/skill-clear review',
      'Second request',
      '/quit',
    ];
    await run();
    expect(fixture.inputs).toEqual([]);
    expect(fixture.load).toHaveBeenCalledOnce();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0].prompt).toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(fixture.requests[1].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(fixture.requests[1].backendSessionId).toBeUndefined();
    expect(fixture.requests[1].backendSessionSeedId).not.toBe(
      fixture.requests[0].backendSessionSeedId
    );
  });
  it('preserves backend/model commands and does not load a disallowed skill', async () => {
    fixture.inputs = [
      '/path-allow-read /different/**',
      '/skill-use review',
      '/backend codex',
      '/model fixture-model',
      'Request',
      '/quit',
    ];
    await run();
    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ backend: 'codex', model: 'fixture-model' });
    expect(fixture.requests[0].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
  });
});
