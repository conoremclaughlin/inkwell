import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mintDelegationToken, verifyDelegationToken } from '@personal-context/shared';

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
      if (next === '__ABORT__') {
        const err = new Error('Aborted with Ctrl+C') as Error & { code?: string; name?: string };
        err.code = 'ABORT_ERR';
        err.name = 'AbortError';
        throw err;
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
  const originalDelegationSecret = process.env.PCP_DELEGATION_SECRET;
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
    process.env.PCP_DELEGATION_SECRET = 'pcp-delegation-test-secret';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalPolicyPath === undefined) delete process.env.PCP_TOOL_POLICY_PATH;
    else process.env.PCP_TOOL_POLICY_PATH = originalPolicyPath;
    if (originalDelegationSecret === undefined) delete process.env.PCP_DELEGATION_SECRET;
    else process.env.PCP_DELEGATION_SECRET = originalDelegationSecret;
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

  it('supports interactive attach picker from active sessions', async () => {
    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'list_sessions':
          return {
            sessions: [
              {
                id: 'sess-a111',
                agentId: 'lumen',
                status: 'active',
                currentPhase: 'implementing',
                threadKey: 'pr:61',
                backendSessionId: 'codex-backend-a',
              },
              {
                id: 'sess-b222',
                agentId: 'lumen',
                status: 'active',
                currentPhase: 'reviewing',
                threadKey: 'spec:cli-session-hooks',
                backendSessionId: 'codex-backend-b',
              },
            ],
          };
        case 'get_inbox':
          return { messages: [] };
        default:
          return { success: true };
      }
    });

    // 2 -> choose second session in picker, then /quit interactive loop.
    testState.inputs = ['2', '/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      attach: true,
      pollSeconds: '999',
    });

    expect(testState.pcpCalls.some((call) => call.tool === 'start_session')).toBe(false);
    expect(testState.pcpCalls.some((call) => call.tool === 'end_session')).toBe(false);

    const sessionStatusLine = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(sessionStatusLine).toContain('Session: sess-b222');
    expect(sessionStatusLine).toContain('Thread: spec:cli-session-hooks');
    expect(sessionStatusLine).toContain('codex-backend-a');
    expect(sessionStatusLine).toContain('codex-backend-b');
  });

  it('supports attach-latest without prompting', async () => {
    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'list_sessions':
          return {
            sessions: [
              {
                id: 'sess-old',
                agentId: 'lumen',
                status: 'active',
                threadKey: 'pr:1',
                startedAt: '2026-02-18T18:00:00.000Z',
              },
              {
                id: 'sess-new',
                agentId: 'lumen',
                status: 'active',
                threadKey: 'pr:2',
                startedAt: '2026-02-18T19:00:00.000Z',
              },
            ],
          };
        case 'get_inbox':
          return { messages: [] };
        default:
          return { success: true };
      }
    });

    testState.inputs = ['/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      attachLatest: true,
      pollSeconds: '999',
    });

    const sessionStatusLine = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(sessionStatusLine).not.toContain('Select session to attach');
    expect(sessionStatusLine).toContain('Session: sess-new');
    expect(sessionStatusLine).toContain('Thread: pr:2');
  });

  it('auto-attaches latest active session by default when no --new/--attach is provided', async () => {
    testState.callToolImpl.mockImplementation(async (tool: string) => {
      switch (tool) {
        case 'bootstrap':
          return { user: { timezone: 'America/Los_Angeles' } };
        case 'list_sessions':
          return {
            sessions: [
              {
                id: 'sess-old',
                agentId: 'lumen',
                status: 'active',
                threadKey: 'pr:9',
                startedAt: '2026-02-18T18:00:00.000Z',
              },
              {
                id: 'sess-latest',
                agentId: 'lumen',
                status: 'active',
                threadKey: 'pr:10',
                startedAt: '2026-02-18T19:00:00.000Z',
              },
            ],
          };
        case 'get_inbox':
          return { messages: [] };
        default:
          return { success: true };
      }
    });

    testState.inputs = ['/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    expect(testState.pcpCalls.some((call) => call.tool === 'start_session')).toBe(false);
    const sessionStatusLine = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(sessionStatusLine).toContain('Mode: auto-attached to latest active session');
    expect(sessionStatusLine).toContain('Session: sess-latest');
    expect(sessionStatusLine).toContain('Thread: pr:10');
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
      { name: 'allowed-skill', path: '/allowed/skills/a', source: 'test', trustLevel: 'trusted' },
      { name: 'blocked-skill', path: '/blocked/skills/b', source: 'test', trustLevel: 'trusted' },
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

  it('enforces skill trust mode in REPL skill activation', async () => {
    testState.discoverSkillsImpl.mockReturnValue([
      { name: 'local-skill', path: '/allowed/skills/a', source: 'test', trustLevel: 'local' },
    ]);

    testState.inputs = ['/skill-trust trusted-only', '/skills', '/skill-use local-skill', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('Skill trust mode set to trusted-only');
    expect(logText).toContain('1 skills hidden by trust policy mode');
    expect(logText).toContain('Skill blocked by trust policy (local); set /skill-trust all to allow.');
  });

  it('renders backend token usage when available', async () => {
    testState.runBackendImpl.mockResolvedValue({
      success: true,
      stdout: 'done',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      command: 'mock',
      usage: {
        backend: 'claude',
        source: 'json',
        inputTokens: 1200,
        outputTokens: 400,
        totalTokens: 1600,
      },
    });

    testState.inputs = ['show usage', '/usage', '/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('claude usage (json): in 1,200 · out 400 · total 1,600');
    expect(logText).toContain('Last backend usage: claude usage (json): in 1,200 · out 400 · total 1,600');
  });

  it('shows capabilities snapshot including MCP servers and policy', async () => {
    writeFileSync(
      join(testCwd, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
            github: { command: 'github-mcp-server', args: ['stdio'] },
          },
        },
        null,
        2
      )
    );
    testState.discoverSkillsImpl.mockReturnValue([
      {
        name: 'playwright',
        source: 'local',
        path: '/tmp/playwright',
        trustLevel: 'trusted',
      },
    ]);
    testState.inputs = ['/capabilities', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('Capabilities snapshot');
    expect(logText).toContain('MCP servers (2)');
    expect(logText).toContain('pcp [http] http://localhost:3001/mcp');
    expect(logText).toContain('github [stdio] github-mcp-server');
    expect(logText).toContain('Tool policy');
  });

  it('supports /mcp shorthand to list configured servers', async () => {
    writeFileSync(
      join(testCwd, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
          },
        },
        null,
        2
      )
    );
    testState.inputs = ['/mcp', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('MCP servers (1)');
    expect(logText).toContain('pcp [http] http://localhost:3001/mcp');
  });

  it('exits gracefully on double ctrl+c', async () => {
    testState.inputs = ['__ABORT__', '__ABORT__'];

    await expect(
      runChat({
        agent: 'lumen',
        backend: 'claude',
        pollSeconds: '999',
      })
    ).resolves.toBeUndefined();

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('Press Ctrl+C again to quit');
    expect(logText).toContain('Exiting chat (double Ctrl+C).');
  });

  it('requires confirmation before large context ejection and allows cancel', async () => {
    const huge = 'x'.repeat(7000);
    testState.inputs = [huge, '/bookmark heavy', 'follow-up', '/eject heavy', 'n', '/quit'];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('About to eject');
    expect(logText).toContain('Ejection cancelled.');

    const replDir = join(testCwd, '.pcp', 'runtime', 'repl');
    const transcriptFiles = readdirSync(replDir).filter((entry) => entry.endsWith('.jsonl'));
    const transcript = readFileSync(join(replDir, transcriptFiles[0]!), 'utf-8');
    expect(transcript).not.toContain('"type":"context_eject"');
  });

  it('sends delegated inbox message with signed token metadata', async () => {
    testState.inputs = [
      '/delegate-send wren send_to_inbox,trigger_agent please review this',
      'y',
      '/quit',
    ];

    await runChat({
      agent: 'lumen',
      backend: 'claude',
      threadKey: 'pr:123',
      pollSeconds: '999',
    });

    const sendCall = testState.pcpCalls.find((call) => call.tool === 'send_to_inbox');
    expect(sendCall).toBeTruthy();
    const metadata = sendCall?.args?.metadata as Record<string, unknown> | undefined;
    const token = metadata?.delegationToken;
    expect(typeof token).toBe('string');

    const verified = verifyDelegationToken(String(token), process.env.PCP_DELEGATION_SECRET || '', {
      expectedIssuerAgentId: 'lumen',
      expectedDelegateeAgentId: 'wren',
      expectedThreadKey: 'pr:123',
      requiredScopes: ['send_to_inbox', 'trigger_agent'],
    });
    expect(verified.valid).toBe(true);
  });

  it('renders delegation metadata label for inbox messages', async () => {
    const delegationToken = mintDelegationToken(
      {
        issuerAgentId: 'wren',
        delegateeAgentId: 'lumen',
        scopes: ['send_to_inbox'],
        threadKey: 'pr:50',
      },
      process.env.PCP_DELEGATION_SECRET || ''
    );

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
                  id: 'delegated-1',
                  content: 'please take this action',
                  senderAgentId: 'wren',
                  subject: 'Delegated task',
                  threadKey: 'pr:50',
                  metadata: { delegationToken },
                },
              ],
            };
          }
          return { messages: [] };
        default:
          return { success: true };
      }
    });

    testState.inputs = ['/quit'];
    await runChat({
      agent: 'lumen',
      backend: 'claude',
      threadKey: 'pr:50',
      pollSeconds: '999',
    });

    const logText = stripAnsi(logSpy.mock.calls.flat().join('\n'));
    expect(logText).toContain('[delegation:wren->lumen:send_to_inbox]');
  });
});
