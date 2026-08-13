import { describe, it, expect } from 'vitest';
import {
  buildContinuationBody,
  resolveResponseText,
  runAgentLoop,
  type AgentLoopPorts,
  type BackendTurnOutcome,
  type LocalToolCall,
  type ToolResultRecord,
} from './agent-loop.js';

/**
 * The loop was previously inline in runUserTurn's closure and could only be
 * exercised through a live backend. These drive it directly.
 */

function outcome(partial: Partial<BackendTurnOutcome> = {}): BackendTurnOutcome {
  return { success: true, stdout: '', stderr: '', ...partial };
}

function inkTool(tool: string, args: Record<string, unknown> = {}): string {
  return '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```';
}

function signalResult(status: string) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, signal: { status } }) }],
  };
}

/**
 * Ports that record what the loop did. `turns` is the scripted backend: one
 * outcome per invocation, in order.
 */
function makePorts(
  turns: BackendTurnOutcome[],
  executeImpl?: (calls: LocalToolCall[]) => ToolResultRecord[]
) {
  const prompts: Array<{ body: string; isContinuation: boolean }> = [];
  const executed: LocalToolCall[][] = [];
  const lines: string[] = [];
  const events: string[] = [];
  const observed: ToolResultRecord[] = [];
  let waitingStarts = 0;
  let waitingStops = 0;

  const ports: AgentLoopPorts = {
    ui: {
      printLine: (t) => lines.push(t),
      printEvent: (t) => events.push(t),
      startWaiting: () => {
        waitingStarts++;
        return () => {
          waitingStops++;
        };
      },
    },
    transcript: { append: () => {} },
    tools: {
      execute: async (calls) => {
        executed.push(calls);
        return (
          executeImpl?.(calls) ??
          calls.map((c) => ({ tool: c.tool, result: 'ok', status: 'executed', args: c.args }))
        );
      },
    },
    backend: {
      runTurn: async (body, ctx) => {
        prompts.push({ body, isContinuation: ctx.isContinuation });
        return turns[prompts.length - 1] ?? outcome({ stdout: 'fallback' });
      },
    },
    observe: { recordToolCall: (c) => observed.push(c) },
  };

  return {
    ports,
    prompts,
    executed,
    lines,
    events,
    observed,
    waiting: () => [waitingStarts, waitingStops],
  };
}

describe('resolveResponseText', () => {
  it('prefers parsed responseText over raw stdout (streaming NDJSON must never leak)', () => {
    expect(
      resolveResponseText(outcome({ responseText: 'hello', stdout: '{"type":"event"}' }))
    ).toBe('hello');
  });

  it('falls back to stdout when there is no parsed text', () => {
    expect(resolveResponseText(outcome({ stdout: 'raw out' }))).toBe('raw out');
  });

  it('falls back to stderr when both are empty', () => {
    expect(resolveResponseText(outcome({ stderr: 'boom' }))).toBe('boom');
  });

  it('never returns empty — the ledger needs something', () => {
    expect(resolveResponseText(outcome())).toBe('(no output)');
  });
});

describe('buildContinuationBody', () => {
  it('summarizes each tool result', () => {
    const body = buildContinuationBody(
      [{ tool: 'read', result: 'file contents', status: 'executed' }],
      []
    );
    expect(body).toContain('Tool read (executed): file contents');
  });

  it('appends a format correction only when a call used the XML variant', () => {
    const results: ToolResultRecord[] = [{ tool: 'read', result: 'x', status: 'executed' }];
    const plain = buildContinuationBody(results, [{ tool: 'read', args: {}, raw: '' }]);
    const variant = buildContinuationBody(results, [
      { tool: 'read', args: {}, raw: '', variantFormat: true },
    ]);
    expect(plain).not.toContain('FORMAT NOTE');
    expect(variant).toContain('FORMAT NOTE');
  });
});

