import { describe, it, expect, vi } from 'vitest';
import { InkRunner } from './ink-runner';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('InkRunner', () => {
  describe('buildArgs', () => {
    it('builds base args for a new session', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-123', false, {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      expect(args).toContain('chat');
      expect(args).toContain('--non-interactive');
      expect(args).toContain('--agent');
      expect(args).toContain('myra');
      expect(args).toContain('--max-turns');
      expect(args).not.toContain('--session-id');
    });

    it('adds --session-id for resumed sessions', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-456', true, {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      expect(args).toContain('--session-id');
      expect(args).toContain('session-456');
    });

    it('includes --model when specified', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-789', false, {
        workingDirectory: '/tmp',
        agentId: 'wren',
        model: 'claude-sonnet-4-20250514',
      });

      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-20250514');
    });

    it('omits --agent when agentId is not provided', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-000', false, {
        workingDirectory: '/tmp',
      });

      expect(args).not.toContain('--agent');
    });
  });

  describe('parseOutput', () => {
    it('captures plain text as finalTextResponse', () => {
      const runner = new InkRunner();
      const result = (runner as any).parseOutput(
        'Hello! I checked and the appointment is still the same.\n',
        ''
      );

      expect(result.finalTextResponse).toBe(
        'Hello! I checked and the appointment is still the same.'
      );
      expect(result.responses).toHaveLength(0);
      expect(result.toolCalls).toHaveLength(0);
    });

    it('parses send_response JSON lines into responses', () => {
      const runner = new InkRunner();
      const stdout = [
        JSON.stringify({
          type: 'send_response',
          channel: 'telegram',
          conversationId: '123',
          content: 'Done!',
        }),
        'Some trailing text',
      ].join('\n');

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]).toEqual({
        channel: 'telegram',
        conversationId: '123',
        content: 'Done!',
        format: undefined,
      });
      expect(result.finalTextResponse).toBe('Some trailing text');
    });

    it('parses tool_call JSON lines', () => {
      const runner = new InkRunner();
      const stdout = JSON.stringify({
        type: 'tool_call',
        toolName: 'browser_navigate',
        toolUseId: 'tc-1',
        input: { url: 'https://example.com' },
      });

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe('browser_navigate');
      expect(result.toolCalls[0].input).toEqual({ url: 'https://example.com' });
    });

    it('handles empty output', () => {
      const runner = new InkRunner();
      const result = (runner as any).parseOutput('', '');

      expect(result.finalTextResponse).toBeUndefined();
      expect(result.responses).toHaveLength(0);
      expect(result.toolCalls).toHaveLength(0);
    });

    it('handles mixed JSON and plain text', () => {
      const runner = new InkRunner();
      const stdout = [
        'Starting task...',
        JSON.stringify({
          type: 'tool_call',
          toolName: 'bash',
          id: 'tc-2',
          input: { command: 'ls' },
        }),
        'All done.',
      ].join('\n');

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.toolCalls).toHaveLength(1);
      expect(result.finalTextResponse).toBe('Starting task...\nAll done.');
    });
  });
});
