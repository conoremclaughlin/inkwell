import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testState = vi.hoisted(() => ({
  inputs: [] as string[],
  pcpCalls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  identity: { workspaceId: 'studio-test' } as { workspaceId?: string },
  callToolImpl: vi.fn(),
  runBackendImpl: vi.fn(),
  discoverSkillsImpl: vi.fn(),
  loadSkillInstructionImpl: vi.fn(),
}));

vi.mock('../backends/identity.js', () => ({
  resolveAgentId: (agent?: string) => agent || 'lumen',
  readIdentityJson: () => testState.identity,
}));

vi.mock('../lib/pcp-client.js', () => ({
  PcpClient: class MockPcpClient {
    public async callTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
      testState.pcpCalls.push({ tool, args });
      return testState.callToolImpl(tool, args);
    }
  },
}));

vi.mock('../repl/backend-runner.js', () => ({
  runBackendTurn: (request: Record<string, unknown>) => testState.runBackendImpl(request),
}));

vi.mock('../repl/skills.js', () => ({
  discoverSkills: (cwd: string) => testState.discoverSkillsImpl(cwd),
  loadSkillInstruction: (skill: Record<string, unknown>, maxChars?: number) =>
    testState.loadSkillInstructionImpl(skill, maxChars),
}));

vi.mock('readline/promises', () => ({
  createInterface: () => ({
    question: async () => {
      const next = testState.inputs.shift();
      if (next === undefined) {
        throw new Error('No scripted input left for readline question');
      }
      return next;
    },
    close: () => undefined,
  }),
}));