describe('runAgentLoop', () => {
  it('returns after one turn when no tools were requested', async () => {
    const { ports, prompts } = makePorts([outcome({ responseText: 'just an answer' })]);
    const result = await runAgentLoop({ prompt: 'hi', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('no-tools');
    expect(result.iterations).toBe(0);
    expect(result.assistantDisplayText).toBe('just an answer');
    expect(prompts).toHaveLength(1);
  });

  it('never extracts tool calls when routing is backend-side', async () => {
    const { ports, executed } = makePorts([outcome({ responseText: inkTool('read') })]);
    const result = await runAgentLoop({ prompt: 'hi', toolRouting: 'backend' }, ports);

    expect(executed).toHaveLength(0);
    expect(result.stopReason).toBe('no-tools');
    // The block is left intact for a backend that routes its own tools.
    expect(result.assistantDisplayText).toContain('ink-tool');
  });

  it('executes tools and re-invokes the backend with the results', async () => {
    const { ports, prompts, executed } = makePorts([
      outcome({ responseText: `working${inkTool('read', { path: 'a.ts' })}` }),
      outcome({ responseText: 'done' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(executed[0][0].tool).toBe('read');
    expect(prompts[1].isContinuation).toBe(true);
    expect(prompts[1].body).toContain('Tool read (executed)');
    expect(result.iterations).toBe(1);
    expect(result.assistantDisplayText).toBe('done');
  });

  it('strips tool blocks from the display text', async () => {
    const { ports } = makePorts([
      outcome({ responseText: `here you go${inkTool('read')}` }),
      outcome({ responseText: 'finished' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);
    expect(result.assistantDisplayText).not.toContain('ink-tool');
  });

  it('stops on a terminal signal even when real work ran alongside it', async () => {
    // The 3 PM heartbeat shape — the multiplication regression.
    const { ports, prompts } = makePorts(
      [
        outcome({ responseText: inkTool('signal_status') }),
        outcome({ responseText: 'unreachable' }),
      ],
      () => [
        { tool: 'send_response', result: 'sent', status: 'executed' },
        { tool: 'signal_status', result: signalResult('completed'), status: 'executed' },
      ]
    );
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('terminal-signal');
    expect(prompts).toHaveLength(1); // no continuation — this is the 4x-signal bug
  });

  it('honors a lowered iteration budget and reports hitting it', async () => {
    const turns = Array.from({ length: 10 }, () => outcome({ responseText: inkTool('read') }));
    const { ports, lines } = makePorts(turns);
    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 2 },
      ports
    );

    expect(result.stopReason).toBe('iteration-cap');
    expect(result.iterations).toBe(2);
    expect(lines.join(' ')).toContain('tool loop limit reached');
  });

  it('stops when a continuation turn fails', async () => {
    const { ports } = makePorts([
      outcome({ responseText: `partial answer${inkTool('read')}` }),
      outcome({ success: false, stderr: 'backend exploded', exitCode: 1 }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('backend-failure');
    expect(result.success).toBe(false);
  });

  /**
   * Pre-refactor, a failed continuation broke the loop WITHOUT re-resolving the
   * response text, so the REPL still displayed (and the ledger still stored) the
   * preceding successful turn. Publishing the failed spawn's stderr as the
   * assistant's answer would leak backend diagnostics into the conversation and
   * into turn_end hooks. The host reports stderr separately.
   */
  it('preserves the last successful response when a continuation fails', async () => {
    const { ports } = makePorts([
      outcome({ responseText: `partial answer${inkTool('read')}` }),
      outcome({ success: false, stderr: 'backend exploded', exitCode: 1 }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.responseText).toContain('partial answer');
    expect(result.responseText).not.toContain('backend exploded');
    expect(result.assistantDisplayText).toContain('partial answer');
    expect(result.assistantDisplayText).not.toContain('backend exploded');
  });

  /**
   * stopReason is load-bearing: a clone reports it to its parent to say whether
   * work finished. An opening turn that fails and parses no tool calls must not
   * exit via the `no-tools` branch, or failed work reads as completed work.
   */
  it('classifies a failed opening turn as backend-failure, not no-tools', async () => {
    const { ports } = makePorts([
      outcome({ success: false, stderr: 'backend failed', exitCode: 1 }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('backend-failure');
    expect(result.success).toBe(false);
    expect(result.iterations).toBe(0);
  });

  it('still reports abort (exit >=128) as aborted, not backend-failure', async () => {
    const { ports } = makePorts([outcome({ success: false, exitCode: 137, stderr: 'killed' })]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('aborted');
  });

  it('does not misreport a successful no-tools turn as a failure', async () => {
    const { ports } = makePorts([outcome({ responseText: 'all done' })]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('no-tools');
    expect(result.success).toBe(true);
  });

  it('reports an aborted turn with no display text', async () => {
    // SIGINT kills the child; exit codes >=128 are signal deaths.
    const { ports } = makePorts([outcome({ success: false, exitCode: 130, stderr: 'cancelled' })]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.stopReason).toBe('aborted');
    expect(result.assistantDisplayText).toBe('');
  });

  it('accumulates tool results across iterations', async () => {
    const { ports } = makePorts([
      outcome({ responseText: inkTool('read') }),
      outcome({ responseText: inkTool('grep') }),
      outcome({ responseText: 'done' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(result.toolResults.map((r) => r.tool)).toEqual(['read', 'grep']);
  });

  it('always stops the waiting indicator it started, even when a turn throws', async () => {
    const { ports, waiting } = makePorts([outcome({ responseText: inkTool('read') })]);
    ports.backend.runTurn = async (_body, ctx) => {
      if (ctx.isContinuation) throw new Error('spawn failed');
      return outcome({ responseText: inkTool('read') });
    };

    await expect(runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports)).rejects.toThrow(
      'spawn failed'
    );
    const [starts, stops] = waiting();
    expect(starts).toBe(1);
    expect(stops).toBe(1);
  });

  it('caps tool calls per iteration', async () => {
    const many = Array.from({ length: 9 }, (_, i) => inkTool(`tool_${i}`)).join('\n');
    const { ports, executed } = makePorts([
      outcome({ responseText: many }),
      outcome({ responseText: 'done' }),
    ]);
    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);

    expect(executed[0]).toHaveLength(5);
  });

  it('feeds the observe port when present, and works without one', async () => {
    const { ports, observed } = makePorts([
      outcome({ responseText: inkTool('read') }),
      outcome({ responseText: 'done' }),
    ]);
    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, ports);
    expect(observed.map((o) => o.tool)).toEqual(['read']);

    // A shadow clone omits observe entirely — it must not blow up.
    const bare = makePorts([
      outcome({ responseText: inkTool('read') }),
      outcome({ responseText: 'done' }),
    ]);
    delete bare.ports.observe;
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, bare.ports);
    expect(result.toolResults).toHaveLength(1);
  });
});
