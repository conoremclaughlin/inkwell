import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
  mkdir: vi.fn().mockResolvedValue(undefined),
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
            name: 'mcp__inkwell__send_response',
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
    expect(result.backendSessionId).toBe('codex-session-123');
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
      // Codex reports thread-cumulative totals; the repository diffs them.
      cumulative: true,
    });
    expect(result.finalTextResponse).toBe('done');
    expect(result.toolCalls?.length).toBe(1);
  });

  it('should run resume mode when session id exists', async () => {
    const mockProc = createMockProcess();
    (spawn as Mock).mockReturnValue(mockProc);

    const runner = new CodexRunner();
    const runPromise = runner.run('resume msg', {
      backendSessionId: 'existing-session-abc',
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
    // Default (no sandboxBypass) prefixes with -a never
    expect(args).toContain('exec');
    expect(args).toContain('resume');
    expect(args).toContain('--json');
    expect(args).toContain('existing-session-abc');
    expect(args).toContain('resume msg');
  });

  it('injects INK_ACCESS_TOKEN into codex subprocess env when provided', async () => {
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
    expect(options.env?.INK_ACCESS_TOKEN).toBe('test-pcp-token');
  });

  it('should return null backendSessionId when no session ID is found in stdout', async () => {
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
      // No session_id, thread_id, or session_meta in the output
      mockProc.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { text: 'hello' } })}\n`)
      );
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.backendSessionId).toBeNull();
  });

  it('should extract session ID from Codex session_meta event', async () => {
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

    const codexSessionId = '019ceb00-82c5-7b02-b7f3-df9cbd17b334';

    setTimeout(() => {
      // Codex emits session_meta as the first event with the session UUID at payload.id
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'session_meta',
            payload: {
              id: codexSessionId,
              timestamp: '2026-03-14T06:20:05.232Z',
              cwd: '/tmp/test',
              originator: 'codex_exec',
              source: 'exec',
            },
          })}\n`
        )
      );
      mockProc.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ result: 'done', input_tokens: 10, output_tokens: 5 })}\n`)
      );
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.backendSessionId).toBe(codexSessionId);
  });

  it('should extract session ID from thread.started thread_id (real Codex stdout format)', async () => {
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

    const codexThreadId = '019cf13d-486a-7bd1-913b-b23490d476cf';

    setTimeout(() => {
      // This is what Codex exec --json actually outputs on stdout
      mockProc.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: codexThreadId })}\n`)
      );
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'turn.started' })}\n`));
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 20 },
          })}\n`
        )
      );
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.backendSessionId).toBe(codexThreadId);
  });

  it('should not overwrite thread.started ID with conversationId from later tool calls', async () => {
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

    const codexThreadId = '019cf752-e3a3-7773-9ced-c407047b73c5';

    setTimeout(() => {
      // thread.started comes first with the real Codex thread UUID
      mockProc.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: codexThreadId })}\n`)
      );
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'turn.started' })}\n`));
      // Later: a tool call with conversationId (PCP routing key, NOT a backend session ID)
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'function_call',
              name: 'mcp__inkwell__send_response',
              arguments: JSON.stringify({
                channel: 'agent',
                conversationId: 'trigger:lumen:thread:some-thread',
                content: 'hello',
              }),
            },
          })}\n`
        )
      );
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 20 },
          })}\n`
        )
      );
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    expect(result.success).toBe(true);
    // The thread.started ID must be preserved, NOT overwritten by conversationId
    expect(result.backendSessionId).toBe(codexThreadId);
  });

  it('should prefer first session ID found and not overwrite with later events', async () => {
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

    const codexSessionId = '019ceb00-real-session-id';

    setTimeout(() => {
      // session_meta comes first — this should be used
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'session_meta',
            payload: { id: codexSessionId, source: 'exec' },
          })}\n`
        )
      );
      // Later event has a different session_id key — should NOT override
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'some_event',
            session_id: 'generic-session-456',
          })}\n`
        )
      );
      mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'done' })}\n`));
      mockProc.emit('close', 0);
    }, 5);

    const result = await runPromise;
    // session_meta was first — later session_id must not overwrite it
    expect(result.backendSessionId).toBe(codexSessionId);
  });

  describe('container path translation', () => {
    let runtimeDir: string;

    beforeEach(() => {
      runtimeDir = mkdtempSync(join(tmpdir(), 'codex-container-test-'));
    });

    afterEach(() => {
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it('uses /run/ink/ container path when config.container.runtimeDir is set', async () => {
      const mockProc = createMockProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const runner = new CodexRunner();
      const runPromise = runner.run('hello', {
        config: {
          workingDirectory: process.cwd(),
          mcpConfigPath: '',
          model: 'gpt-5-codex',
          appendSystemPrompt: 'test identity prompt',
          container: {
            containerName: 'ink-sandbox-test-abc',
            runtimeDir,
          },
        },
      });

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
        mockProc.emit('close', 0);
      }, 5);

      await runPromise;

      expect(spawn).toHaveBeenCalledTimes(1);
      const [, args] = (spawn as Mock).mock.calls[0] as [string, string[]];

      // The model_instructions_file arg should point to /run/ink/ (container path)
      const configArg = args.find(
        (a: string) => typeof a === 'string' && a.startsWith('model_instructions_file=')
      );
      expect(configArg).toBeDefined();
      expect(configArg).toMatch(/^model_instructions_file=\/run\/ink\//);
    });

    it('injects host.docker.internal, not loopback, when running in a container', async () => {
      // Lumen's blocker on PR #430. Inside a Docker sandbox `resolveSpawnTarget`
      // wraps the command in `docker exec`, so a hardcoded localhost resolves to
      // the CONTAINER's own loopback rather than the API server — bypassing the
      // orchestrator's host.docker.internal rewrite and stranding the run with
      // no Ink tools.
      const mockProc = createMockProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const runner = new CodexRunner();
      const runPromise = runner.run('hello', {
        config: {
          workingDirectory: process.cwd(),
          mcpConfigPath: '',
          container: { containerName: 'ink-sandbox-test-abc', runtimeDir },
        },
      });

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
        mockProc.emit('close', 0);
      }, 5);
      await runPromise;

      const [, args] = (spawn as Mock).mock.calls[0] as [string, string[]];
      const urlArg = args.find(
        (a: string) => typeof a === 'string' && a.startsWith('mcp_servers.inkwell.url=')
      );
      expect(urlArg).toBeDefined();
      expect(urlArg).toContain('host.docker.internal');
      expect(urlArg).not.toContain('localhost');
    });

    it('injects localhost when running on the host', async () => {
      const mockProc = createMockProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const runner = new CodexRunner();
      const runPromise = runner.run('hello', {
        config: { workingDirectory: process.cwd(), mcpConfigPath: '' },
      });

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
        mockProc.emit('close', 0);
      }, 5);
      await runPromise;

      const [, args] = (spawn as Mock).mock.calls[0] as [string, string[]];
      const urlArg = args.find(
        (a: string) => typeof a === 'string' && a.startsWith('mcp_servers.inkwell.url=')
      );
      expect(urlArg).toBeDefined();
      expect(urlArg).toContain('localhost');
      expect(urlArg).not.toContain('host.docker.internal');
    });

    it('writes the identity prompt file to runtimeDir on the host', async () => {
      const mockProc = createMockProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const runner = new CodexRunner();
      const runPromise = runner.run('hello', {
        config: {
          workingDirectory: process.cwd(),
          mcpConfigPath: '',
          model: 'gpt-5-codex',
          appendSystemPrompt: 'host-side identity content',
          container: {
            containerName: 'ink-sandbox-test-abc',
            runtimeDir,
          },
        },
      });

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
        mockProc.emit('close', 0);
      }, 5);

      await runPromise;

      // Verify the file was written to the runtimeDir (host-side)
      const files = readdirSync(runtimeDir);
      const identityFile = files.find((f) => f.startsWith('identity-'));
      expect(identityFile).toBeDefined();
    });

    it('uses /tmp/ path when runtimeDir is NOT set', async () => {
      const mockProc = createMockProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const runner = new CodexRunner();
      const runPromise = runner.run('hello', {
        config: {
          workingDirectory: process.cwd(),
          mcpConfigPath: '',
          model: 'gpt-5-codex',
          appendSystemPrompt: 'test identity prompt',
          // No container config
        },
      });

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'ok' })}\n`));
        mockProc.emit('close', 0);
      }, 5);

      await runPromise;

      expect(spawn).toHaveBeenCalledTimes(1);
      const [, args] = (spawn as Mock).mock.calls[0] as [string, string[]];

      // Without container, the model_instructions_file should NOT use /run/ink/
      const configArg = args.find(
        (a: string) => typeof a === 'string' && a.startsWith('model_instructions_file=')
      );
      expect(configArg).toBeDefined();
      expect(configArg).not.toMatch(/\/run\/ink\//);
      // Should be a host-side tmp path
      expect(configArg).toMatch(/model_instructions_file=\//);
    });
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
    expect(result.error).toContain('stream disconnected before completion');
  });
});

