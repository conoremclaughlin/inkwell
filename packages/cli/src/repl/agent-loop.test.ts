import { describe, it, expect } from 'vitest';
import {
  buildContinuationBody,
  buildFinalRelayBody,
  extractLocalToolCalls,
  hasUnseenFailure,
  resolveResponseText,
  runAgentLoop,
  MAX_TOOL_CALLS_PER_ITERATION,
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

describe('runAgentLoop — iteration screening', () => {
  it('screens the FULL extracted list, not the truncated one', async () => {
    const seen: LocalToolCall[][] = [];
    const harness = makePorts([
      outcome({
        responseText: ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => inkTool(t)).join('\n'),
      }),
    ]);
    harness.ports.tools.screen = (all) => {
      seen.push(all);
      return { calls: all.slice(0, 2) };
    };

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // Six emitted, all six offered to the screen, two executed. A rule about
    // what may accompany what cannot be enforced on a truncated list.
    expect(seen[0].map((c) => c.tool)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(harness.executed[0].map((c) => c.tool)).toEqual(['a', 'b']);
  });

  it('refuses a rejected iteration whole and feeds the reason back', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('spawn_agent') + '\n' + inkTool('read') }),
      outcome({ responseText: 'ok, spawning alone next time' }),
    ]);
    let screened = 0;
    harness.ports.tools.screen = (all) =>
      screened++ === 0 ? { rejected: 'spawn_agent must be alone' } : { calls: all };

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // Nothing ran.
    expect(harness.executed).toEqual([]);
    // The model was told why, in a continuation.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].isContinuation).toBe(true);
    expect(harness.prompts[1].body).toContain('spawn_agent must be alone');
    expect(result.toolResults).toEqual([
      { tool: 'iteration', result: 'spawn_agent must be alone', status: 'rejected' },
    ]);
    expect(result.stopReason).toBe('no-tools');
  });

  it('counts a rejected iteration against the budget so a stuck model stops', async () => {
    const turns = Array.from({ length: 6 }, () =>
      outcome({ responseText: inkTool('spawn_agent') + '\n' + inkTool('read') })
    );
    const harness = makePorts(turns);
    harness.ports.tools.screen = () => ({ rejected: 'spawn_agent must be alone' });

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 3 },
      harness.ports
    );

    expect(result.stopReason).toBe('iteration-cap');
    expect(result.iterations).toBe(3);
    expect(harness.executed).toEqual([]);
  });

  it('stops on a backend failure while re-prompting after a rejection', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('spawn_agent') + '\n' + inkTool('read') }),
      outcome({ success: false, stderr: 'backend exploded', exitCode: 1 }),
    ]);
    harness.ports.tools.screen = () => ({ rejected: 'nope' });

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(result.stopReason).toBe('backend-failure');
    expect(result.success).toBe(false);
  });

  it('truncates to the per-iteration cap when no screen is supplied', async () => {
    const harness = makePorts([
      outcome({
        responseText: ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => inkTool(t)).join('\n'),
      }),
    ]);

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(harness.executed[0]).toHaveLength(5);
  });
});