import { runChat } from './chat.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('runChat integration', () => {
  const originalCwd = process.cwd();
  const originalPolicyPath = process.env.PCP_TOOL_POLICY_PATH;
  let testCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testState.inputs = [];
    testState.pcpCalls = [];
    testState.identity = { workspaceId: 'studio-test' };
    testState.callToolImpl.mockReset();
    testState.runBackendImpl.mockReset();
    testState.discoverSkillsImpl.mockReset();
    testState.loadSkillInstructionImpl.mockReset();

    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'start_session':
          return { session: { id: 'sess-1' } };
        case 'get_inbox':
          return { messages: [] };
        case 'update_session_phase':
        case 'end_session':
          return { success: true };
        default:
          return { success: true };
      }
    });

    testState.runBackendImpl.mockResolvedValue({
      success: true,
      stdout: 'backend reply',
      stderr: '',
      exitCode: 0,
      durationMs: 8,
      command: 'mock',
    });

    testState.discoverSkillsImpl.mockReturnValue([]);
    testState.loadSkillInstructionImpl.mockImplementation((skill: Record<string, unknown>) => ({
      ...skill,
      content: 'skill content',
    }));

    testCwd = mkdtempSync(join(tmpdir(), 'pcp-chat-int-'));
    process.chdir(testCwd);
    process.env.PCP_TOOL_POLICY_PATH = join(testCwd, '.pcp', 'security', 'tool-policy.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalPolicyPath === undefined) delete process.env.PCP_TOOL_POLICY_PATH;
    else process.env.PCP_TOOL_POLICY_PATH = originalPolicyPath;
    process.chdir(originalCwd);
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('runs a real user message turn and writes transcript entries', async () => {
    testState.inputs = ['hello from test', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'codex',
      threadKey: 'heartbeat:myra',
      pollSeconds: '999',
    });

    expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
    const backendRequest = testState.runBackendImpl.mock.calls[0][0] as { prompt: string };
    expect(backendRequest.prompt).toContain('Latest user message:\nhello from test');

    const startCall = testState.pcpCalls.find((call) => call.tool === 'start_session');
    expect(startCall?.args).toMatchObject({
      agentId: 'lumen',
      threadKey: 'heartbeat:myra',
      studioId: 'studio-test',
      workspaceId: 'studio-test',
    });

    const replDir = join(testCwd, '.pcp', 'runtime', 'repl');
    const transcriptFiles = readdirSync(replDir).filter((entry) => entry.endsWith('.jsonl'));
    expect(transcriptFiles.length).toBeGreaterThan(0);
    const transcript = readFileSync(join(replDir, transcriptFiles[0]!), 'utf-8');
    expect(transcript).toContain('"type":"session_start"');
    expect(transcript).toContain('"type":"user"');
    expect(transcript).toContain('"type":"assistant"');
  });

  it('supports non-interactive single turn mode', async () => {
    await runChat({
      agent: 'lumen',
      backend: 'gemini',
      nonInteractive: true,
      message: 'heartbeat pulse',
      pollSeconds: '999',
    });

    expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
    const backendRequest = testState.runBackendImpl.mock.calls[0][0] as { prompt: string; backend: string };
    expect(backendRequest.backend).toBe('gemini');
    expect(backendRequest.prompt).toContain('Latest user message:\nheartbeat pulse');
    // Newly created session in non-interactive mode should be ended.
    expect(testState.pcpCalls.some((call) => call.tool === 'end_session')).toBe(true);
  });

  it('attaches to provided session id and does not end attached session', async () => {
    testState.inputs = ['/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      sessionId: 'sess-attach-1',
      pollSeconds: '999',
    });

    // Attached mode skips start_session.
    expect(testState.pcpCalls.some((call) => call.tool === 'start_session')).toBe(false);
    // Attached mode should not end the existing session.
    expect(testState.pcpCalls.some((call) => call.tool === 'end_session')).toBe(false);

    const transcriptDir = join(testCwd, '.pcp', 'runtime', 'repl');
    const transcriptFiles = readdirSync(transcriptDir).filter((entry) => entry.includes('sess-attach-1'));
    expect(transcriptFiles.length).toBeGreaterThan(0);
    const transcript = readFileSync(join(transcriptDir, transcriptFiles[0]!), 'utf-8');
    expect(transcript).toContain('"type":"session_attach"');
  });

  it('supports gated /pcp tool execution with inline approval', async () => {
    testState.inputs = ['/pcp send_to_inbox {"recipientAgentId":"wren"}', 'y', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const sendCall = testState.pcpCalls.find((call) => call.tool === 'send_to_inbox');
    expect(sendCall?.args).toEqual({ recipientAgentId: 'wren' });
    expect(testState.runBackendImpl).toHaveBeenCalledTimes(0);

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('Granted once.');
  });

  it('renders inbox messages during polling and carries thread into /session', async () => {
    let inboxPolls = 0;
    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'start_session':
          return { session: { id: 'sess-1' } };
        case 'get_inbox':
          inboxPolls += 1;
          if (inboxPolls === 1) {
            return {
              messages: [
                {
                  id: 'm-1',
                  content: 'please re-review',
                  senderAgentId: 'wren',
                  subject: 'PR #50',
                  threadKey: 'pr:50',
                },
              ],
            };
          }
          return { messages: [] };
        case 'update_session_phase':
        case 'end_session':
          return { success: true };
        default:
          return { success: true };
      }
    });

    testState.inputs = ['/session', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('📥 wren — PR #50: please re-review');
    expect(logText).toContain('thread=pr:50');
  });

  it('applies read-path policy to skill listing and activation', async () => {
    testState.discoverSkillsImpl.mockReturnValue([
      { name: 'allowed-skill', path: '/allowed/skills/a', source: 'test' },
      { name: 'blocked-skill', path: '/blocked/skills/b', source: 'test' },
    ]);

    testState.inputs = [
      '/path-allow-read /allowed/**',
      '/skills',
      '/skill-use blocked-skill',
      '/quit',
    ];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('- allowed-skill [test]');
    expect(logText).toContain('1 skills hidden by read-path allowlist policy');
    expect(logText).toContain('Skill path blocked by read allowlist policy: /blocked/skills/b');
  });
});