describe('CodexRunner token usage extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runWithEvents(events: Record<string, unknown>[]) {
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
      for (const event of events) {
        mockProc.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
      }
      mockProc.emit('close', 0);
    }, 5);

    return runPromise;
  }

  // codex exec --json emits turn.completed.usage from ThreadTokenUsage.total,
  // i.e. a running total for the thread. It must be flagged so the repository
  // diffs rather than adds — adding it re-applied the whole history every turn
  // and grew one session to 3,441,018,986 tokens, overflowing int32 on write.
  it('flags Codex usage as cumulative', async () => {
    const result = await runWithEvents([
      {
        type: 'turn.completed',
        usage: { input_tokens: 1200, output_tokens: 340 },
      },
    ]);

    expect(result.usage?.cumulative).toBe(true);
  });

  // Real 0.146.1 shape. cached_input_tokens and cache_write_input_tokens are
  // both represented WITHIN input_tokens; reasoning_output_tokens within
  // output_tokens. None may be added on top.
  it('does not add cache or reasoning figures already inside the totals', async () => {
    const result = await runWithEvents([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 900,
          cache_write_input_tokens: 64,
          output_tokens: 50,
          reasoning_output_tokens: 30,
          total_tokens: 1050,
        },
      },
    ]);

    expect(result.usage?.inputTokens).toBe(1000);
    expect(result.usage?.outputTokens).toBe(50);
  });

  it('still reads flat top-level usage fields', async () => {
    const result = await runWithEvents([
      { session_id: 'codex-session-123', input_tokens: 12, output_tokens: 5, context_tokens: 42 },
    ]);

    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(5);
    expect(result.usage?.contextTokens).toBe(42);
  });

  // Codex emits no per-turn context measure. Aliasing it to the cumulative
  // input total stored a false 1.3-billion-token "context" reading, so an
  // absent figure must stay absent — unknown, not zero and not the input sum.
  it('reports no context figure when the backend does not provide one', async () => {
    const result = await runWithEvents([
      { type: 'turn.completed', usage: { input_tokens: 70, output_tokens: 5 } },
    ]);

    expect(result.usage?.contextTokens).toBeUndefined();
    expect(result.usage?.inputTokens).toBe(70);
  });

  // An untyped deep scan for any object carrying input_tokens/output_tokens
  // can consume token stats that belong to something else entirely — e.g. a
  // benchmark harness reporting its own numbers into the event stream.
  it('ignores token-shaped objects outside the usage container', async () => {
    const result = await runWithEvents([
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          result: { benchmark_stats: { input_tokens: 3_437_373_064, output_tokens: 3_645_922 } },
        },
      },
    ]);

    expect(result.usage).toBeUndefined();
  });
});