describe('runAgentLoop — refused iterations', () => {
  const blocked = (tool: string): ToolResultRecord => ({
    tool,
    result: 'Tool is explicitly denied by policy.',
    status: 'blocked',
  });

  it('distinguishes "everything was refused" from "it stopped asking"', async () => {
    const harness = makePorts([outcome({ responseText: inkTool('bash') })], () => [
      blocked('bash'),
    ]);

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // Not 'no-tools': the agent DID ask, and was refused. For a clone the
    // difference decides whether the parent reads the summary as an answer.
    expect(result.stopReason).toBe('all-refused');
  });

  it('leaves the REPL turn to end on refusal, where a human is watching', async () => {
    const harness = makePorts(
      [outcome({ responseText: inkTool('bash') }), outcome({ responseText: 'second turn' })],
      () => [blocked('bash')]
    );

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    // One turn only — the user saw the refusal and can redirect; re-prompting
    // would nag someone who already said no.
    expect(harness.prompts).toHaveLength(1);
  });

  it('tells a clone it was refused and lets it route around', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: inkTool('bash') }),
        outcome({ responseText: `read it instead\n${inkTool('signal_status')}` }),
      ],
      (calls) =>
        calls.map((c) =>
          c.tool === 'bash'
            ? blocked('bash')
            : { tool: c.tool, result: signalResult('completed'), status: 'executed' }
        )
    );

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', continueOnBlocked: true },
      harness.ports
    );

    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].isContinuation).toBe(true);
    expect(harness.prompts[1].body).toContain('every one was refused');
    expect(harness.prompts[1].body).toContain('Do not retry them');
    expect(result.stopReason).toBe('terminal-signal');
  });

  it('gives up honestly when a clone keeps hitting the wall', async () => {
    const harness = makePorts(
      Array.from({ length: 5 }, () => outcome({ responseText: inkTool('bash') })),
      () => [blocked('bash')]
    );

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', continueOnBlocked: true, maxIterations: 3 },
      harness.ports
    );

    // Bounded, and reported as refused rather than as a completed turn.
    expect(result.iterations).toBe(3);
    expect(result.stopReason).toBe('all-refused');
  });

  /**
   * A failure is not a refusal, and the advice for each is the opposite.
   *
   * After #552 an unrecognized failure reaches this body — and was met with
   * "every one was refused. Do not retry them.", talking the agent out of the
   * one move that works when a validation error has just named the bad field.
   */
  it('tells an agent to fix and retry when the call FAILED, not to give up', () => {
    const body = buildContinuationBody(
      [
        {
          tool: 'create_reminder',
          result: 'MCP error -32602: Invalid datetime at runAt',
          status: 'error',
        },
      ],
      []
    );

    expect(body).toContain('FAILED rather than being refused');
    expect(body).toContain('fix it and try again');
    // The refusal advice must not appear — it is the opposite instruction.
    expect(body).not.toContain('Do not retry them');
  });

  it('still tells an agent to stop when every call was genuinely refused', () => {
    const body = buildContinuationBody([{ tool: 'bash', result: 'denied', status: 'blocked' }], []);

    expect(body).toContain('every one was refused');
    expect(body).toContain('Do not retry them');
  });

  it('leads with the failure when refusals and failures are mixed', () => {
    // Nothing ran either way, but only the failure is actionable.
    const body = buildContinuationBody(
      [
        { tool: 'bash', result: 'denied by policy', status: 'blocked' },
        { tool: 'send_response', result: 'upstream 502', status: 'error' },
      ],
      []
    );

    expect(body).toContain('FAILED rather than being refused');
    expect(body).not.toContain('Do not retry them');
  });

  it('does not add the refusal note when something did run', async () => {
    const body = buildContinuationBody(
      [
        { tool: 'read', result: 'contents', status: 'executed' },
        { tool: 'bash', result: 'denied', status: 'blocked' },
      ],
      []
    );
    expect(body).not.toContain('every one was refused');
  });
});

