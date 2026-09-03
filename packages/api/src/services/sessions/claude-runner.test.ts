import { describe, it, expect, vi } from 'vitest';
import {
  ClaudeRunner,
  parseClaudeUsage,
  parseAssistantContextTokens,
  parseModelUsage,
  parseAssistantModel,
  canonicalizeModel,
  createLineReader,
} from './claude-runner.js';
import {
  resultWithUsage,
  resultWithHighUsage,
} from '../../test/fixtures/claude-stream-messages.js';

/**
 * Regression cover for the field names in Claude's stream-json `result.usage`.
 *
 * The runner used to read `cache_read_tokens` / `cache_write_tokens`, which do
 * not exist. Every cached token was therefore invisible, and since
 * `input_tokens` carries only the non-cached remainder, recorded input for a
 * heavily-cached agent collapsed to near zero — the reason per-agent cost
 * attribution could not be trusted.
 */
describe('parseClaudeUsage', () => {
  it('counts cached input as input, using the real field names', () => {
    const usage = parseClaudeUsage(resultWithUsage.usage as Record<string, unknown>);

    // 12500 fresh + 18000 cache read + 4500 cache write
    expect(usage.inputTokens).toBe(35_000);
    expect(usage.outputTokens).toBe(850);
    expect(usage.cacheReadTokens).toBe(18_000);
    expect(usage.cacheWriteTokens).toBe(4_500);
  });

  it('reports billing totals only — context is measured elsewhere', () => {
    const usage = parseClaudeUsage(resultWithHighUsage.usage as Record<string, unknown>);

    expect(usage.inputTokens).toBe(175_000);
    expect(usage.outputTokens).toBe(3_500);
    // result.usage aggregates every model step in the query, so it cannot
    // stand in for live context occupancy. Absent means unknown, not zero.
    expect(usage.contextTokens).toBeUndefined();
  });

  // The misspelled names must not quietly resurrect: a payload carrying only
  // them contributes nothing, which is exactly what the bug looked like.
  it('ignores the field names that never existed', () => {
    const usage = parseClaudeUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 500_000,
      cache_write_tokens: 250_000,
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('treats absent and malformed usage fields as zero', () => {
    const usage = parseClaudeUsage({ output_tokens: 'lots' });

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
  });
});

/**
 * Context occupancy comes from per-step assistant messages, never from the
 * query aggregate. A 20-step query re-reads its cached prompt each step, so
 * result.usage bills a multiple of the live context — using it for context
 * tripped the 150k compaction threshold on runs nowhere near full.
 */
describe('parseAssistantContextTokens', () => {
  it('measures one API call’s prompt, cached parts included', () => {
    const tokens = parseAssistantContextTokens({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 9,
          cache_read_input_tokens: 18_101,
          cache_creation_input_tokens: 7_447,
          output_tokens: 4,
        },
      },
    });

    expect(tokens).toBe(25_557);
  });

  // Subagents run their own context; counting theirs as the parent's would
  // make compaction fire on the wrong conversation.
  it('skips subagent messages', () => {
    const tokens = parseAssistantContextTokens({
      type: 'assistant',
      parent_tool_use_id: 'toolu_123',
      message: { usage: { input_tokens: 500_000 } },
    });

    expect(tokens).toBeUndefined();
  });

  it('returns undefined when no usage is present', () => {
    expect(parseAssistantContextTokens({ type: 'assistant', message: {} })).toBeUndefined();
  });
});

/**
 * modelUsage is the authoritative record of which models actually served a
 * query — the requested model is only what we asked for.
 */
