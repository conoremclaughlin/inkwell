import { describe, expect, it } from 'vitest';
import {
  MAX_CLONES_PER_SPAWN,
  MAX_CLONE_SUMMARY_CHARS,
  SPAWN_AGENT_TOOL,
  boundSummary,
  buildClonePrompt,
  describeCloneToolResult,
  formatFanOutForLedger,
  parseSpawnAgentArgs,
  screenIteration,
} from './spawn-agent.js';
import type { LocalToolCall } from './agent-loop.js';

function call(tool: string): LocalToolCall {
  return { tool, args: {}, raw: `\`\`\`ink-tool\n{"tool":"${tool}"}\n\`\`\`` };
}

describe('parseSpawnAgentArgs', () => {
  it('accepts a well-formed fan-out and defaults to awaiting it', () => {
    const parsed = parseSpawnAgentArgs({
      tasks: [
        { label: 'audit auth paths', prompt: 'Find every auth entry point.' },
        { label: 'map coverage', prompt: 'Which modules lack tests?' },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        wait: true,
        tasks: [
          { label: 'audit auth paths', prompt: 'Find every auth entry point.' },
          { label: 'map coverage', prompt: 'Which modules lack tests?' },
        ],
      },
    });
  });

  it('honours wait:false for background fan-out', () => {
    const parsed = parseSpawnAgentArgs({ tasks: [{ label: 'x', prompt: 'y' }], wait: false });
    expect(parsed.ok && parsed.request.wait).toBe(false);
  });

  it('names an unlabelled task rather than rejecting it', () => {
    const parsed = parseSpawnAgentArgs({ tasks: [{ prompt: 'do the thing' }] });
    expect(parsed.ok && parsed.request.tasks[0].label).toBe('task 1');
  });

  it('rejects a fan-out wider than the ceiling', () => {
    const tasks = Array.from({ length: MAX_CLONES_PER_SPAWN + 1 }, (_, i) => ({
      label: `t${i}`,
      prompt: 'go',
    }));
    const parsed = parseSpawnAgentArgs({ tasks });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/at most 3 tasks/);
  });

  it('rejects malformed input rather than spawning something empty', () => {
    expect(parseSpawnAgentArgs({}).ok).toBe(false);
    expect(parseSpawnAgentArgs({ tasks: [] }).ok).toBe(false);
    expect(parseSpawnAgentArgs({ tasks: ['just a string'] }).ok).toBe(false);
    expect(parseSpawnAgentArgs({ tasks: [{ label: 'x', prompt: '   ' }] }).ok).toBe(false);
  });
});

describe('screenIteration', () => {
  it('truncates an ordinary iteration to the per-iteration cap', () => {
    const calls = ['read', 'grep', 'find', 'ls', 'recall', 'bootstrap'].map(call);
    const verdict = screenIteration(calls, 5);
    expect(verdict.ok && verdict.calls.map((c) => c.tool)).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'recall',
    ]);
  });

  it('lets a lone spawn through', () => {
    const verdict = screenIteration([call(SPAWN_AGENT_TOOL)], 5);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.spawn?.tool).toBe(SPAWN_AGENT_TOOL);
  });

  it('rejects a mixed iteration whole, naming what it was mixed with', () => {
    const verdict = screenIteration([call(SPAWN_AGENT_TOOL), call('read')], 5);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/must be the only tool call/);
    expect(!verdict.ok && verdict.reason).toMatch(/read/);
    // "No calls were executed" is the load-bearing half: a model that thinks
    // some calls may have run will retry against half-applied state.
    expect(!verdict.ok && verdict.reason).toMatch(/No calls were executed/);
  });

  it('catches a spawn hiding beyond the truncation point', () => {
    // Six calls with the spawn last. Screening after .slice(0, 5) would drop it
    // silently; screening the full list refuses the iteration.
    const calls = [...['read', 'grep', 'find', 'ls', 'recall'].map(call), call(SPAWN_AGENT_TOOL)];
    const verdict = screenIteration(calls, 5);
    expect(verdict.ok).toBe(false);
  });

  it('rejects more than one spawn in a turn', () => {
    const verdict = screenIteration([call(SPAWN_AGENT_TOOL), call(SPAWN_AGENT_TOOL)], 5);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/at most once per turn/);
  });

  it('sees through the MCP namespace prefix', () => {
    const verdict = screenIteration([call(`mcp__inkwell__${SPAWN_AGENT_TOOL}`), call('read')], 5);
    expect(verdict.ok).toBe(false);
  });
});