describe('runAgentLoop — final relay at the iteration cap (PR #491 port)', () => {
  it("relays the capped iteration's results in one FINAL turn — no execution of its blocks", async () => {
    // Every scripted turn emits a tool call, so the loop runs to the cap.
    const harness = makePorts([
      outcome({ responseText: `t1 ${inkTool('send_response', { content: 'hi' })}` }),
      outcome({ responseText: `t2 ${inkTool('send_response', { content: 'hi' })}` }),
      // The relay's output — contains an ink-tool block that must NOT run.
      outcome({ responseText: `final answer ${inkTool('remember', { content: 'nope' })}` }),
    ]);

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 2 },
      harness.ports
    );

    expect(result.stopReason).toBe('iteration-cap');
    // Opening turn + 1 continuation + the final relay = 3 prompts.
    expect(harness.prompts).toHaveLength(3);
    expect(harness.prompts[2]!.body).toContain('[Tool results from previous turn — FINAL]');
    expect(harness.prompts[2]!.body).toContain('no further tool calls will be executed');
    // The capped iteration executed twice; the relay's block never ran.
    expect(harness.executed).toHaveLength(2);
    // The relay's text is the final answer.
    expect(result.responseText).toContain('final answer');
  });

  it('does NOT relay after a terminal signal, even at the cap', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: inkTool('signal_status', { status: 'completed' }) }),
        outcome({ responseText: 'should never be requested' }),
      ],
      (calls) =>
        calls.map((c) => ({
          tool: c.tool,
          result: signalResult('completed'),
          status: 'executed',
          args: c.args,
        }))
    );

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 1 },
      harness.ports
    );

    expect(result.stopReason).toBe('terminal-signal');
    expect(harness.prompts).toHaveLength(1);
  });

  it('a failed relay keeps the last successful text', async () => {
    const harness = makePorts([
      outcome({ responseText: `working ${inkTool('send_response', { content: 'hi' })}` }),
      outcome({ responseText: `still working ${inkTool('send_response', { content: 'hi' })}` }),
      outcome({ success: false, exitCode: 1, stderr: 'relay boom' }),
    ]);

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 2 },
      harness.ports
    );

    expect(result.stopReason).toBe('iteration-cap');
    // The failed relay's stderr must not become the answer.
    expect(result.responseText).toContain('still working');
    expect(result.responseText).not.toContain('relay boom');
  });

  it('does NOT relay when a screen rejection is what reached the cap', async () => {
    const harness = makePorts([
      outcome({ responseText: `t1 ${inkTool('send_response', { content: 'hi' })}` }),
      outcome({ responseText: `t2 ${inkTool('spawn_agent')}\n${inkTool('read')}` }),
      outcome({ responseText: 'should never be requested' }),
    ]);
    // Iteration 1 passes the screen and executes; iteration 2 is refused whole,
    // and that refusal is what hits the cap.
    let screened = 0;
    harness.ports.tools.screen = (all) =>
      screened++ === 0 ? { calls: all } : { rejected: 'spawn_agent must be alone' };

    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 2 },
      harness.ports
    );

    expect(result.stopReason).toBe('iteration-cap');
    // Opening turn + 1 continuation. A third turn would relay iteration 1's
    // already-seen results and bury iteration 2's refusal.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts.some((p) => p.body.includes('FINAL'))).toBe(false);
    expect(harness.executed).toHaveLength(1);
    // The refusal is what ended the turn, and it is on the record.
    expect(result.toolResults.at(-1)).toEqual({
      tool: 'iteration',
      result: 'spawn_agent must be alone',
      status: 'rejected',
    });
  });
});

describe('extractLocalToolCalls namespace stripping', () => {
  // The two extraction paths must AGREE. The XML variant has stripped since
  // 2026-08-10; the fence had not, so the older rarer format was the correct
  // one and the primary path shipped the bug. Asserting them against each
  // OTHER — rather than against what I believe each does — is what makes this
  // catch the next divergence instead of encoding today's.
  it('strips the MCP namespace identically in both formats', () => {
    const fenced = extractLocalToolCalls(
      '```ink-tool\n{"tool":"mcp__inkwell__signal_status","args":{"status":"completed"}}\n```'
    );
    const variant = extractLocalToolCalls(
      '<tool_call>{"name":"mcp__inkwell__signal_status","arguments":{"status":"completed"}}</tool_call>'
    );

    expect(fenced[0].tool).toBe(variant[0].tool);
    expect(fenced[0].tool).toBe('signal_status');
    expect(fenced[0].args).toEqual(variant[0].args);
  });

  it('leaves a foreign namespace intact so the dispatcher can explain it', () => {
    // Only `mcp__inkwell__` is ours to strip. `mcp__github__list_issues` must
    // reach the dispatcher whole, or the refusal cannot name the missing server.
    const calls = extractLocalToolCalls(
      '```ink-tool\n{"tool":"mcp__github__list_issues","args":{}}\n```'
    );
    expect(calls[0].tool).toBe('mcp__github__list_issues');
  });

  it('leaves a bare name untouched', () => {
    const calls = extractLocalToolCalls(
      '```ink-tool\n{"tool":"bash","args":{"command":"ls"}}\n```'
    );
    expect(calls[0].tool).toBe('bash');
  });
});

