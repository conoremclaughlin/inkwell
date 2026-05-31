import { describe, it, expect, vi } from 'vitest';
import { InkRunner } from './ink-runner';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('InkRunner', () => {
  describe('buildArgs', () => {
    it('always includes --session-id with the PCP session ID', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-123', {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      expect(args).toContain('chat');
      expect(args).toContain('--non-interactive');
      expect(args).toContain('--agent');
      expect(args).toContain('myra');
      expect(args).toContain('--max-turns');
      expect(args).toContain('--session-id');
      expect(args).toContain('session-123');
    });

    it('includes --model when specified', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-789', {
        workingDirectory: '/tmp',
        agentId: 'wren',
        model: 'claude-sonnet-4-20250514',
      });

      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-20250514');
    });

    it('omits --agent when agentId is not provided', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-000', {
        workingDirectory: '/tmp',
      });

      expect(args).not.toContain('--agent');
      expect(args).toContain('--session-id');
      expect(args).toContain('session-000');
    });
  });

  describe('parseOutput', () => {
    it('does not treat plain text stdout as finalTextResponse', () => {
      const runner = new InkRunner();
      const result = (runner as any).parseOutput(
        'Hello! I checked and the appointment is still the same.\n',
        ''
      );

      expect(result.finalTextResponse).toBeUndefined();
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
        'Some trailing CLI noise',
      ].join('\n');

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]).toEqual({
        channel: 'telegram',
        conversationId: '123',
        content: 'Done!',
        format: undefined,
      });
      expect(result.finalTextResponse).toBeUndefined();
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

    it('ignores non-JSON text lines (CLI noise)', () => {
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
      expect(result.finalTextResponse).toBeUndefined();
    });
  });
});