describe('buildClonePrompt', () => {
  it('tells the clone what it is, what survives, and what it cannot do', () => {
    const prompt = buildClonePrompt(
      { label: 'audit auth paths', prompt: 'Find every auth entry point.' },
      { id: 'clone-2', index: 1, total: 3 }
    );
    expect(prompt).toContain('shadow clone');
    expect(prompt).toContain('Clone 2 of 3 (clone-2)');
    expect(prompt).toContain('Find every auth entry point.');
    expect(prompt).toContain('FINAL message');
    expect(prompt).toContain('spawn further clones');
    expect(prompt).toContain('signal_status');
  });
});

describe('boundSummary', () => {
  it('leaves a short summary alone', () => {
    expect(boundSummary('  concise  ')).toBe('concise');
  });

  it('truncates a runaway summary and says so', () => {
    const bounded = boundSummary('x'.repeat(MAX_CLONE_SUMMARY_CHARS + 500));
    expect(bounded.length).toBeLessThan(MAX_CLONE_SUMMARY_CHARS + 120);
    expect(bounded).toMatch(/truncated 500 chars/);
  });

  it('honours a caller-supplied limit', () => {
    expect(boundSummary('abcdef', 3)).toMatch(/^abc\n…\[truncated 3 chars/);
  });
});

describe('formatFanOutForLedger', () => {
  it('renders every clone into one entry', () => {
    const rendered = formatFanOutForLedger([
      { id: 'clone-1', label: 'audit', status: 'completed', summary: 'Found 3 entry points.' },
      { id: 'clone-2', label: 'coverage', status: 'failed', error: 'backend backend-failure' },
    ]);
    expect(rendered).toContain('2 shadow clone(s) returned (1 failed)');
    expect(rendered).toContain('clone-1 · audit — completed');
    expect(rendered).toContain('Found 3 entry points.');
    expect(rendered).toContain('backend backend-failure');
  });

  it('says so plainly when a clone returned nothing', () => {
    const rendered = formatFanOutForLedger([{ id: 'clone-1', label: 'x', status: 'completed' }]);
    expect(rendered).toContain('(no summary returned)');
  });
});

describe('describeCloneToolResult', () => {
  it('passes the payload through when the call ran', () => {
    const payload = { content: [{ type: 'text', text: 'file contents' }] };
    expect(describeCloneToolResult({ status: 'executed', result: payload })).toBe(payload);
    expect(describeCloneToolResult({ status: 'approved', result: payload })).toBe(payload);
  });

  it('reports a refusal from reason', () => {
    expect(
      describeCloneToolResult({ status: 'blocked', reason: 'Tool is explicitly denied by policy.' })
    ).toBe('Tool is explicitly denied by policy.');
  });

  it('reports a thrown tool from error, which lives in a different field', () => {
    // Reading only `reason` here yields undefined, and a clone told
    // "Tool read (error): undefined" learns nothing and retries blind.
    expect(describeCloneToolResult({ status: 'error', error: 'ENOENT: no such file' })).toBe(
      'ENOENT: no such file'
    );
  });

  it('never hands back undefined, whatever the executor omitted', () => {
    expect(describeCloneToolResult({ status: 'error' })).toBe('Tool call error (no detail given).');
  });
});