/**
 * An error alone in a turn used to vanish (Myra, 2026-08-31).
 *
 * She ran the controlled experiment: the SAME create_reminder with the SAME
 * invalid `runAt` returned a precise `-32602 Invalid datetime, path: ["runAt"]`
 * when it shared a turn with a call that succeeded, and returned NOTHING AT ALL
 * when it was the only call. One success makes `hasExecutedTools` true, so the
 * loop stays alive and relays. Alone, `all-refused` ended the turn before
 * buildContinuationBody and the message died in allToolResults.
 *
 * The failure mode is worst under careful method: she hit it three times while
 * deliberately isolating one variable per turn, which is precisely the shape
 * that hides it.
 */
describe('runAgentLoop — an error that nobody witnessed', () => {
  const errored = (tool: string): ToolResultRecord => ({
    tool,
    result: 'MCP error -32602: Invalid arguments for create_reminder: Invalid datetime at runAt',
    status: 'error',
  });
  const blocked = (tool: string): ToolResultRecord => ({
    tool,
    result: 'Tool is explicitly denied by policy.',
    status: 'blocked',
  });

  it('relays a sole failing call to the model instead of ending on silence', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: inkTool('create_reminder') }),
        outcome({ responseText: 'The reminder was rejected: runAt must be a UTC instant.' }),
      ],
      () => [errored('create_reminder')]
    );

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // The relay turn happened, and it carried the actual validation message —
    // the thing that existed the whole time and nobody could see.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('Invalid datetime');
    expect(harness.prompts[1].body).toContain('FINAL');
    // And the agent's answer is the relay's, not a confident silence.
    expect(result.assistantDisplayText).toContain('rejected');
  });

  it('is not sensitive to turn composition — the whole bug was that it was', async () => {
    // Same tool, same error, but sharing the turn with a success. This path
    // always worked; pinning it stops a fix that only repairs the lonely case.
    const harness = makePorts(
      [
        outcome({
          responseText: `${inkTool('recall')}
${inkTool('create_reminder')}`,
        }),
        outcome({
          responseText: `noted
${inkTool('signal_status')}`,
        }),
      ],
      (calls) =>
        calls.map((c) =>
          c.tool === 'create_reminder'
            ? errored('create_reminder')
            : c.tool === 'signal_status'
              ? { tool: c.tool, result: signalResult('completed'), status: 'executed' }
              : { tool: c.tool, result: 'ok', status: 'executed' }
        )
    );

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    expect(harness.prompts[1].body).toContain('Invalid datetime');
  });

  it('still ends quietly on a witnessed refusal, so nobody is nagged for saying no', async () => {
    const harness = makePorts(
      [outcome({ responseText: inkTool('bash') }), outcome({ responseText: 'second turn' })],
      () => [blocked('bash')]
    );

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // One turn. A denial was authored by someone who saw it happen; relaying it
    // would re-prompt a human who already declined.
    expect(harness.prompts).toHaveLength(1);
  });
});

describe('hasUnseenFailure', () => {
  it('counts a thrown call, which nothing displayed', () => {
    expect(hasUnseenFailure([{ status: 'error' }])).toBe(true);
  });

  // Authored outcomes: someone clicked no, wrote the rule, or the screen
  // refused the iteration and the loop already fed that reason back.
  it.each(['blocked', 'denied', 'rejected'])('does not count a witnessed %s', (status) => {
    expect(hasUnseenFailure([{ status }])).toBe(false);
  });

  it('does not count a clean iteration', () => {
    expect(hasUnseenFailure([{ status: 'executed' }, { status: 'approved' }])).toBe(false);
  });

  /**
   * THE DEFAULT — the actual thing under discussion.
   *
   * Every other case here tests a status somebody already thought of. This one
   * tests what happens to a status nobody has defined, which is the only way to
   * pin the DIRECTION of the predicate rather than its current contents.
   *
   * Keyed as `status === 'error'` this fails. As a denylist of authored
   * refusals it passes, and it keeps passing when a transport layer invents
   * 'timeout' in 2027 without reading this file. An allowlist of failure kinds
   * can only ever be wrong toward silence, which is the defect this repairs.
   */
  it('treats an unrecognized terminal status as unseen — loud by default', () => {
    expect(hasUnseenFailure([{ status: 'timeout' }])).toBe(true);
    expect(hasUnseenFailure([{ status: 'quota-exhausted' }])).toBe(true);
    expect(hasUnseenFailure([{ status: 'some-status-nobody-has-written-yet' }])).toBe(true);
  });
});

