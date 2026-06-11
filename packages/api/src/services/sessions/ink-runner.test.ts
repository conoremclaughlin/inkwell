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

    it('forwards media attachments as --attach-file args', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs(
        'session-media',
        { workingDirectory: '/tmp', agentId: 'myra' },
        [
          { type: 'image', path: '/home/u/.ink/files/telegram/photo.jpg' },
          { type: 'document', path: '/home/u/.ink/files/telegram/report.pdf' },
          { type: 'image', url: 'https://example.com/no-local-path.jpg' },
        ]
      );

      const attachPaths = args
        .map((arg: string, i: number) => (arg === '--attach-file' ? args[i + 1] : null))
        .filter(Boolean);
      expect(attachPaths).toEqual([
        '/home/u/.ink/files/telegram/photo.jpg',
        '/home/u/.ink/files/telegram/report.pdf',
      ]);
    });

    it('caps --attach-file forwarding at 10 attachments', () => {
      const runner = new InkRunner();
      const media = Array.from({ length: 15 }, (_, i) => ({
        type: 'image',
        path: `/tmp/photo${i}.jpg`,
      }));
      const args = (runner as any).buildArgs(
        'session-cap',
        { workingDirectory: '/tmp', agentId: 'myra' },
        media
      );

      const attachCount = args.filter((arg: string) => arg === '--attach-file').length;
      expect(attachCount).toBe(10);
    });

    it('adds no --attach-file without attachments', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-nomedia', {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      expect(args).not.toContain('--attach-file');
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

    it('extracts finalTextResponse from type=result JSON line', () => {
      const runner = new InkRunner();
      const stdout = [
        JSON.stringify({
          type: 'result',
          text: 'Your appointment is confirmed for Thursday at 2pm.',
          sessionId: 'sess-123',
        }),
        '\x1b[2m\nSession completed.\x1b[22m',
        '\x1b[36m  Resume with: ink chat --attach-latest myra\n\x1b[39m',
      ].join('\n');

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.finalTextResponse).toBe('Your appointment is confirmed for Thursday at 2pm.');
      expect(result.responses).toHaveLength(0);
    });

    it('prefers send_response over result for channel routing', () => {
      const runner = new InkRunner();
      const stdout = [
        JSON.stringify({
          type: 'send_response',
          channel: 'telegram',
          conversationId: '456',
          content: 'Routed via MCP',
        }),
        JSON.stringify({
          type: 'result',
          text: 'Fallback text from ledger',
        }),
      ].join('\n');

      const result = (runner as any).parseOutput(stdout, '');

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0].content).toBe('Routed via MCP');
      expect(result.finalTextResponse).toBe('Fallback text from ledger');
    });
  });
});
