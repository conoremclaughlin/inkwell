import { describe, it, expect, vi } from 'vitest';
import { InkRunner, DEFAULT_MAX_TURNS, clampMaxTurns, parseInkModelUsage } from './ink-runner';

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

    it('defaults --max-turns to DEFAULT_MAX_TURNS when no per-SB value is set', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-mt', {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      const idx = args.indexOf('--max-turns');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(String(DEFAULT_MAX_TURNS));
    });

    it('honors a dashboard-configured maxTurns, clamped to a sane range', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-mt2', {
        workingDirectory: '/tmp',
        agentId: 'myra',
        maxTurns: 12,
      });
      const idx = args.indexOf('--max-turns');
      expect(args[idx + 1]).toBe('12');
    });

    it('always passes --tool-routing explicitly, failing closed to local', () => {
      // The headless boundary must never depend on worktree .ink/identity.json
      // preferences or the chat loop's own defaults.
      const runner = new InkRunner();
      const withRouting = (runner as any).buildArgs('session-tr', {
        workingDirectory: '/tmp',
        agentId: 'myra',
        toolRouting: 'backend',
      });
      const idx = withRouting.indexOf('--tool-routing');
      expect(idx).toBeGreaterThan(-1);
      expect(withRouting[idx + 1]).toBe('backend');

      const withoutRouting = (runner as any).buildArgs('session-tr2', {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });
      const defaultIdx = withoutRouting.indexOf('--tool-routing');
      expect(defaultIdx).toBeGreaterThan(-1);
      expect(withoutRouting[defaultIdx + 1]).toBe('local');
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

    it('uses --profile safe --away instead of --approval-mode auto-approve', () => {
      const runner = new InkRunner();
      const args = (runner as any).buildArgs('session-policy', {
        workingDirectory: '/tmp',
        agentId: 'myra',
      });

      expect(args).toContain('--profile');
      expect(args).toContain('safe');
      expect(args).toContain('--away');
      expect(args).not.toContain('--approval-mode');
      expect(args).not.toContain('auto-approve');
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

/**
 * The ink path had the same undercount as the direct claude path, one layer
 * further out: the CLI parser keeps cached tokens in separate fields, and the
 * result line forwarded only the fresh remainder. That is why Myra's sessions
 * recorded a few hundred input tokens across hundreds of messages.
 */
describe('InkRunner usage parsing', () => {
  it('counts the cache split as input and keeps the breakdown', () => {
    const runner = new InkRunner();
    const stdout = JSON.stringify({
      type: 'result',
      text: 'done',
      usage: {
        contextTokens: 42_000,
        inputTokens: 120,
        outputTokens: 900,
        cacheReadTokens: 38_000,
        cacheWriteTokens: 1_200,
      },
      model: 'claude-fable-5',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (runner as any).parseOutput(stdout, '');

    expect(result.usage.inputTokens).toBe(39_320);
    expect(result.usage.cacheReadTokens).toBe(38_000);
    expect(result.usage.cacheWriteTokens).toBe(1_200);
    // Context stays the CLI's own budget figure, not the billed sum.
    expect(result.usage.contextTokens).toBe(42_000);
    expect(result.servedModel).toBe('claude-fable-5');
  });

  // An older ink build on a studio that has not been rebuilt omits the new
  // fields; that must degrade to the previous behaviour, not throw or zero.
  it('falls back to fresh-only input when cache fields are absent', () => {
    const runner = new InkRunner();
    const stdout = JSON.stringify({
      type: 'result',
      usage: { contextTokens: 1_000, inputTokens: 120, outputTokens: 900 },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (runner as any).parseOutput(stdout, '');

    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.servedModel).toBeUndefined();
  });
});

/**
 * Cost attribution for ink sessions. #493 gave direct-claude spawns a per-model
 * map with the backend's own costUSD; the ink path forwarded only the model
 * name, so ink-backed agents (Myra) had no dollar figure at all.
 */
describe('parseInkModelUsage', () => {
  it('maps the per-model block, cost included, keys as reported', () => {
    const parsed = parseInkModelUsage({
      'claude-opus-5': {
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 1_200,
        costUSD: 0.0431,
        canonicalModel: 'claude-opus-5',
      },
      'claude-haiku-4-5-20251001': {
        inputTokens: 500,
        outputTokens: 15,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUSD: 0.0006,
        canonicalModel: 'claude-haiku-4-5',
      },
    })!;

    expect(parsed['claude-opus-5'].costUSD).toBeCloseTo(0.0431);
    expect(parsed['claude-opus-5'].cacheReadTokens).toBe(40_000);
    // Both keys survive — a dated id and an alias can be distinct call sites.
    expect(Object.keys(parsed).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
  });

  // An older ink build emits no block at all; the field must be absent rather
  // than a zeroed map that would read as "this run cost nothing".
  it('returns undefined for absent or malformed input', () => {
    expect(parseInkModelUsage(undefined)).toBeUndefined();
    expect(parseInkModelUsage({})).toBeUndefined();
    expect(parseInkModelUsage('nonsense')).toBeUndefined();
    // Entries with nothing numeric are unreadable, not free: a present
    // zero-cost map would read as a measured $0.00 (Lumen, PR #500 round 1).
    expect(
      parseInkModelUsage({ 'claude-opus-5': { inputTokens: 'lots', costUSD: null } })
    ).toBeUndefined();
    // A partially-readable entry still counts — but an unreported cost stays
    // ABSENT rather than 0, or a summed session cost silently under-reports
    // with no way to tell a measured zero from a never-reported one.
    const partial = parseInkModelUsage({ 'claude-opus-5': { outputTokens: 12 } });
    expect(partial!['claude-opus-5'].outputTokens).toBe(12);
    expect(partial!['claude-opus-5'].costUSD).toBeUndefined();
    // A genuinely reported zero is preserved as a measurement.
    const freeTurn = parseInkModelUsage({ 'claude-opus-5': { outputTokens: 1, costUSD: 0 } });
    expect(freeTurn!['claude-opus-5'].costUSD).toBe(0);
  });

  // The CLI is the only layer that sees every invocation of a run, so its
  // completeness verdict is the authoritative one. Dropping it here promoted a
  // lower bound back to a total at the process boundary (Lumen, PR #500 r4).
  it('forwards the CLI cost-completeness marker across the boundary', () => {
    const parsed = parseInkModelUsage({
      'claude-opus-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        costUSD: 0.01,
        costPartial: true,
        canonicalModel: 'claude-opus-5',
      },
    })!;

    expect(parsed['claude-opus-5'].costUSD).toBeCloseTo(0.01);
    expect(parsed['claude-opus-5'].costPartial).toBe(true);
  });

  it('does not invent a marker for a complete entry', () => {
    const parsed = parseInkModelUsage({
      'claude-opus-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUSD: 0.01,
      },
    })!;

    expect(parsed['claude-opus-5'].costPartial).toBeUndefined();
  });

  it('carries the block through parseOutput into usage', () => {
    const runner = new InkRunner();
    const stdout = JSON.stringify({
      type: 'result',
      text: 'done',
      usage: { contextTokens: 5_000, inputTokens: 10, outputTokens: 20 },
      model: 'claude-opus-5',
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 4_900,
          cacheWriteTokens: 0,
          costUSD: 0.0125,
          canonicalModel: 'claude-opus-5',
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (runner as any).parseOutput(stdout, '');

    expect(result.usage.modelUsage['claude-opus-5'].costUSD).toBeCloseTo(0.0125);
  });
});

describe('clampMaxTurns', () => {
  it('defaults when absent or non-finite', () => {
    expect(clampMaxTurns(undefined)).toBe(DEFAULT_MAX_TURNS);
    expect(clampMaxTurns(Number.NaN)).toBe(DEFAULT_MAX_TURNS);
    expect(clampMaxTurns(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_TURNS);
  });

  it('clamps to [1, 25] and rounds fractions', () => {
    expect(clampMaxTurns(0)).toBe(1);
    expect(clampMaxTurns(-3)).toBe(1);
    expect(clampMaxTurns(99)).toBe(25);
    expect(clampMaxTurns(7.6)).toBe(8);
    expect(clampMaxTurns(5)).toBe(5);
  });
});