/**
 * The heartbeat shape (Lumen, PR #552 review).
 *
 * `send_response: error` + `signal_status(completed): executed` in one
 * iteration stopped as `terminal-signal` — which is checked BEFORE anything
 * else and never populated relayResults. The agent exited believing it had
 * delivered. That is the Aug 13 Telegram audio drop the final relay exists to
 * prevent, arriving through the one branch the relay never covered.
 *
 * It is also the most common turn shape in this fleet: work, send_response,
 * remember, signal_status(completed).
 */
describe('runAgentLoop — a terminal signal alongside a failure', () => {
  it('relays the delivery failure instead of exiting as if it had sent', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: `${inkTool('send_response')}\n${inkTool('signal_status')}` }),
        outcome({ responseText: 'the Telegram send failed; I have not delivered it' }),
      ],
      () => [
        { tool: 'send_response', result: 'upstream 502 from telegram', status: 'error' },
        { tool: 'signal_status', result: signalResult('completed'), status: 'executed' },
      ]
    );

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // Terminal semantics preserved — this is still a completed turn.
    expect(result.stopReason).toBe('terminal-signal');
    // But the failure reached the model.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('upstream 502');
    expect(harness.prompts[1].body).toContain('FINAL');
    expect(result.assistantDisplayText).toContain('not delivered');
    // And nothing re-executed: the relay's output is not extracted, so the
    // signal cannot be multiplied. One iteration of tools, exactly.
    expect(harness.executed).toHaveLength(1);
  });

  it('still exits silently when the terminal iteration is clean', async () => {
    // The 4x-signal_status multiplication guard, unchanged: a completed turn
    // with nothing wrong must not earn an extra backend round-trip.
    const harness = makePorts(
      [
        outcome({ responseText: inkTool('signal_status') }),
        outcome({ responseText: 'unreachable' }),
      ],
      () => [
        { tool: 'send_response', result: 'sent', status: 'executed' },
        { tool: 'signal_status', result: signalResult('completed'), status: 'executed' },
      ]
    );

    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    expect(result.stopReason).toBe('terminal-signal');
    expect(harness.prompts).toHaveLength(1);
  });
});

describe('an unrecognized failure status reaches the model', () => {
  // The same default, driven through the whole loop rather than the predicate:
  // a status invented outside this file must still reach the continuation body.
  it('relays a terminal status that appears in neither list', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: inkTool('send_response') }),
        outcome({ responseText: 'the send timed out; retrying next turn' }),
      ],
      () => [{ tool: 'send_response', result: 'upstream timed out after 30s', status: 'timeout' }]
    );

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('upstream timed out');
  });
});

/**
 * The per-iteration cap discarded calls in silence (Myra, 3 Sep 2026).
 *
 * She emitted 8 update_memory calls; 5 ran. The results block that came back
 * listed only the survivors, with no count and no gap — well-formed, internally
 * consistent, and describing less work than she had asked for. The 3 that
 * vanished were downgrading critical-salience memories asserting a security
 * compromise that had not happened. She caught it only by reading back.
 *
 * Her framing, and the reason these tests assert shape rather than the number:
 * "The dropped calls were indistinguishable from calls never made."
 */