describe('parseModelUsage / primaryModel', () => {
  const raw = {
    'claude-haiku-4-5-20251001': {
      inputTokens: 524,
      outputTokens: 12,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000584,
      canonicalModel: 'claude-haiku-4-5',
    },
    'claude-opus-5': {
      inputTokens: 9,
      outputTokens: 48,
      cacheReadInputTokens: 22_168,
      cacheCreationInputTokens: 3_374,
      costUSD: 0.0092138,
      canonicalModel: 'claude-opus-5',
    },
  };

  it('maps Claude’s camelCase fields and keeps cost', () => {
    const parsed = parseModelUsage(raw)!;

    expect(parsed['claude-opus-5'].cacheReadTokens).toBe(22_168);
    expect(parsed['claude-opus-5'].cacheWriteTokens).toBe(3_374);
    expect(parsed['claude-opus-5'].costUSD).toBeCloseTo(0.0092138);
  });

  // A query can report both a dated id and an alias; whether those are one
  // model or two is not decidable here, so entries stay separate.
  it('preserves every reported key without merging them', () => {
    const parsed = parseModelUsage(raw)!;

    expect(Object.keys(parsed).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
  });

  it('returns undefined for absent or malformed reports', () => {
    expect(parseModelUsage(undefined)).toBeUndefined();
    expect(parseModelUsage({})).toBeUndefined();
  });
});

/**
 * Which model WAS the agent is stated by the stream, not inferred from token
 * volume: a subagent or side model can out-write the parent, and picking the
 * largest usage entry would then record the wrong model on the session.
 */
describe('parseAssistantModel / canonicalizeModel', () => {
  it('reads the model off a top-level assistant message', () => {
    expect(
      parseAssistantModel({
        type: 'assistant',
        message: { model: 'claude-opus-5', usage: {} },
      })
    ).toBe('claude-opus-5');
  });

  it('ignores subagent messages', () => {
    expect(
      parseAssistantModel({
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { model: 'claude-haiku-4-5' },
      })
    ).toBeUndefined();
  });

  // The case Lumen called out: the secondary model emits far more output than
  // the parent. The reported top-level model must still win.
  it('keeps the parent model when a subagent out-writes it', () => {
    const modelUsage = parseModelUsage({
      'claude-opus-5': {
        inputTokens: 900,
        outputTokens: 40,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 0,
        costUSD: 0.02,
        canonicalModel: 'claude-opus-5',
      },
      'claude-haiku-4-5-20251001': {
        inputTokens: 5_000,
        outputTokens: 25_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.03,
        canonicalModel: 'claude-haiku-4-5',
      },
    });

    const parentEvents = [
      { type: 'assistant', message: { model: 'claude-opus-5' } },
      // Subagent turns interleave and are far chattier.
      { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { model: 'claude-haiku-4-5' } },
    ];
    let reported: string | undefined;
    for (const event of parentEvents) {
      const model = parseAssistantModel(event as Record<string, unknown>);
      if (model) reported = model;
    }

    expect(canonicalizeModel(reported, modelUsage)).toBe('claude-opus-5');
  });

  it('prefers the stable alias over a dated id when one is reported', () => {
    const modelUsage = parseModelUsage({
      'claude-haiku-4-5-20251001': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        canonicalModel: 'claude-haiku-4-5',
      },
    });

    expect(canonicalizeModel('claude-haiku-4-5-20251001', modelUsage)).toBe('claude-haiku-4-5');
    // Unknown to the report: kept verbatim rather than dropped.
    expect(canonicalizeModel('claude-opus-5', modelUsage)).toBe('claude-opus-5');
    expect(canonicalizeModel(undefined, modelUsage)).toBeUndefined();
  });
});

/**
 * The bug this covers is silent: a result line split across stdout chunks
 * parsed as two invalid fragments, both swallowed by the surrounding catch,
 * taking the turn's entire usage and model attribution with it.
 */
describe('createLineReader', () => {
  it('reassembles a JSON line split across chunks', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    const payload = JSON.stringify({ type: 'result', usage: { output_tokens: 42 } });
    const split = Math.floor(payload.length / 2);
    reader.push(payload.slice(0, split));
    reader.push(payload.slice(split) + '\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).usage.output_tokens).toBe(42);
  });

  it('handles many lines arriving in one chunk, and one line across many', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"a":1}\n{"b":2}\n{"c":');
    reader.push('3');
    reader.push('}\n');

    expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  // Claude's final result line frequently arrives without a trailing newline.
  it('emits an unterminated final line on flush', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"type":"result","usage":{"output_tokens":7}}');
    expect(lines).toHaveLength(0);

    reader.flush();
    expect(JSON.parse(lines[0]).usage.output_tokens).toBe(7);
  });

  it('ignores blank lines and flushing an empty buffer', () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('\n\n  \n');
    reader.flush();

    expect(lines).toEqual([]);
  });
});

