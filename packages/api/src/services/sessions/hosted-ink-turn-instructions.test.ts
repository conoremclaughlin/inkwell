import { describe, expect, it, vi } from 'vitest';
import {
  HostedInkSessionRunner,
  type ExecuteHostedInkSession,
  type HostedInkTurnDependencies,
} from './hosted-ink-session';
import type { InjectedContext } from './types';

// Pure composition boundary: no provider, MCP connection, file or process.
const instructions =
  'Reply through send_response to channel inkling, conversationId chat:synthetic.';
const context = {
  agent: { sbSlug: 'pip', name: 'Pip', role: 'assistant', values: [], capabilities: [] },
  user: { id: 'synthetic-user', timezone: 'UTC', contacts: {}, preferences: {} },
  temporal: {
    currentTime: '9:00 AM',
    currentDate: 'Monday, August 24, 2026',
    dayOfWeek: 'Monday',
    timezone: 'UTC',
    greeting: 'Good morning',
  },
  constitution: { values: 'VALUES-CONTEXT', process: 'PROCESS-CONTEXT', user: 'USER-CONTEXT' },
  knowledgeSummary: 'SYNTHETIC-DIGEST',
  recentMemories: [],
  activeProjects: [],
} as InjectedContext;

async function capture(turnInstructions: string | undefined, backendSessionId?: string) {
  const execute = vi.fn<ExecuteHostedInkSession>(async () => ({ success: true, responses: [] }));
  const deps: HostedInkTurnDependencies = {
    deadlineAt: Date.now() + 60_000,
    inkwell: {
      callTool: async () => {
        throw new Error('No MCP in this fixture');
      },
    },
    startProviderTurn: () => {
      throw new Error('No provider in this fixture');
    },
    isHostedRefusal: () => false,
    sessionLog: {
      path: '/synthetic/log',
      seed: () => {},
      append: () => 1,
      flush: async () => {},
      read: async () => [],
    },
  };
  const runner = new HostedInkSessionRunner({ execute, forTurn: () => deps });
  const result = await runner.run('hello', {
    backendSessionId,
    injectedContext: context,
    config: {
      workingDirectory: '/synthetic',
      mcpConfigPath: '/synthetic/mcp.json',
      inkSessionId: 'synthetic-session',
      turnEpoch: 'synthetic-epoch',
      sbSlug: 'pip',
      turnInstructions,
      appendSystemPrompt: 'PRIVATE-IDENTITY-CANARY',
    },
  });
  expect(result.success).toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  return execute.mock.calls[0][0].message;
}

describe('hosted turn instruction parity', () => {
  it.each([undefined, 'synthetic-resume'])(
    'carries the current reply contract on %s',
    async (resume) => {
      const message = await capture(instructions, resume);
      expect(message.startsWith(`${instructions}\n\n---\n\n`)).toBe(true);
      expect(message.split(instructions)).toHaveLength(2);
      expect(message.endsWith('hello')).toBe(true);
      expect(message).not.toContain('PRIVATE-IDENTITY-CANARY');
      if (resume) expect(message).toBe(`${instructions}\n\n---\n\nhello`);
    }
  );
  it.each([undefined, '', '   '])(
    'keeps an unadorned resumed message unchanged for %j',
    async (value) => {
      expect(await capture(value, 'synthetic-resume')).toBe('hello');
    }
  );
});