describe('silently dropped tool calls (the per-iteration cap)', () => {
  const call = (tool: string): LocalToolCall => ({ tool, args: {} });
  const ran = (tool: string): ToolResultRecord => ({ tool, result: 'ok', status: 'executed' });

  describe('buildContinuationBody', () => {
    it('names the calls that did not run, and both counts', () => {
      const body = buildContinuationBody(
        [ran('a'), ran('b')],
        [call('a'), call('b')],
        [call('c'), call('d')]
      );

      expect(body).toContain('c, d');
      // Both sides of the gap: what was asked for and what happened.
      expect(body).toContain('4 tool calls');
      expect(body).toContain('2 reached the tool runner');
      expect(body).toContain('Do not report them as done');
    });

    /**
     * The control. Without it, a body that ALWAYS warned would pass the test
     * above while telling every turn its calls were dropped.
     */
    it('says nothing about drops when nothing was dropped', () => {
      const body = buildContinuationBody([ran('a')], [call('a')]);
      expect(body).not.toContain('never reached it at all');
      expect(body).not.toContain('reached the tool runner');
    });
  });

  describe('buildFinalRelayBody', () => {
    it('names undelivered calls when the loop is ending', () => {
      const body = buildFinalRelayBody([ran('a')], [call('late')]);
      expect(body).toContain('NOT EXECUTED');
      expect(body).toContain('late');
    });

    it('stays quiet when every call ran', () => {
      expect(buildFinalRelayBody([ran('a')])).not.toContain('NOT EXECUTED');
    });
  });

  /**
   * Round two, both Lumen's (PR #573).
   */
  describe('stranded drops at the end of a turn', () => {
    /**
     * P1. `lastNotRunCount` was mirrored outward so the final relay could carry
     * it — but the gate still asked only about stranded RESULTS. With a clean
     * terminal signal every result is `executed`, so hasUnseenFailure is false,
     * relayResults stays empty, and the door the mirroring was built for never
     * opens. The capped calls vanish under the signal.
     */
    it('relays the drops when a terminal signal ends the turn', async () => {
      const emitted = ['m1', 'm2', 'm3', 'm4', 'signal_status', 'm6', 'm7', 'm8'];
      const harness = makePorts(
        [
          outcome({ stdout: emitted.map((t) => inkTool(t)).join('\n') }),
          outcome({ stdout: 'final answer' }),
        ],
        (calls) =>
          calls.map((c) => ({
            tool: c.tool,
            result: c.tool === 'signal_status' ? signalResult('completed') : 'ok',
            status: 'executed',
          }))
      );

      const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      expect(result.stopReason).toBe('terminal-signal');
      // The turn ends, but not before the agent is told what the cap ate.
      expect(harness.prompts).toHaveLength(2);
      const relay = harness.prompts[1]!.body;
      expect(relay).toContain('NOT EXECUTED');
      for (const tool of ['m6', 'm7', 'm8']) expect(relay).toContain(tool);
    });

    it('still stays quiet on a terminal signal with nothing stranded', async () => {
      const harness = makePorts(
        [outcome({ stdout: inkTool('signal_status') }), outcome({ stdout: 'unreachable' })],
        () => [{ tool: 'signal_status', result: signalResult('completed'), status: 'executed' }]
      );

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
      // No drops, no failures — the agent knows what it signaled. One prompt.
      expect(harness.prompts).toHaveLength(1);
    });
  });

  /**
   * P2. The count proves how many calls REACHED the runner, not how many
   * executed. Five blocked results plus three capped calls previously said both
   * "none of those calls ran" and "only 5 ran" in the same body.
   */
  describe('the count does not claim execution it cannot prove', () => {
    it('does not contradict the all-refused note', () => {
      const blocked: ToolResultRecord[] = ['a', 'b', 'c', 'd', 'e'].map((t) => ({
        tool: t,
        result: 'denied by policy',
        status: 'blocked',
      }));
      const body = buildContinuationBody(
        blocked,
        blocked.map((r) => call(r.tool)),
        [call('f'), call('g'), call('h')]
      );

      // Both statements have to be able to coexist without lying.
      expect(body).toContain('none of those calls ran');
      expect(body).not.toContain('only 5 ran');
      expect(body).toContain('reached the tool runner');
      expect(body).toContain('never reached it at all');
      expect(body).toContain('f, g, h');
    });
  });

  /**
   * Naming is only safe while the names are right (Myra's own correction to her
   * own argument, 3 Sep 2026).
   *
   * The identity filter is a reference comparison. A host `screen` that rebuilds
   * its call objects matches nothing, so every emitted call looks dropped —
   * including the ones that ran. She argued naming beats counting, then attached
   * the precondition: a false "create_reminder did not run" is WORSE than a
   * count, because it is a positive instruction to re-run a write that
   * succeeded, in the runtime's own voice. #553's do-not-retry problem with the
   * sign flipped.
   */
  describe('when call identity cannot be trusted', () => {
    it('gives the count and refuses to name, rather than naming wrongly', () => {
      // Identity says "all 3 dropped"; arithmetic says only 1 did. They
      // disagree, so the names are not describing this event.
      const body = buildContinuationBody([ran('a'), ran('b')], [call('a'), call('b')], [], 1);

      expect(body).toContain('CANNOT TELL YOU WHICH');
      expect(body).toContain('3 tool calls');
      expect(body).toContain('2 reached the tool runner');
      expect(body).toContain('read back the current state');
      // The whole point: it must not assert a name it cannot stand behind.
      expect(body).not.toMatch(/NOT executed and had no effect/);
    });

    it('never names a call that actually ran, even with a rebuilding screen', async () => {
      const emitted = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
      const harness = makePorts([
        outcome({ stdout: emitted.map((t) => inkTool(t)).join('\n') }),
        outcome({ stdout: 'done' }),
      ]);
      // A screen that truncates correctly but returns NEW objects — the exact
      // shape that defeats a reference comparison.
      harness.ports.tools.screen = (all) => ({
        calls: all.slice(0, 5).map((c) => ({ ...c })),
      });

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      const continuation = harness.prompts[1]!.body;
      // Two ran and two did not; a naive identity filter would name all seven.
      expect(continuation).toContain('CANNOT TELL YOU WHICH');
      for (const tool of ['m1', 'm2', 'm3', 'm4', 'm5']) {
        expect(continuation).not.toContain(`effect: ${tool}`);
      }
      // The count still has to be right and still has to be stated.
      expect(continuation).toContain('7 tool calls');
      expect(continuation).toContain('5 reached the tool runner');
      expect(harness.events.join('\n')).toContain('not determinable');
    });

    it('final relay refuses to name for the same reason', () => {
      const body = buildFinalRelayBody([ran('a')], [], 2);
      expect(body).toContain('NOT EXECUTED');
      expect(body).toContain('cannot identify which');
      expect(body).toContain('2 emitted calls');
    });
  });

  /**
   * Myra's measurement, end to end: 8 emitted -> 5 executed, and the three that
   * did not run are named back to the model. Written against the constant
   * rather than the literal 5 — the defect is the silence, not the number.
   */
  it('executes up to the cap and tells the model which calls it dropped', async () => {
    const emitted = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
    const harness = makePorts([
      outcome({ stdout: emitted.map((t) => inkTool(t)).join('\n') }),
      outcome({ stdout: 'done' }),
    ]);

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    const honored = emitted.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
    const skipped = emitted.slice(MAX_TOOL_CALLS_PER_ITERATION);

    expect(harness.executed[0]!.map((c) => c.tool)).toEqual(honored);

    // The point: the continuation must name what did NOT run. Before this, the
    // model saw five results and no indication three calls had been discarded.
    const continuation = harness.prompts[1]!.body;
    for (const tool of skipped) expect(continuation).toContain(tool);
    expect(continuation).toContain(`${emitted.length} tool calls`);
    expect(continuation).toContain(`${honored.length} reached the tool runner`);

    // And a human watching the terminal sees it too.
    expect(harness.events.join('\n')).toContain('not run');
  });

  /**
   * Her second sample, which is the control: 4 emitted, 4 executed, and no
   * note. A warning that fires on every turn is its own kind of lie.
   */
  it('says nothing when every emitted call fits under the cap', async () => {
    const emitted = ['m1', 'm2', 'm3', 'm4'].slice(0, MAX_TOOL_CALLS_PER_ITERATION);
    const harness = makePorts([
      outcome({ stdout: emitted.map((t) => inkTool(t)).join('\n') }),
      outcome({ stdout: 'done' }),
    ]);

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    expect(harness.executed[0]).toHaveLength(emitted.length);
    expect(harness.prompts[1]!.body).not.toContain('reached the tool runner');
    expect(harness.events.join('\n')).not.toContain('not run');
  });
});