// ============================================================================
// A resumed prompt must stay lean, even though the runner is handed context
// ============================================================================

describe('ClaudeRunner — resume does not re-inject context', () => {
  const ctx = {
    agent: {
      agentId: 'wren',
      name: 'Wren',
      role: 'dev',
      soul: 'SOUL-BODY',
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: { id: 'u1', timezone: 'UTC', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '9:00 AM',
      currentDate: 'Monday, August 24, 2026',
      dayOfWeek: 'Monday',
      timezone: 'UTC',
      greeting: 'Good morning',
    },
    constitution: { values: 'VALUES-BODY', process: 'PROCESS-BODY', user: 'USER-BODY' },
    knowledgeSummary: 'DIGEST-BODY',
    recentMemories: [],
    activeProjects: [],
  } as never;

  const cfg = {
    workingDirectory: '/tmp',
    mcpConfigPath: '/tmp/.mcp.json',
    agentId: 'wren',
  } as never;

  it('injects on a fresh turn', async () => {
    const runner = new ClaudeRunner();
    let sent = '';
    (runner as any).spawnProcess = vi.fn(async (_a: string[], message: string) => {
      sent = message;
      return { responses: [], toolCalls: [], finalTextResponse: 'ok' };
    });

    await runner.run('hello', { injectedContext: ctx, config: cfg } as never);

    expect(sent).toContain('VALUES-BODY');
  });

  it('does not inject on resume, now that session-service passes context regardless', async () => {
    // session-service hands over injectedContext on every turn so InkRunner can
    // recover from a failed child bootstrap. That makes this guard the only
    // thing keeping a resumed Claude prompt from re-sending the constitution.
    const runner = new ClaudeRunner();
    let sent = '';
    (runner as any).spawnProcess = vi.fn(async (_a: string[], message: string) => {
      sent = message;
      return { responses: [], toolCalls: [], finalTextResponse: 'ok' };
    });

    await runner.run('hello', {
      backendSessionId: 'existing-session',
      injectedContext: ctx,
      config: cfg,
    } as never);

    expect(sent).toBe('hello');
    expect(sent).not.toContain('VALUES-BODY');
  });

  // spec:studio-materialization v8 — the ephemeral-studio root is granted at
  // spawn, unconditionally: a live session can never be granted a new
  // directory, so every worktree minted mid-session must land somewhere
  // already in scope. This grant IS the mechanism that makes the canonical
  // root work; lose it and create_studio/overflow succeed on disk while the
  // session cannot touch the result.
  it('grants --add-dir for the ephemeral-studio root at spawn', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-runner-${process.pid}`);
    try {
      const runner = new ClaudeRunner();
      let capturedArgs: string[] = [];
      (runner as any).spawnProcess = vi.fn(async (a: string[]) => {
        capturedArgs = a;
        return { responses: [], toolCalls: [], finalTextResponse: 'ok' };
      });

      await runner.run('hello', { injectedContext: ctx, config: cfg } as never);

      const granted = capturedArgs
        .map((arg, i) => (arg === '--add-dir' ? capturedArgs[i + 1] : null))
        .filter(Boolean);
      expect(granted).toContain(process.env.INK_STUDIOS_ROOT);
    } finally {
      rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });
});

describe('ClaudeRunner.buildArgs — effort (task 7ea6cdf7)', () => {
  it('forwards --effort to the claude CLI when configured, and never otherwise', () => {
    const runner = new ClaudeRunner();
    const withEffort = (runner as any).buildArgs('session-eff', false, {
      workingDirectory: '/tmp',
      mcpConfigPath: '/tmp/.mcp.json',
      effort: 'xhigh',
    });
    const idx = withEffort.indexOf('--effort');
    expect(idx).toBeGreaterThan(-1);
    expect(withEffort[idx + 1]).toBe('xhigh');

    const without = (runner as any).buildArgs('session-eff2', false, {
      workingDirectory: '/tmp',
      mcpConfigPath: '/tmp/.mcp.json',
    });
    expect(without).not.toContain('--effort');
  });
});
