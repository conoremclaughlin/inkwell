import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFile: vi.fn(
      (
        file: string,
        args: string[] | undefined,
        options: unknown,
        callback?: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const cb =
          typeof options === 'function'
            ? (options as (error: Error | null, stdout: string, stderr: string) => void)
            : callback;
        if (typeof cb !== 'function') return;
        if (file === 'which' || file === 'zsh') {
          cb(null, '/usr/bin/codex\n', '');
          return;
        }
        cb(new Error(`mock execFile unsupported for ${file}`), '', '');
      }
    ),
  };
});

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn().mockResolvedValue('codex'),
  buildSpawnPath: vi.fn().mockReturnValue(process.env.PATH || ''),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { spawn } from 'child_process';
import { CodexRunner } from './codex-runner.js';

function createMockProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

describe('CodexRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should parse send_response tool calls and usage from codex json stream', async () => {
    const mockProc = createMockProcess();
    (spawn as Mock).mockReturnValue(mockProc);

    const runner = new CodexRunner();
    const runPromise = runner.run('hello', {
      config: {
        workingDirectory: process.cwd(),
        mcpConfigPath: '',
        model: 'gpt-5-codex',
        appendSystemPrompt: 'identity override',
      },
    });

    setTimeout(() => {
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'tool_use',
            id: 'tu-1',
            name: 'mcp__pcp__send_response',
            input: { channel: 'telegram', conversationId: 'chat-1', content: 'hi from codex' },
          })}\n`
        )
      );
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            session_id: 'codex-session-123',
            input_tokens: 12,
            output_tokens: 5,
            context_tokens: 42,
            result: 'done',
          })}\n`
        )
      );
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.claudeSessionId).toBe('codex-session-123');
    expect(result.responses).toEqual([
      {
        channel: 'telegram',
        conversationId: 'chat-1',
        content: 'hi from codex',
        format: undefined,
        replyToMessageId: undefined,
        metadata: undefined,
      },
    ]);
    expect(result.usage).toEqual({
      contextTokens: 42,
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(result.finalTextResponse).toBe('done');
    expect(result.toolCalls?.length).toBe(1);
  });

  it('should run resume mode when session id exists', async () => {
    const mockProc = createMockProcess();
    (spawn as Mock).mockReturnValue(mockProc);

    const runner = new CodexRunner();
    const runPromise = runner.run('resume msg', {
      claudeSessionId: 'existing-session-abc',
      config: {
        workingDirectory: process.cwd(),
        mcpConfigPath: '',
        model: 'gpt-5-codex',
        appendSystemPrompt: 'identity override',
      },
    });

    setTimeout(() => {
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
      mockProc.emit('close', 0);
    }, 5);

    await runPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = (spawn as Mock).mock.calls[0] as [string, string[]];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('resume');
    expect(args).toContain('--json');
    expect(args).toContain('existing-session-abc');
    expect(args).toContain('resume msg');
  });

  it('injects PCP_ACCESS_TOKEN into codex subprocess env when provided', async () => {
    const mockProc = createMockProcess();
    (spawn as Mock).mockReturnValue(mockProc);

    const runner = new CodexRunner();
    const runPromise = runner.run('hello', {
      config: {
        workingDirectory: process.cwd(),
        mcpConfigPath: '',
        model: 'gpt-5-codex',
        appendSystemPrompt: 'identity override',
        pcpAccessToken: 'test-pcp-token',
      },
    });

    setTimeout(() => {
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
      mockProc.emit('close', 0);
    }, 5);

    await runPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, , options] = (spawn as Mock).mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(options.env?.PCP_ACCESS_TOKEN).toBe('test-pcp-token');
  });

  it('includes parsed startup events in diagnostics when codex exits non-zero without stderr', async () => {
    const mockProc = createMockProcess();
    (spawn as Mock).mockReturnValue(mockProc);

    const runner = new CodexRunner();
    const runPromise = runner.run('hello', {
      config: {
        workingDirectory: process.cwd(),
        mcpConfigPath: '',
        model: 'gpt-5-codex',
        appendSystemPrompt: 'identity override',
      },
    });

    setTimeout(() => {
      mockProc.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n`)
      );
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'turn.started' })}\n`));
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'error',
            message: 'stream disconnected before completion',
          })}\n`
        )
      );
      mockProc.emit('close', 1, null);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('exitCode=1');
    expect(result.error).toContain('parsedEvents=3');
    expect(result.error).toContain('thread.started');
    expect(result.error).toContain('turn.started');
    expect(result.error).toContain('parsedErrorMessages');
    expect(result.error).toContain('stream disconnected before completion');
  });
});
