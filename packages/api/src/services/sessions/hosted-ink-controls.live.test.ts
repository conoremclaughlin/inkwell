/**
 * Opt-in real-provider control acceptance WITHOUT an API/DB/private stack.
 * Uses the extracted composer and real Claude adapter/process; Inkwell calls
 * are inert fixture ports. This is not HTTP admission or end-to-end server proof.
 * INK_LIVE_TESTS=1 plus INK_CONTROLS_LIVE_AUTH_FILE (a private JSON file with
 * CLAUDE_CODE_OAUTH_TOKEN) and INK_CONTROLS_LIVE_BINARY (absolute Claude path).
 * Run only via vitest.live.config.ts, never the root suite. No ambient HOME,
 * hooks, MCP servers, native tools, database credentials or production token.
 */
import { describe, it, expect } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { randomUUID } from 'crypto';
import {
  composeInkSession,
  createSessionToolHost,
  createSkillInstructionHost,
  type SessionCompositionPorts,
} from '@inklabs/shared/node-host';
import { SessionLog, ToolPolicyState } from '@inklabs/shared/runtime';
import {
  startBackendTurn,
  type BackendHost,
  type BackendRunRequest,
} from '@inklabs/shared/providers';

const enabled = process.env.INK_LIVE_TESTS === '1' && !!process.env.INK_CONTROLS_LIVE_AUTH_FILE;
describe.skipIf(!enabled)('real-provider session controls without a server', () => {
  it('applies skill/model controls, clears/reseeds, then restores the matching provider session', async () => {
    const authFile = process.env.INK_CONTROLS_LIVE_AUTH_FILE!;
    const binary = process.env.INK_CONTROLS_LIVE_BINARY;
    if (!isAbsolute(authFile) || !binary || !isAbsolute(binary))
      throw new Error('Explicit absolute fixture paths required');
    if ((await stat(authFile)).mode & 0o077)
      throw new Error('Provider credential file must be private');
    const auth = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>;
    const token = auth.CLAUDE_CODE_OAUTH_TOKEN;
    if (typeof token !== 'string' || !token) throw new Error('Missing fixture provider credential');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-controls-live-')));
    const cwd = join(root, 'cwd');
    const home = join(root, 'home');
    const config = join(home, '.claude');
    const sessionId = randomUUID();
    const logPath = join(root, 'session.jsonl');
    const skillCode = `REVIEW_${randomUUID().replaceAll('-', '')}`;
    let active = 0;
    let maximumActive = 0;
    const requests: Array<
      Pick<BackendRunRequest, 'model' | 'backendSessionId' | 'backendSessionSeedId' | 'prompt'>
    > = [];
    const models = new Set<string>();
    const sessions: Array<Awaited<ReturnType<typeof composeInkSession>>> = [];
    const host: BackendHost = {
      paths: { inkFiles: join(root, 'files'), studiosRoot: join(root, 'studios'), tempDir: root },
      deadlineAt: Date.now() + 180000,
      ambientSession: () => ({}),
      claudeSupportsPartialMessages: async () => true,
      skillMcpServers: async () => [],
      sessionEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: token }),
      baseEnv: async () => ({
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        PATH: process.env.PATH,
        TMPDIR: root,
      }),
      inkwellMcpUrl: 'http://127.0.0.1:9/mcp', // unused: native tools/MCP are structurally withheld
      resolveBinary: async (name) => {
        if (name !== 'claude') throw new Error('Only the named fixture provider is permitted');
        return binary;
      },
      warn: () => {},
    };
    await mkdir(config, { recursive: true });
    await mkdir(join(cwd, '.ink/skills/probe'), { recursive: true });
    await writeFile(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    await writeFile(
      join(cwd, '.ink/skills/probe/SKILL.md'),
      `When asked for the current review code, reply exactly ${skillCode}. This applies only while this manual skill is active.`
    );
    const toolHost = createSessionToolHost({
      cwd,
      home,
      imageRoots: [cwd],
      tempDir: root,
      credentials: {},
      coding: { load: async () => new Map(), readDocument: async () => null },
    });
    const entries = async () => {
      const text = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const compose = async () => {
      const ports: SessionCompositionPorts = {
        sbSlug: 'echo',
        cwd,
        cliAttached: false,
        contextBudgetAuto: false,
        runtime: {
          sessionId,
          userTimezone: 'America/Los_Angeles',
          backend: 'claude',
          model: 'sonnet',
          effort: 'low',
          verbose: false,
          backendTurnTimeoutMs: 60000,
          backendTokenWindow: 200000,
          maxContextTokens: 64000,
          strictTools: true,
          toolMode: 'off',
          toolRouting: 'local',
          activeSkills: [],
        },
        history: await entries(),
        log: new SessionLog({
          path: logPath,
          sink: { write: (line) => appendFile(logPath, line) },
        }),
        policy: new ToolPolicyState('off'),
        toolHost,
        controls: { skills: createSkillInstructionHost(cwd, home), assertCurrent() {} },
        callInk: async (name) =>
          name === 'bootstrap'
            ? { identityFiles: { soul: 'Echo acceptance fixture. No tools. Answer briefly.' } }
            : { success: true, memories: [] },
        logActivity: async () => {},
        prepareHost: async () => {},
        unavailable: () => {
          throw new Error('Fixture bootstrap failed');
        },
        mintId: randomUUID,
        spawnContext: () => ({
          host,
          workingDirectory: cwd,
          inkSessionId: sessionId,
          studioId: undefined,
          withholdProviderTools: true,
        }),
        startTurn: (request) => {
          requests.push({
            model: request.model,
            backendSessionId: request.backendSessionId,
            backendSessionSeedId: request.backendSessionSeedId,
            prompt: request.prompt,
          });
          active++;
          maximumActive = Math.max(maximumActive, active);
          const handle = startBackendTurn(request);
          return {
            abort: () => handle.abort(),
            result: handle.result
              .then((result) => {
                expect(result.childExited).toBe(true);
                if (!result.success) {
                  const diagnosis = (result.stderr || result.responseText || result.stdout)
                    .replaceAll(token, '[credential]')
                    .replace(/[A-Za-z0-9_+\/=-]{40,}/g, '[opaque]')
                    .slice(0, 600);
                  console.log(
                    'PROVIDER_REFUSAL',
                    JSON.stringify({ exitCode: result.exitCode, diagnosis })
                  );
                }
                expect(result.success).toBe(true);
                return result;
              })
              .finally(() => {
                active--;
              }),
          };
        },
        approve: async () => false,
        approveClone: async () => false,
        cloneLog: () => {
          throw new Error('Clones are not permitted by this fixture');
        },
        presentation: {
          ui: { printLine() {}, printEvent() {}, startWaiting: () => () => {} },
          render() {},
          progress() {},
          toolStarted() {},
          toolResult() {},
          compacted() {},
          notice() {},
          modelReported: (model) => {
            models.add(model);
          },
        },
      };
      const session = await composeInkSession(ports);
      sessions.push(session);
      return session;
    };
    try {
      const session = await compose();
      expect(
        session.controls.enqueue({ controlId: 'use-probe', action: 'skill_use', name: 'probe' })
          .status
      ).toBe('pending');
      const first = await session.run(
        {
          raw: 'What is the current review code? Use the currently active manual skill if any; otherwise answer NONE.',
          source: 'user',
        },
        { continueOnFailure: false }
      );
      expect(first?.execution.loop.success).toBe(true);
      expect(first?.execution.loop.assistantDisplayText).toContain(skillCode);
      expect(requests[0].prompt).toContain(skillCode);
      session.controls.enqueue({ controlId: 'clear-probe', action: 'skill_clear' });
      session.controls.enqueue({ controlId: 'model-haiku', action: 'model', model: 'haiku' });
      const second = await session.run(
        {
          raw: 'Ignore earlier review codes. Inspect ONLY the current active skill section, not conversation history. If no manual skill is active, reply exactly NONE.',
          source: 'user',
        },
        { continueOnFailure: false }
      );
      expect(second?.execution.loop.success).toBe(true);
      expect(second?.execution.loop.assistantDisplayText?.trim()).toBe('NONE');
      expect(requests[1].model).toBe('haiku');
      expect(requests[1].backendSessionId).toBeUndefined();
      expect(requests[1].backendSessionSeedId).not.toBe(requests[0].backendSessionSeedId);
      expect(session.runtime.activeSkills).toEqual([]);
      session.controls.close();
      const reattached = await compose();
      expect(reattached.runtime.model).toBe('haiku');
      const third = await reattached.run(
        { raw: 'Reply exactly REATTACHED_OK.', source: 'user' },
        { continueOnFailure: false }
      );
      expect(third?.execution.loop.assistantDisplayText).toContain('REATTACHED_OK');
      expect(requests[2].backendSessionId).toBe(requests[1].backendSessionSeedId);
      expect(requests[2].backendSessionSeedId).toBeUndefined();
      expect(maximumActive).toBe(1);
      expect(active).toBe(0);
      const records = await entries();
      expect(records.filter((e) => e.type === 'session_control')).toHaveLength(3);
      expect(records.filter((e) => e.type === 'assistant')).toHaveLength(3);
      expect(records.filter((e) => e.type === 'backend_session').at(-1)?.controlId).toBe(
        'model-haiku'
      );
      console.log(
        'CONTROL_ACCEPTANCE',
        JSON.stringify({
          realTurns: 3,
          stoppedProviders: requests.length,
          maximumActive,
          models: [...models],
        })
      );
    } finally {
      for (const session of sessions) {
        session.controls.close();
        session.clones.cancel();
        await session.clones.drain();
      }
      await toolHost.close();
      if (active === 0) await rm(root, { recursive: true, force: true });
    }
  }, 240000);
});
