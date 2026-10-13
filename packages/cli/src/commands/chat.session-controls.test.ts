/** Actual CLI command dispatch with inert providers/network and an owned policy directory. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BackendRunRequest } from '@inklabs/shared/providers';
import { SessionLog } from '../session/session-log.js';
import { createSessionControls, createSkillInstructionHost } from '@inklabs/shared/node-host';
import {
  ToolPolicyState,
  readSessionControl,
  type SessionPromptSkill,
} from '@inklabs/shared/runtime';
import { homedir } from 'os';
import { createHash } from 'crypto';

const fixture = vi.hoisted(() => ({
  inputs: [] as string[],
  requests: [] as BackendRunRequest[],
  onSpawn: undefined as (() => void) | undefined,
  beforeClear: undefined as (() => Promise<void>) | undefined,
  finish: undefined as Promise<void> | undefined,
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
    result: Promise.resolve(fixture.finish).then(() => ({
      success: true,
      stdout: 'Fixture reply',
      responseText: 'Fixture reply',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      childExited: true,
      command: 'inert fixture',
    })),
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
  let sigintListeners: NodeJS.SignalsListener[];
  beforeEach(() => {
    sigintListeners = process.listeners('SIGINT');
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
    fixture.finish = undefined;
    mkdirSync(join(root, '.ink/skills/review'), { recursive: true });
    writeFileSync(join(root, '.ink/skills/review/SKILL.md'), 'UNIQUE_SKILL_INSTRUCTION');
  });
  afterEach(() => {
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (options: Partial<Parameters<typeof runChat>[0]> = {}) =>
    runChat({
      agent: 'echo',
      backend: 'claude',
      sessionId: 'fixture-session',
      pollSeconds: '999',
      ui: 'scroll',
      ...options,
    });
  const events = (): Array<Record<string, unknown>> => {
    const dir = join(root, '.ink/runtime/repl');
    return readdirSync(dir)
      .filter((name) => name.startsWith('fixture-session-'))
      .flatMap((name) =>
        readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      );
  };
  const controls = () =>
    events()
      .filter((e) => e.type === 'session_control')
      .map(readSessionControl);
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
    expect(controls()).toHaveLength(2);
    expect(controls()[0].selection.skills[0].contentDigest).toBe(
      createHash('sha256').update('UNIQUE_SKILL_INSTRUCTION').digest('hex')
    );
    expect(JSON.stringify(controls())).not.toContain('UNIQUE_SKILL_INSTRUCTION');
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
    expect(controls().every((e) => e.selection.skills.length === 0)).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ backend: 'codex', model: 'fixture-model' });
    expect(fixture.requests[0].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
  });
  it('replays CLI selections and a matching seed, then persists an explicit launch override', async () => {
    fixture.inputs = ['/model chosen', '/skill-use review', 'First', '/quit'];
    await run();
    const firstSeed = fixture.requests[0].backendSessionSeedId;
    fixture.requests = [];
    fixture.inputs = ['Second', '/quit'];
    await run({ model: 'chosen' });
    expect(fixture.requests[0]).toMatchObject({ model: 'chosen', backendSessionId: firstSeed });
    expect(fixture.requests[0].backendSessionSeedId).toBeUndefined();
    expect(controls()).toHaveLength(2);
    fixture.requests = [];
    fixture.inputs = ['Third', '/quit'];
    await run({ model: 'launch-wins' });
    expect(fixture.requests[0].model).toBe('launch-wins');
    expect(fixture.requests[0].backendSessionId).toBeUndefined();
    expect(fixture.requests[0].prompt).toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(controls().at(-1)?.selection.model).toBe('launch-wins');
    const ids = events().map((e) => e.eid as number);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  });

  it('restores CLI-written selections through the hosted reducer without storing instructions', async () => {
    fixture.inputs = ['/model chosen', '/skill-use review', '/quit'];
    await run();
    const runtime = {
      backend: 'claude',
      backendTokenWindow: 200000,
      maxContextTokens: 170000,
      sessionId: 'fixture-session',
      model: undefined as string | undefined,
      activeSkills: [] as SessionPromptSkill[],
    };
    const host = createSessionControls({
      runtime,
      log: { append: () => 1, flush: async () => {} },
      policy: new ToolPolicyState('backend'),
      skills: createSkillInstructionHost(root, homedir()),
      contextBudgetAuto: true,
      assertCurrent() {},
      invalidateProvider() {},
      mintId: () => 'fixture-control',
    });
    for (const event of events()) host.replay(event);
    await host.restore();
    expect(runtime.model).toBe('chosen');
    expect(runtime.activeSkills.map((s) => s.content)).toEqual(['UNIQUE_SKILL_INSTRUCTION']);
  });

  it('removes drift durably rather than resurrecting the old instructions on reattach', async () => {
    fixture.inputs = ['/skill-use review', 'First', '/quit'];
    await run();
    writeFileSync(join(root, '.ink/skills/review/SKILL.md'), 'CHANGED_SKILL');
    fixture.requests = [];
    fixture.inputs = ['Second', '/quit'];
    await run();
    expect(fixture.requests[0].backendSessionId).toBeUndefined();
    expect(fixture.requests[0].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(fixture.requests[0].prompt).not.toContain('CHANGED_SKILL');
    expect(controls().at(-1)).toMatchObject({
      reason: 'replay_skill_removed',
      selection: { skills: [] },
    });
    writeFileSync(join(root, '.ink/skills/review/SKILL.md'), 'UNIQUE_SKILL_INSTRUCTION');
    fixture.requests = [];
    fixture.inputs = ['Third', '/quit'];
    await run();
    expect(fixture.requests[0].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
  });

  it('does not mutate the active turn while a clear waits at the FIFO boundary', async () => {
    let finish!: () => void;
    fixture.finish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      fixture.onSpawn = resolve;
    });
    fixture.beforeClear = async () => {
      await started;
      // Return /skill-clear while the first provider is still alive. Check on
      // a later tick, after readline has queued it, then let that turn finish.
      setTimeout(() => {
        expect(controls()).toHaveLength(1);
        finish();
      }, 20);
    };
    fixture.inputs = ['/skill-use review', 'First', '/skill-clear', 'Second', '/quit'];
    await run();
    const records = events();
    const cleared = records.findIndex(
      (e) => e.type === 'session_control' && readSessionControl(e).selection.skills.length === 0
    );
    const assistant = records.findIndex((e) => e.type === 'assistant');
    expect(assistant).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(assistant);
    expect(fixture.requests[1].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
  });

  it('holds all later dispatch after an uncertain control flush, including a backend switch', async () => {
    const append = SessionLog.prototype.append;
    vi.spyOn(SessionLog.prototype, 'append').mockImplementation(function (this: SessionLog, event) {
      const eid = append.call(this, event);
      if (event.type === 'session_control') throw new Error('Synthetic acknowledgment loss');
      return eid;
    });
    fixture.inputs = [
      '/backend codex',
      'Must not dispatch',
      '/model different',
      'Still held',
      '/quit',
    ];
    await run();
    expect(fixture.requests).toHaveLength(0);
    expect(controls()).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('persistence is uncertain'));
  });

  it('refuses linked and oversized instruction files rather than activating empty or unbounded content', async () => {
    const skill = join(root, '.ink/skills/review/SKILL.md');
    rmSync(skill);
    writeFileSync(join(root, 'target.md'), 'LINKED_CONTENT');
    symlinkSync(join(root, 'target.md'), skill);
    fixture.inputs = ['/skill-use review', 'First', '/quit'];
    await run();
    expect(controls()).toHaveLength(0);
    expect(fixture.requests[0].prompt).not.toContain('LINKED_CONTENT');
    rmSync(skill);
    writeFileSync(skill, 'X'.repeat(256 * 1024 + 1));
    fixture.inputs = ['/skill-use review', 'Second', '/quit'];
    await run();
    expect(controls()).toHaveLength(0);
  });
  it('reads a hosted-writer selection through CLI replay before its first provider dispatch', async () => {
    const dir = join(root, '.ink/runtime/repl');
    mkdirSync(dir, { recursive: true });
    const log = new SessionLog({ path: join(dir, 'fixture-session-hosted.jsonl') });
    const runtime = {
      backend: 'claude',
      backendTokenWindow: 200000,
      maxContextTokens: 170000,
      sessionId: 'fixture-session',
    };
    const host = createSessionControls({
      runtime,
      log,
      policy: new ToolPolicyState('backend'),
      skills: createSkillInstructionHost(root, homedir()),
      contextBudgetAuto: true,
      assertCurrent() {},
      invalidateProvider() {},
      mintId: () => 'fixture-control',
    });
    host.enqueue({ controlId: 'host-model', action: 'model', model: 'host-choice' });
    host.enqueue({ controlId: 'host-skill', action: 'skill_use', name: 'review' });
    await host.drain();
    fixture.inputs = ['From CLI', '/quit'];
    await run();
    expect(fixture.requests[0].model).toBe('host-choice');
    expect(fixture.requests[0].prompt).toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(events().find((e) => e.type === 'backend_session')).toMatchObject({
      controlId: 'host-skill',
    });
    expect(controls()).toHaveLength(2);
  });

  it('persists model reset and skill clear through reattach', async () => {
    fixture.inputs = ['/model chosen', '/skill-use review', '/model', '/skill-clear', '/quit'];
    await run();
    fixture.inputs = ['No overrides', '/quit'];
    await run();
    expect(fixture.requests[0].model).toBeUndefined();
    expect(fixture.requests[0].prompt).not.toContain('UNIQUE_SKILL_INSTRUCTION');
    expect(controls().at(-1)?.selection).toEqual({ model: null, skills: [] });
  });

  it('bounds long-lived CLI control ids with an explicit refusal, not dedupe eviction', async () => {
    fixture.inputs = Array.from({ length: 129 }, (_, i) => `/model choice-${i}`);
    fixture.inputs.push('Still healthy', '/quit');
    await run();
    expect(controls()).toHaveLength(128);
    expect(fixture.requests[0].model).toBe('choice-127');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('control_capacity'));
  });
  it('treats server launch defaults as fallbacks, not new selections on each headless turn', async () => {
    await run({ defaultModel: 'fleet', nonInteractive: true, message: 'Initial default' });
    expect(fixture.requests[0].model).toBe('fleet');
    expect(controls()).toHaveLength(0);
    fixture.inputs = ['/model chosen', '/quit'];
    await run();
    fixture.requests = [];
    await run({ defaultModel: 'fleet', nonInteractive: true, message: 'Keep chosen' });
    expect(fixture.requests[0].model).toBe('chosen');
    expect(controls()).toHaveLength(1);
    fixture.requests = [];
    await run({
      defaultModel: 'fleet',
      model: 'intentional',
      nonInteractive: true,
      message: 'Explicit override',
    });
    expect(fixture.requests[0].model).toBe('intentional');
    expect(controls().at(-1)?.selection.model).toBe('intentional');
    fixture.requests = [];
    await run({ defaultModel: 'fleet', nonInteractive: true, message: 'Keep intentional' });
    expect(fixture.requests[0].model).toBe('intentional');
    expect(controls()).toHaveLength(2);
  });
});