// spec:studio-materialization v8 (PR #544 r1 P1) — Codex defaults to
// workspace-write, so without --add-dir the host MCP can mint a studio the
// Codex session cannot edit, build, or test. The grant must ride BOTH arg
// shapes: `exec ...` and `exec resume <sid> ...`.
describe('CodexRunner ephemeral-studio root grant', () => {
  it('grants --add-dir for the studios root on fresh and resume shapes', () => {
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-codex-${process.pid}`);
    try {
      const runner = new CodexRunner();
      const config = { workingDirectory: '/tmp', mcpConfigPath: '' } as never;
      const shapes: Array<[string | undefined, boolean]> = [
        [undefined, false],
        ['sess-1', true],
      ];
      for (const [sid, isResume] of shapes) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args: string[] = (runner as any).buildArgs(sid, isResume, 'msg', config, '/tmp/p.md');
        const granted = args
          .map((arg, i) => (arg === '--add-dir' ? args[i + 1] : null))
          .filter(Boolean);
        expect(granted).toContain(process.env.INK_STUDIOS_ROOT);
        // r2: `--add-dir` is valid on `exec` but REJECTED by the
        // `exec resume` subcommand ("unexpected argument", verified against
        // the installed binary). exec scope applies to the resumed session,
        // so the required order is exec < --add-dir < resume.
        expect(args.indexOf('--add-dir')).toBeGreaterThan(args.indexOf('exec'));
        if (isResume) {
          expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('resume'));
        }
      }
    } finally {
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });
});
