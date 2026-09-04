import { describe, it, expect } from 'vitest';
import {
  buildContinuationBody,
  buildFinalRelayBody,
  reconcileSelection,
  snapshotCalls,
  extractLocalToolCalls,
  findImitatedToolResults,
  hasUnseenFailure,
  isPotentialImitationPrefix,
  resolveResponseText,
  runAgentLoop,
  MAX_TOOL_CALLS_PER_ITERATION,
  type AgentLoopPorts,
  type BackendTurnOutcome,
  MAX_RELAY_BYTES,
  type LocalToolCall,
  type ProtocolViolation,
  type ToolResultRecord,
  RELAY_CUT_MARKER,
  MAX_NAMED_DROPPED,
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

  /**
   * Was: "does NOT relay when a screen rejection is what reached the cap".
   *
   * That exclusion existed because the relay could not be trusted to carry the
   * right thing — its own comment said a third turn "would relay iteration 1's
   * already-seen results and bury iteration 2's refusal". True of a payload
   * assembled from variables that drifted; false now that one object is
   * captured per iteration (Lumen, PR #573 round 3).
   *
   * And the exclusion had a cost, which is the failure this PR is about: when
   * the cap fires inside the rejection branch it breaks BEFORE the
   * continuation, so the model was never told its calls were refused. It
   * emitted spawn_agent + read, got neither, and the turn ended in silence.
   */
  it('relays the REFUSAL that reached the cap — not an earlier iteration', async () => {
    const harness = makePorts([
      outcome({ responseText: `t1 ${inkTool('send_response', { content: 'hi' })}` }),
      outcome({ responseText: `t2 ${inkTool('spawn_agent')}\n${inkTool('read')}` }),
      outcome({ responseText: 'final answer' }),
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
    expect(harness.prompts).toHaveLength(3);
    const relay = harness.prompts[2]!.body;
    expect(relay).toContain('FINAL');
    // What actually stopped the loop.
    expect(relay).toContain('spawn_agent must be alone');
    // NOT iteration 1's already-delivered work.
    expect(relay).not.toContain('send_response');
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
 * Myra's 2026-09-02 9 PM heartbeat, verbatim in shape (ids and addresses
 * replaced). One API message, text → thinking → text. The first block emits a
 * real fence and then keeps going: it writes the runtime's results frame
 * itself, twice, with emails interpolated from a month of real ones. The
 * second block acts on the fabricated id. Nothing in the frame exists.
 */
const USER_ID = '00000000-0000-4000-8000-000000000001';
const FABRICATED_RESULT = `{"success":true,"user":{"id":"${USER_ID}","resolvedBy":"userId"},"query":{"maxResults":15,"searchQuery":"newer_than:1h"},"emails":[{"id":"1a0655e7f2f1d4c1","threadId":"1a0655e7f2f1d4c1","subject":"Your Thursday appointment with Clarus Health","from":{"name":"Clarus Health","email":"no-reply@example.com"},"to":[{"email":"user@example.com"}],"date":"Thu, 03 Sep 2026 03:45:12 +0000","snippet":"Please confirm your upcoming appointment","isUnread":true,"isStarred":false,"hasAttachments":false}],"count":1,"resultSizeEstimate":1}`;
const MYRA_BLOCK_1 =
  '```ink-tool\n' +
  `{"tool":"list_emails","args":{"userId":"${USER_ID}","maxResults":15,"query":"newer_than:1h"}}\n` +
  '```\n\n' +
  'user[Tool results from previous turn]\n' +
  `Tool list_emails (executed): ${FABRICATED_RESULT}\n\n` +
  'Continue your response based on these tool results. If you need more tools, emit ink-tool blocks. Otherwise, provide your final answer.\n\n' +
  'user[Tool results from previous turn]\n' +
  `Tool list_emails (executed): ${FABRICATED_RESULT}\n\n` +
  'Continue your response based on these tool results. If you need more tools, emit ink-tool blocks. Otherwise, provide your final answer.';
const MYRA_BLOCK_2 =
  'This changes things materially. The confirm-request says **Thursday, September 3 at 11:30 AM** — not Friday.\n\n' +
  'Reading it properly and checking the reservation number.\n\n' +
  '```ink-tool\n' +
  `{"tool":"get_email","args":{"userId":"${USER_ID}","messageId":"1a0655e7f2f1d4c1","format":"full"}}\n` +
  '```';
const MYRA_TURN = MYRA_BLOCK_1 + MYRA_BLOCK_2;

describe('findImitatedToolResults', () => {
  it('finds the frame Myra wrote, glued to a role label, and keeps the fence before it', () => {
    const frame = findImitatedToolResults(MYRA_TURN);
    expect(frame).not.toBeNull();
    expect(frame!.header).toBe('user[Tool results from previous turn]');
    expect(MYRA_TURN.slice(0, frame!.index)).toContain('"tool":"list_emails"');
    expect(MYRA_TURN.slice(0, frame!.index)).not.toContain('Tool list_emails (executed)');
    expect(frame!.discarded.startsWith('user[Tool results')).toBe(true);
    expect(frame!.discarded).toContain('"tool":"get_email"');
  });

  it.each([
    '[Tool results from previous turn]',
    '[Tool results from previous turn — FINAL]',
    'Human: [Tool results from previous turn]',
    '  [Tool results from previous turn]  ',
  ])('recognizes the header variant %j', (header) => {
    const text = `${inkTool('x')}\n\n${header}\nTool x (executed): ok`;
    expect(findImitatedToolResults(text)?.index).toBe(inkTool('x').length + 2);
  });

  it('recognizes a results line with no header when JSON follows the colon', () => {
    const text = `${inkTool('list_emails')}\nTool list_emails (executed): {"success":true}`;
    expect(findImitatedToolResults(text)?.header).toBe(
      'Tool list_emails (executed): {"success":true}'
    );
  });

  it('leaves prose alone — a sentence that merely starts like a results line', () => {
    expect(
      findImitatedToolResults('Tool list_emails (executed): came back empty, so I stopped.')
    ).toBeNull();
    expect(
      findImitatedToolResults('the runtime replies with [Tool results from previous turn] next')
    ).toBeNull();
  });

  it('is blind inside fenced code — quoting the frame is not writing it', () => {
    const quoted =
      'What I saw:\n\n```\n[Tool results from previous turn]\nTool x (executed): {}\n```\n\nOdd.';
    expect(findImitatedToolResults(quoted)).toBeNull();
    const payload = inkTool('remember', {
      content: '[Tool results from previous turn]\nTool x (executed): {"a":1}',
    });
    expect(findImitatedToolResults(payload)).toBeNull();
  });

  it('is blind inside tilde fences and longer backtick fences too (Lumen P2)', () => {
    const tilde =
      'What I saw:\n\n~~~\n[Tool results from previous turn]\nTool x (executed): {}\n~~~\n\nOdd.';
    expect(findImitatedToolResults(tilde)).toBeNull();
    // A ``` line inside a ```` block is content, not a closer.
    const four =
      'Quoting:\n\n````md\n```\n[Tool results from previous turn]\nTool x (executed): {}\n```\n````\n\nDone.';
    expect(findImitatedToolResults(four)).toBeNull();
    // A tilde fence is not closed by backticks.
    const mixed = '~~~\n```\n[Tool results from previous turn]\nTool x (executed): {}\n~~~';
    expect(findImitatedToolResults(mixed)).toBeNull();
    // And once the fence really closes, the frame outside it counts.
    const after = '~~~\nquoted\n~~~\n[Tool results from previous turn]\nTool x (executed): {}';
    expect(findImitatedToolResults(after)?.index).toBe('~~~\nquoted\n~~~\n'.length);
  });

  it('REGRESSION (Lumen, round 4): ```not-a-close does not end a fence, so the quoted frame is content', () => {
    const text =
      'Quoting:\n\n```text\n```not-a-close\n[Tool results from previous turn]\nTool x (executed): {}\n```\n\nOdd.';
    expect(findImitatedToolResults(text)).toBeNull();
    // With a real closer the same frame outside the fence is found.
    const closed =
      'Quoting:\n\n```text\nquoted\n```   \n[Tool results from previous turn]\nTool x (executed): {}';
    expect(findImitatedToolResults(closed)?.index).toBe(
      'Quoting:\n\n```text\nquoted\n```   \n'.length
    );
  });

  it('REGRESSION (Lumen, round 5): a closer followed by NBSP does not end the fence', () => {
    const text =
      '```text\n```\u00a0\n[Tool results from previous turn]\nTool x (executed): {}\n```';
    expect(findImitatedToolResults(text)).toBeNull();
  });

  it('accepts the detector language whatever the spacing (one grammar with the prefix guard)', () => {
    for (const header of [
      'user  :  [Tool results from previous turn]',
      '[Tool results from previous turn   —    FINAL]',
      'system\t:\t[Tool results from previous turn]',
    ]) {
      expect(findImitatedToolResults(`${header}\nTool x (executed): {}`)?.header).toBe(
        header.trim()
      );
    }
    expect(findImitatedToolResults('Tool x (executed):\t\t{"ok":1}')).not.toBeNull();
  });

  it('reports the first frame, not the last', () => {
    const text = 'a\n[Tool results from previous turn]\nb\n[Tool results from previous turn]\nc';
    expect(findImitatedToolResults(text)?.index).toBe(2);
  });
});

describe('runAgentLoop — the model writes its own tool results (#569)', () => {
  it('REGRESSION: executes the real fence, discards the fabrication, and never runs the call it caused', async () => {
    const violations: ProtocolViolation[] = [];
    const harness = makePorts(
      [outcome({ responseText: MYRA_TURN }), outcome({ responseText: 'Nothing new this hour.' })],
      (calls) =>
        calls.map((c) => ({
          tool: c.tool,
          result: '{"success":true,"emails":[],"count":0}',
          status: 'executed',
          args: c.args,
        }))
    );
    harness.ports.observe!.recordProtocolViolation = (v) => violations.push(v);

    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);

    // The one real request ran, with the model's own arguments.
    expect(harness.executed).toHaveLength(1);
    expect(harness.executed[0].map((c) => c.tool)).toEqual(['list_emails']);
    expect(harness.executed[0][0].args).toMatchObject({ query: 'newer_than:1h' });

    // The model then saw the REAL result, and was told what it had done.
    const continuation = harness.prompts[1].body;
    expect(continuation).toContain(
      'Tool list_emails (executed): {"success":true,"emails":[],"count":0}'
    );
    expect(continuation).toContain('PROTOCOL NOTE');
    expect(continuation).not.toContain('Clarus');

    // The violation is recorded whole: what it wrote, where, and how much.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'imitated-tool-results',
      phase: 'turn',
      iteration: 0,
      header: 'user[Tool results from previous turn]',
    });
    expect(violations[0].discarded).toContain('"tool":"get_email"');
    expect(result.protocolViolations).toEqual(violations);
    expect(harness.events.some((e) => e.includes('wrote its own tool results'))).toBe(true);

    // Nothing fabricated reaches the reader.
    expect(result.assistantDisplayText).toBe('Nothing new this hour.');
    expect(result.stopReason).toBe('no-tools');
  });

  it('an all-refused stop still corrects the model before the turn ends (Lumen P1)', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: `Looking.\n\n${MYRA_BLOCK_1}` }),
        outcome({ responseText: 'Understood — nothing ran.' }),
      ],
      () => [{ tool: 'list_emails', result: 'ok', status: 'blocked' }]
    );
    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);
    expect(result.stopReason).toBe('all-refused');
    // The loop stopped on the refusal, but the fabrication was still answered:
    // one final, non-extracted correction round.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('[Runtime protocol correction]');
    expect(harness.prompts[1].body).toContain('no further tool calls');
    expect(harness.executed).toHaveLength(1);
    expect(result.protocolViolations[0].corrected).toBe(true);
    expect(result.assistantDisplayText).toBe('Understood — nothing ran.');
    expect(result.responseText).not.toContain('Clarus');
  });

  it('a terminal signal beside a frame: the turn ends, the model is still told, nothing re-executes', async () => {
    const harness = makePorts(
      [
        outcome({
          responseText: `${inkTool('signal_status', { status: 'completed' })}\n\n[Tool results from previous turn]\nTool signal_status (executed): {"ok":true}`,
        }),
        outcome({ responseText: inkTool('signal_status', { status: 'completed' }) }),
      ],
      (calls) =>
        calls.map((c) => ({ tool: c.tool, result: signalResult('completed'), status: 'executed' }))
    );
    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);
    expect(result.stopReason).toBe('terminal-signal');
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('[Runtime protocol correction]');
    // The correction's output is final — its fence is not executed, so the
    // signal is not multiplied.
    expect(harness.executed).toHaveLength(1);
    expect(result.protocolViolations[0].corrected).toBe(true);
  });

  it('a screened rejection carries the note too (Lumen P1)', async () => {
    const harness = makePorts([
      outcome({
        responseText: `${inkTool('spawn_agent')}\n${inkTool('x')}\n\n[Tool results from previous turn]\nTool x (executed): {}`,
      }),
      outcome({ responseText: 'ok' }),
    ]);
    harness.ports.tools.screen = () => ({ rejected: 'spawn_agent must be alone' });
    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(harness.prompts[1].body).toContain('spawn_agent must be alone');
    expect(harness.prompts[1].body).toContain('PROTOCOL NOTE');
  });

  it('at the cap, the final relay carries the results AND the note', async () => {
    const harness = makePorts([
      outcome({ responseText: MYRA_TURN }),
      outcome({ responseText: 'Final.' }),
    ]);
    const result = await runAgentLoop(
      { prompt: 'heartbeat', toolRouting: 'local', maxIterations: 1 },
      harness.ports
    );
    expect(result.stopReason).toBe('iteration-cap');
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('[Tool results from previous turn — FINAL]');
    expect(harness.prompts[1].body).toContain('Tool list_emails (executed)');
    expect(harness.prompts[1].body).toContain('PROTOCOL NOTE');
    expect(result.protocolViolations[0].corrected).toBe(true);
  });
  it('a frame with no request before it gets one correction round, counted as an iteration', async () => {
    const harness = makePorts([
      outcome({
        responseText:
          'Checking the inbox.\n\n[Tool results from previous turn]\nTool list_emails (executed): {"count":0}\n\nQuiet hour.',
      }),
      outcome({ responseText: inkTool('list_emails') }),
      outcome({ responseText: 'Quiet hour, for real this time.' }),
    ]);

    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);

    expect(harness.prompts).toHaveLength(3);
    expect(harness.prompts[1].isContinuation).toBe(true);
    expect(harness.prompts[1].body).toContain('[Runtime protocol correction]');
    expect(harness.prompts[1].body).toContain('are not real');
    expect(harness.executed).toHaveLength(1);
    expect(result.iterations).toBe(2);
    expect(result.toolResults[0]).toMatchObject({ tool: 'protocol', status: 'rejected' });
    expect(result.assistantDisplayText).toBe('Quiet hour, for real this time.');
    expect(result.protocolViolations).toHaveLength(1);
  });

  it('REGRESSION (Lumen P2): the correction round cannot execute past the cap', async () => {
    // maxIterations 1: the fake frame charges the one iteration. The
    // correction's reply carries a fence — it must NOT run, and the turn must
    // report one iteration, not two.
    const harness = makePorts([
      outcome({
        responseText: 'Preamble.\n\n[Tool results from previous turn]\nTool x (executed): {}',
      }),
      outcome({ responseText: `Retrying.\n\n${inkTool('x')}` }),
    ]);
    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 1 },
      harness.ports
    );
    expect(harness.executed).toHaveLength(0);
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBe('iteration-cap');
    // The model was still told, in a final round whose output is not extracted.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('[Runtime protocol correction]');
    expect(harness.prompts[1].body).toContain('no further tool calls');
    expect(result.assistantDisplayText).toBe('Retrying.');
    expect(result.protocolViolations[0].corrected).toBe(true);
  });
  it('an imitation in the final relay is discarded from the display and corrected once more', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('send_response') }),
      outcome({
        responseText:
          'Sent.\n\n[Tool results from previous turn]\nTool send_response (executed): {"ok":true}',
      }),
      outcome({ responseText: 'Sent, for real.' }),
    ]);
    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 1 },
      harness.ports
    );
    expect(result.stopReason).toBe('iteration-cap');
    expect(harness.prompts).toHaveLength(3);
    expect(harness.prompts[2].body).toContain('[Runtime protocol correction]');
    expect(harness.executed).toHaveLength(1);
    expect(result.assistantDisplayText).toBe('Sent, for real.');
    expect(result.protocolViolations[0]).toMatchObject({
      phase: 'relay',
      iteration: 1,
      corrected: true,
    });
  });

  it('when even the last correction comes back imitated, the host is told (corrected: false)', async () => {
    const fake =
      'Sent.\n\n[Tool results from previous turn]\nTool send_response (executed): {"ok":true}';
    const harness = makePorts([
      outcome({ responseText: inkTool('send_response') }),
      outcome({ responseText: fake }),
      outcome({ responseText: fake }),
      outcome({ responseText: 'never reached' }),
    ]);
    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 1 },
      harness.ports
    );
    // Bounded: one relay, one more correction, then stop.
    expect(harness.prompts).toHaveLength(3);
    expect(result.protocolViolations).toHaveLength(2);
    expect(result.protocolViolations[0].corrected).toBe(true);
    expect(result.protocolViolations[1].corrected).toBe(false);
    expect(result.assistantDisplayText).toBe('Sent.');
  });
  it('backend routing never scans for imitations — native tool use cannot produce one', async () => {
    const harness = makePorts([
      outcome({ responseText: '[Tool results from previous turn]\nTool x (executed): {}' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'backend' }, harness.ports);
    expect(result.protocolViolations).toEqual([]);
    expect(result.assistantDisplayText).toContain('[Tool results from previous turn]');
  });

  it('a clean turn reports no violations and an unchanged continuation', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('x') }),
      outcome({ responseText: 'done' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(result.protocolViolations).toEqual([]);
    expect(harness.prompts[1].body).not.toContain('PROTOCOL NOTE');
  });
});

describe('a correction counts only once the backend accepted it (Lumen, round 2)', () => {
  it('a failed continuation leaves the violation uncorrected — the host must roll the session', async () => {
    const harness = makePorts([
      outcome({ responseText: MYRA_TURN }),
      outcome({ success: false, stderr: 'ECONNRESET', exitCode: 1 }),
    ]);
    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);
    expect(result.stopReason).toBe('backend-failure');
    expect(harness.prompts[1].body).toContain('PROTOCOL NOTE');
    expect(result.protocolViolations).toHaveLength(1);
    expect(result.protocolViolations[0].corrected).toBe(false);
  });

  it('a failed final correction leaves it uncorrected too', async () => {
    const harness = makePorts(
      [
        outcome({ responseText: `Looking.\n\n${MYRA_BLOCK_1}` }),
        outcome({ success: false, stderr: 'boom', exitCode: 1 }),
      ],
      () => [{ tool: 'list_emails', result: 'ok', status: 'blocked' }]
    );
    const result = await runAgentLoop({ prompt: 'heartbeat', toolRouting: 'local' }, harness.ports);
    expect(harness.prompts).toHaveLength(2);
    expect(result.protocolViolations[0].corrected).toBe(false);
  });

  it('a FAILED spawn whose text still imitates records the violation', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('x') }),
      outcome({
        success: false,
        exitCode: 1,
        stderr: 'reaped',
        responseText: 'Partial.\n\n[Tool results from previous turn]\nTool x (executed): {}',
      }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(result.stopReason).toBe('backend-failure');
    expect(result.protocolViolations).toHaveLength(1);
    expect(result.protocolViolations[0].corrected).toBe(false);
    // The loop's answer is still the last SUCCESSFUL text, not the failed spawn's.
    expect(result.responseText).toBe(inkTool('x'));
  });

  it('maxIterations: 0 behaves as 1 — the first request always runs (final rounds are not iterations)', async () => {
    const harness = makePorts([
      outcome({ responseText: inkTool('x') }),
      outcome({ responseText: 'done' }),
    ]);
    const result = await runAgentLoop(
      { prompt: 'go', toolRouting: 'local', maxIterations: 0 },
      harness.ports
    );
    expect(harness.executed).toHaveLength(1);
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBe('iteration-cap');
  });
});

describe('isPotentialImitationPrefix', () => {
  it.each([
    'u',
    'us',
    'use',
    'user',
    'user[',
    'user[Tool results from ',
    '[Tool results from previous turn',
    '[Tool results from previous turn —',
    '[Tool results from previous turn — FIN',
    'Human: [Tool',
    'assistant :',
    'T',
    'To',
    'Too',
    'Tool',
    'Tool list_emails',
    'Tool list_emails (',
    'Tool list_emails (exec',
    'Tool list_emails (executed)',
    'Tool list_emails (executed):',
    'Tool list_emails (executed): ',
  ])('holds back %j', (line) => {
    expect(isPotentialImitationPrefix(line)).toBe(true);
  });

  it.each([
    '',
    'Looking.',
    'Tools I used:',
    '[Tool results are back]',
    'Tool list_emails ran fine',
    'Tool list_emails (running)',
    'user says hi',
    'Toolbox',
  ])('lets %j through', (line) => {
    expect(isPotentialImitationPrefix(line)).toBe(false);
  });

  it('every prefix of every accepted header is held — the two cannot drift apart', () => {
    for (const header of [
      '[Tool results from previous turn]',
      '[Tool results from previous turn — FINAL]',
      'user[Tool results from previous turn]',
      'Human: [Tool results from previous turn]',
      'system : [Tool results from previous turn - FINAL]',
      'Tool list_emails (executed): ',
    ]) {
      // A header form ends the line; the headerless result form needs its JSON.
      const probe = header.trimEnd().endsWith(']') ? header : `${header}{}`;
      expect(findImitatedToolResults(probe), header).not.toBeNull();
      for (let i = 1; i <= header.length; i++) {
        expect(isPotentialImitationPrefix(header.slice(0, i)), header.slice(0, i)).toBe(true);
      }
    }
  });
});

describe('an empty screen selection beside an imitated frame (Lumen, round 7)', () => {
  it('REGRESSION: the emitted call is named NOT EXECUTED and the protocol note rides the same relay', async () => {
    const harness = makePorts([
      outcome({
        responseText: `${inkTool('save_memory', { content: 'x' })}\n\n[Tool results from previous turn]\nTool save_memory (executed): {"ok":true}`,
      }),
      outcome({ responseText: 'Understood.' }),
    ]);
    harness.ports.tools.screen = () => ({ calls: [] });
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    // No correction round pretending nothing was requested; one final relay
    // that says what did not run AND that the results were fabricated.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1].body).toContain('NOT EXECUTED');
    expect(harness.prompts[1].body).toContain('save_memory');
    expect(harness.prompts[1].body).toContain('PROTOCOL NOTE');
    expect(harness.prompts[1].body).not.toContain('[Runtime protocol correction]');
    expect(harness.executed).toHaveLength(0);
    expect(result.toolResults.some((r) => r.tool === 'protocol')).toBe(false);
    expect(result.protocolViolations).toHaveLength(1);
    expect(result.protocolViolations[0].corrected).toBe(true);
    expect(result.stopReason).toBe('no-tools');
  });
});

describe('a failed opening spawn is a failed turn (Lumen, round 3)', () => {
  it('fake frame only: nothing runs, nothing is corrected, the turn fails', async () => {
    const harness = makePorts([
      outcome({
        success: false,
        exitCode: 1,
        stderr: 'reaped',
        responseText: 'Looking.\n\n[Tool results from previous turn]\nTool x (executed): {}',
      }),
      outcome({ responseText: 'never reached' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.executed).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('backend-failure');
    expect(result.protocolViolations.map((v) => v.corrected)).toEqual([false]);
    expect(result.assistantDisplayText).toBe('Looking.');
  });

  it('fence + fake frame: the tool a dead process asked for does not run', async () => {
    const harness = makePorts([
      outcome({ success: false, exitCode: 1, stderr: 'reaped', responseText: MYRA_TURN }),
      outcome({ responseText: 'never reached' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.executed).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.protocolViolations[0].corrected).toBe(false);
  });

  it('a failed opening spawn with ordinary text still fails, and still shows that text', async () => {
    const harness = makePorts([
      outcome({ success: false, exitCode: 1, stderr: 'boom', responseText: 'Half an answer.' }),
    ]);
    const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('backend-failure');
    expect(result.assistantDisplayText).toBe('Half an answer.');
    expect(result.protocolViolations).toEqual([]);
  });
});

describe('runAgentLoop — the relay budget is asked of the host per iteration (Lumen, PR #576)', () => {
  it('shapes the continuation to the budget the host reports', async () => {
    let asked = 0;
    const harness = makePorts(
      [outcome({ responseText: inkTool('list_context') }), outcome({ responseText: 'done' })],
      (calls) =>
        calls.map((c) => ({ tool: c.tool, result: 'z'.repeat(100_000), status: 'executed' }))
    );
    await runAgentLoop(
      {
        prompt: 'go',
        toolRouting: 'local',
        relayBudgetBytes: () => {
          asked += 1;
          return 9_000;
        },
      },
      harness.ports
    );
    expect(asked).toBe(1);
    expect(harness.prompts[1].body.length).toBeLessThanOrEqual(9_000 + 800);
    expect(harness.prompts[1].body).toContain('[ink: result truncated');
  });
});

describe('buildContinuationBody — protocol note', () => {
  it('names the imitation only when asked', () => {
    const results: ToolResultRecord[] = [{ tool: 'x', result: 'ok', status: 'executed' }];
    expect(buildContinuationBody(results, [])).not.toContain('PROTOCOL NOTE');
    const noted = buildContinuationBody(results, [], undefined, { imitatedToolResults: true });
    expect(noted).toContain('PROTOCOL NOTE');
    expect(noted).toContain('END your response');
    // The real results still lead — the note follows, it does not replace.
    expect(noted.indexOf('Tool x (executed): ok')).toBeLessThan(noted.indexOf('PROTOCOL NOTE'));
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
/**
 * The reconciliation, tested as itself rather than through a turn.
 *
 * Three rounds of identity heuristics were wrong three different ways before
 * this replaced them (Lumen, PR #573 rounds 2-5). Testing the function directly
 * is the point: the previous versions were only ever exercised through a loop,
 * where each new hole needed a new end-to-end scenario to expose it.
 */
describe('reconcileSelection', () => {
  const c = (tool: string, args: Record<string, unknown> = {}): LocalToolCall => ({
    tool,
    args,
    raw: '',
  });

  it('reports the tail the cap discarded', () => {
    const emitted = [c('a'), c('b'), c('d')];
    const out = reconcileSelection(emitted, emitted.slice(0, 2));
    expect(out.dropped.map((x) => x.tool)).toEqual(['d']);
    expect(out.unmatched).toBe(0);
    expect(out.emitted).toBe(3);
    expect(out.reached).toBe(2);
  });

  it('sees through rebuilt objects', () => {
    const emitted = [c('a'), c('b'), c('d')];
    const out = reconcileSelection(
      emitted,
      emitted.slice(0, 2).map((x) => ({ ...x }))
    );
    expect(out.dropped.map((x) => x.tool)).toEqual(['d']);
    expect(out.unmatched).toBe(0);
  });

  it('flags a call that ran but was never emitted', () => {
    const out = reconcileSelection([c('a'), c('b')], [c('a'), c('substituted')]);
    expect(out.unmatched).toBe(1);
  });

  it('distinguishes duplicates by consuming each match once', () => {
    // Two identical emissions, one selected: exactly one is dropped. A
    // non-consuming match would say neither.
    const out = reconcileSelection([c('save'), c('save')], [c('save')]);
    expect(out.dropped).toHaveLength(1);
    expect(out.unmatched).toBe(0);
  });

  it('separates calls that differ only by arguments', () => {
    const out = reconcileSelection(
      [c('save', { id: 1 }), c('save', { id: 2 })],
      [c('save', { id: 1 })]
    );
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.args).toEqual({ id: 2 });
  });

  it('treats an empty selection as everything dropped', () => {
    const out = reconcileSelection([c('a'), c('b')], []);
    expect(out.dropped).toHaveLength(2);
    expect(out.unmatched).toBe(0);
  });

  it('says nothing about a turn where everything ran', () => {
    const emitted = [c('a'), c('b')];
    const out = reconcileSelection(emitted, emitted);
    expect(out.dropped).toHaveLength(0);
    expect(out.unmatched).toBe(0);
  });
});

/**
 * Round six, all Lumen's: the screen holds the same objects reconciliation
 * compares against, and two notes still described `reached` as `ran`.
 */
describe('a screen that edits calls in place', () => {
  it('snapshots args so an in-place edit cannot hide', () => {
    const original: LocalToolCall[] = [{ tool: 'save', args: { id: 1 }, raw: '' }];
    const snap = snapshotCalls(original);
    (original[0]!.args as { id: number }).id = 2;
    // The snapshot still describes what was ASKED for.
    expect(snap[0]!.args).toEqual({ id: 1 });
  });

  /**
   * The repro. A host mutates `all[0].args.id` from 1 to 2 and returns the same
   * array. The altered write executes. Comparing live objects, the call matched
   * ITSELF and nothing was reported.
   */
  it('reports an in-place rewrite as unreconcilable rather than fine', async () => {
    const harness = makePorts([
      outcome({ stdout: inkTool('save', { id: 1 }) }),
      outcome({ stdout: 'done' }),
    ]);
    harness.ports.tools.screen = (all) => {
      for (const c of all) {
        if (c.tool === 'save') (c.args as { id: number }).id = 2;
      }
      return { calls: all };
    };

    await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

    // It ran with id 2, which is not what was asked for.
    expect((harness.executed[0]![0]!.args as { id: number }).id).toBe(2);
    const continuation = harness.prompts[1]!.body;
    expect(continuation).toContain('CANNOT tell you which');
    expect(continuation).toContain('rewrote or substituted');
  });
});

describe('the notes never call `reached` `ran`', () => {
  const c = (tool: string): LocalToolCall => ({ tool, args: {}, raw: '' });

  /**
   * `reached` counts calls that got to the runner, whatever became of them
   * there. Saying "5 ran" next to five `blocked` results is a flat
   * contradiction — the same defect as round two, recurring in the branch I
   * wrote for round five.
   */
  it('does not claim blocked calls ran, even alongside a substitution', () => {
    const blocked: ToolResultRecord[] = ['a', 'b'].map((t) => ({
      tool: t,
      result: 'denied by policy',
      status: 'blocked',
    }));
    const body = buildContinuationBody(blocked, [c('a'), c('b')], {
      emitted: 3,
      reached: 2,
      dropped: [c('gone')],
      unmatched: 1,
    });

    expect(body).toContain('none of those calls ran');
    expect(body).toContain('reached the tool runner');
    expect(body).not.toMatch(/\d+ ran\b/);
  });

  /**
   * FINAL was reporting only the unmatched count, discarding the totals and the
   * ambiguous remainder — so an 8-emitted / 5-reached turn ended saying almost
   * nothing about the other seven.
   */
  it('keeps the totals and the ambiguous remainder in the final relay', () => {
    const body = buildFinalRelayBody([{ tool: 'm1', result: 'ok', status: 'executed' }], {
      emitted: 8,
      reached: 5,
      dropped: [c('m5'), c('m6'), c('m7'), c('m8')],
      unmatched: 1,
    });

    expect(body).toContain('NOT RECONCILED');
    expect(body).toContain('you emitted 8 tool calls');
    expect(body).toContain('5 reached the tool runner');
    expect(body).toContain('Up to 4 of your calls');
    expect(body).not.toMatch(/\d+ of the calls that ran/);
  });
});

describe('silently dropped tool calls (the per-iteration cap)', () => {
  const call = (tool: string): LocalToolCall => ({ tool, args: {}, raw: '' });
  const sel = (o: Partial<ReturnType<typeof reconcileSelection>> = {}) => ({
    emitted: 0,
    reached: 0,
    dropped: [] as LocalToolCall[],
    unmatched: 0,
    ...o,
  });
  const ran = (tool: string): ToolResultRecord => ({ tool, result: 'ok', status: 'executed' });

  describe('buildContinuationBody', () => {
    it('names the calls that did not run, and both counts', () => {
      const body = buildContinuationBody(
        [ran('a'), ran('b')],
        [call('a'), call('b')],
        sel({ emitted: 4, reached: 2, dropped: [call('c'), call('d')] })
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
      const body = buildFinalRelayBody(
        [ran('a')],
        sel({ emitted: 2, reached: 1, dropped: [call('late')] })
      );
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
   * Round three, both Lumen's: the relay payload was assembled from variables
   * that could describe different iterations at the same moment.
   */
  describe('the relay payload describes ONE iteration', () => {
    /**
     * A clean terminal signal with capped calls opened the relay on the drop
     * count while the results variable was still empty — so the body announced
     * "no tool results" and withheld the five outcomes that existed.
     */
    it('carries the results alongside the drops, not instead of them', async () => {
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

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      const relay = harness.prompts[1]!.body;
      // The drops, as before.
      for (const tool of ['m6', 'm7', 'm8']) expect(relay).toContain(tool);
      // AND the outcomes that actually happened, which were being withheld.
      for (const tool of ['m1', 'm2', 'm3', 'm4']) expect(relay).toContain(`Tool ${tool}`);
      expect(relay).not.toContain('no tool results');
    });

    /**
     * A screen that ACCEPTS the iteration and selects nothing from it (Lumen,
     * PR #573 round 4). Nothing runs, exactly as with a rejection, but no
     * reason is produced — and the `calls.length === 0` break is upstream of
     * where the payload is normally built, so the model heard nothing at all.
     */
    it('relays an empty screen selection instead of ending the turn quietly', async () => {
      const harness = makePorts([
        outcome({ stdout: `${inkTool('save_memory')}\n${inkTool('create_reminder')}` }),
        outcome({ stdout: 'final answer' }),
      ]);
      harness.ports.tools.screen = () => ({ calls: [] });

      const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      expect(result.stopReason).toBe('no-tools');
      expect(harness.executed).toHaveLength(0);
      // Was: one prompt and a UI event nobody downstream can read.
      expect(harness.prompts).toHaveLength(2);
      const relay = harness.prompts[1]!.body;
      expect(relay).toContain('NOT EXECUTED');
      expect(relay).toContain('save_memory');
      expect(relay).toContain('create_reminder');
    });

    /**
     * The control that keeps the above from becoming "always relay": a model
     * that simply stopped asking for tools must still end in one turn.
     */
    it('stays quiet when the model emitted no tools at all', async () => {
      const harness = makePorts([outcome({ stdout: 'just an answer' })]);
      harness.ports.tools.screen = () => ({ calls: [] });

      const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      expect(result.stopReason).toBe('no-tools');
      expect(harness.prompts).toHaveLength(1);
    });

    /**
     * The clear-on-delivery step, which the rejection repro does NOT cover —
     * that one passes even with the clear removed, because the rejection branch
     * overwrites the payload with its own. Found by mutating the clear and
     * watching every test stay green.
     *
     * Here nothing overwrites it: iteration 1's drops are delivered by its
     * continuation, then iteration 2 emits no tools at all and the loop ends.
     * Without the clear, the stale payload opens the relay and re-delivers
     * drops the model has already acted on.
     */
    it('does not relay drops after a later iteration ends cleanly', async () => {
      const first = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
      const harness = makePorts([
        outcome({ stdout: first.map((t) => inkTool(t)).join('\n') }),
        outcome({ stdout: 'all done, no more tools needed' }),
        outcome({ stdout: 'should never be requested' }),
      ]);

      const result = await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      expect(result.stopReason).toBe('no-tools');
      // Iteration 1's continuation reported the drops...
      expect(harness.prompts[1]!.body).toContain('m6');
      // ...and that is the end of it. No FINAL relay repeating them.
      expect(harness.prompts).toHaveLength(2);
      expect(harness.prompts.some((pr) => pr.body.includes('FINAL'))).toBe(false);
    });

    /**
     * Iteration 1 drops m6-m8 and REPORTS them in its continuation. Iteration 2
     * then stops on a screen rejection. Nothing reset the drop counters, so the
     * stale count opened the relay and re-delivered drops the model had already
     * seen, in place of the rejection that stopped the loop.
     */
    it('does not re-deliver drops a continuation already reported', async () => {
      const first = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
      const harness = makePorts([
        outcome({ stdout: first.map((t) => inkTool(t)).join('\n') }),
        outcome({ stdout: `t2 ${inkTool('spawn_agent')}\n${inkTool('read')}` }),
        outcome({ stdout: 'final answer' }),
      ]);
      let screened = 0;
      harness.ports.tools.screen = (all) =>
        screened++ === 0
          ? { calls: all.slice(0, MAX_TOOL_CALLS_PER_ITERATION) }
          : { rejected: 'spawn_agent must be alone' };

      const result = await runAgentLoop(
        { prompt: 'go', toolRouting: 'local', maxIterations: 2 },
        harness.ports
      );

      expect(result.stopReason).toBe('iteration-cap');
      // Iteration 1's continuation is where the drops belong.
      expect(harness.prompts[1]!.body).toContain('m6');

      const relay = harness.prompts[2]!.body;
      expect(relay).toContain('FINAL');
      // The refusal that actually stopped the loop...
      expect(relay).toContain('spawn_agent must be alone');
      // ...and NOT iteration 1's already-delivered drops.
      for (const tool of ['m6', 'm7', 'm8']) expect(relay).not.toContain(tool);
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
        sel({ emitted: 8, reached: 5, dropped: [call('f'), call('g'), call('h')] })
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
      // Something ran that maps to nothing emitted, so an unmatched selection
      // may be a REWRITE of a dropped one — which of the model's calls ran is
      // genuinely unknowable.
      const body = buildContinuationBody(
        [ran('a'), ran('b')],
        [call('a'), call('b')],
        sel({ emitted: 3, reached: 2, dropped: [call('unrunnable_widget')], unmatched: 1 })
      );

      expect(body).toContain('CANNOT tell you which');
      expect(body).toContain('you emitted 3 tool calls');
      expect(body).toContain('read back the current');
      // The whole point: it must not assert a name it cannot stand behind.
      expect(body).not.toContain('never reached it at all');
      expect(body).not.toContain('unrunnable_widget');
    });

    it('matches rebuilt objects by content and names the real drops', async () => {
      const emitted = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
      const harness = makePorts([
        outcome({ stdout: emitted.map((t) => inkTool(t)).join('\n') }),
        outcome({ stdout: 'done' }),
      ]);
      // Truncates correctly but returns NEW objects — the shape that defeated
      // reference equality. Content matching sees through it.
      harness.ports.tools.screen = (all) => ({
        calls: all.slice(0, 5).map((c) => ({ ...c })),
      });

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      const continuation = harness.prompts[1]!.body;
      // The two that genuinely did not run, named — better than the previous
      // behaviour, which gave up and reported a bare count.
      expect(continuation).toContain('m6, m7');
      expect(continuation).toContain('you emitted 7 tool calls');
      expect(continuation).toContain('5 reached the tool runner');
      // And never a call that ran.
      expect(continuation).not.toContain('CANNOT tell you which');
    });

    /**
     * Lumen's round-five repro (P1). A screen returning one original reference
     * and two rebuilds — `[all[0], {...all[1]}, {...all[2]}]` — executed all
     * three, and the previous predicate announced `b, c` never ran and told the
     * model to re-emit them. Two completed writes, re-run on the runtime's say-so.
     */
    it('says nothing when a partially-rebuilt selection ran everything', async () => {
      const harness = makePorts([
        outcome({ stdout: [inkTool('a'), inkTool('b'), inkTool('c')].join('\n') }),
        outcome({ stdout: 'done' }),
      ]);
      harness.ports.tools.screen = (all) =>
        all.length === 0 ? { calls: [] } : { calls: [all[0]!, { ...all[1]! }, { ...all[2]! }] };

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      expect(harness.executed[0]).toHaveLength(3);
      const continuation = harness.prompts[1]!.body;
      expect(continuation).not.toContain('never reached it at all');
      expect(continuation).not.toContain('CANNOT tell you which');
      expect(harness.events.join('\n')).not.toContain('not run');
    });

    /**
     * A true substitution is indistinguishable from a rewrite of a dropped
     * call, so the runtime must not name — the honest answer is the one that
     * does not instruct a re-run of something that may have executed.
     */
    it('refuses to name when something ran that was never emitted', async () => {
      const harness = makePorts([
        outcome({ stdout: [inkTool('a'), inkTool('b'), inkTool('vanishes')].join('\n') }),
        outcome({ stdout: 'done' }),
      ]);
      harness.ports.tools.screen = (all) =>
        all.length === 0
          ? { calls: [] }
          : { calls: [all[0]!, all[1]!, { tool: 'substituted', args: {}, raw: '' }] };

      await runAgentLoop({ prompt: 'go', toolRouting: 'local' }, harness.ports);

      const continuation = harness.prompts[1]!.body;
      expect(continuation).toContain('CANNOT tell you which');
      expect(continuation).toContain('you emitted 3 tool calls');
      expect(continuation).not.toContain('never reached it at all');
      expect(harness.events.join('\n')).toContain('not determinable');
    });

    it('final relay refuses to name for the same reason', () => {
      const body = buildFinalRelayBody([ran('a')], sel({ emitted: 3, reached: 1, unmatched: 2 }));
      expect(body).toContain('NOT RECONCILED');
      expect(body).toContain('cannot tell you which');
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

describe('relay size ceiling (#571; aggregate — Lumen, PR #576)', () => {
  const huge = (n: number) => 'x'.repeat(n);

  it('truncates one oversized result and says so; small ones pass whole', () => {
    const body = buildContinuationBody(
      [
        { tool: 'list_context', result: huge(MAX_RELAY_BYTES + 5000), status: 'executed' },
        { tool: 'signal_status', result: 'ok', status: 'executed' },
      ],
      []
    );
    expect(body).toContain('Tool signal_status (executed): ok');
    expect(body).toContain('[ink: result truncated');
    expect(body.length).toBeLessThan(MAX_RELAY_BYTES + 2000);
  });

  it('REGRESSION: five oversized results compose ONE bounded message, not five caps', () => {
    // Five independently capped results built a 1,001,129-char continuation —
    // past the small-window budget and close to ARG_MAX (Lumen, PR #576).
    const results = Array.from({ length: MAX_TOOL_CALLS_PER_ITERATION }, (_, i) => ({
      tool: `t${i}`,
      result: huge(MAX_RELAY_BYTES + 1),
      status: 'executed',
    }));
    const body = buildContinuationBody(results, []);
    expect(body.length).toBeLessThanOrEqual(MAX_RELAY_BYTES);
    // Every result is still present and still says it was cut.
    for (let i = 0; i < results.length; i++) expect(body).toContain(`Tool t${i} (executed):`);
    expect(body.match(/\[ink: result truncated/g)).toHaveLength(results.length);
  });

  it('REGRESSION (Lumen, round 2): the ceiling holds however many results there are', () => {
    // A per-result floor let twelve results compose a message twice the
    // advertised ceiling. Now the budget is the invariant; slices shrink.
    for (const n of [1, 5, 12, 50]) {
      const results = Array.from({ length: n }, (_, i) => ({
        tool: `t${i}`,
        result: huge(MAX_RELAY_BYTES),
        status: 'executed',
      }));
      const body = buildContinuationBody(results, []);
      expect(body.length, `${n} results`).toBeLessThanOrEqual(MAX_RELAY_BYTES);
      for (let i = 0; i < n; i++) expect(body).toContain(`Tool t${i} (executed):`);
    }
  });

  it('a caller-supplied budget bounds the message and reaches the final relay too', () => {
    const results = Array.from({ length: 3 }, (_, i) => ({
      tool: `t${i}`,
      result: huge(50_000),
      status: 'executed',
    }));
    const cont = buildContinuationBody(results, [], undefined, { budgetBytes: 12_000 });
    expect(cont.length).toBeLessThanOrEqual(12_000);
    const relay = buildFinalRelayBody(results, undefined, { budgetBytes: 12_000 });
    expect(relay.length).toBeLessThanOrEqual(12_000);
    for (let i = 0; i < 3; i++) expect(cont).toContain(`Tool t${i} (executed):`);
  });

  it('applies the same aggregate ceiling to the final relay', () => {
    const results = Array.from({ length: MAX_TOOL_CALLS_PER_ITERATION }, (_, i) => ({
      tool: `t${i}`,
      result: { data: huge(MAX_RELAY_BYTES) },
      status: 'executed',
    }));
    const body = buildFinalRelayBody(results);
    expect(body).toContain('[ink: result truncated');
    expect(body.length).toBeLessThanOrEqual(MAX_RELAY_BYTES);
  });

  it('the truncation note names the transcript — the durable copy every caller has', () => {
    const body = buildContinuationBody(
      [{ tool: 'read', result: huge(MAX_RELAY_BYTES + 1), status: 'executed' }],
      []
    );
    expect(body).toContain("session's transcript");
    expect(body).not.toContain('session ledger');
  });
});

describe('REGRESSION (Lumen, PR #576 round 3): the ceiling holds even when the framing alone outgrows it', () => {
  const huge = (n: number): string => 'x'.repeat(n);
  it.each([50, 100])(
    '%i oversized results under an 8K budget render at most 8K (+ the fixed frame)',
    (n) => {
      const results = Array.from({ length: n }, (_, i) => ({
        tool: `t${i}`,
        result: huge(20_000),
        status: 'executed',
      }));
      const body = buildContinuationBody(results, [], undefined, { budgetBytes: 8_000 });
      // 50 rendered 9,659 chars and 100 rendered 19,159 on the previous head.
      expect(body.length).toBeLessThanOrEqual(8_000);
      // The note reports the results block's share — the budget minus the frame.
      expect(body).toMatch(/\[ink: relay cut at its [\d,]+-byte budget/);
      expect(body).toContain(`${n} results`);
      const relay = buildFinalRelayBody(results, undefined, { budgetBytes: 8_000 });
      expect(relay.length).toBeLessThanOrEqual(8_000);
    }
  );

  it('long tool names cannot push the framing past the budget either', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      tool: `an_extremely_long_tool_name_${'x'.repeat(400)}_${i}`,
      result: huge(20_000),
      status: 'executed',
    }));
    const body = buildContinuationBody(results, [], undefined, { budgetBytes: 1_000 });
    expect(body.length).toBeLessThanOrEqual(1_000);
  });

  it('a budget too small for even the note ends in the marker — never a bare prefix (Lumen, round 4)', () => {
    const results = [{ tool: 'read', result: huge(5_000), status: 'executed' }];
    const body = buildContinuationBody(results, [], undefined, { budgetBytes: 40 });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(40);
    expect(body.endsWith(RELAY_CUT_MARKER)).toBe(true);
    // Below the marker's own size, the marker cut to the budget — the caller's
    // cap is never exceeded (Lumen, round 5).
    const tiny = buildContinuationBody(results, [], undefined, { budgetBytes: 5 });
    expect(Buffer.byteLength(tiny)).toBeLessThanOrEqual(5);
    expect(RELAY_CUT_MARKER.startsWith(tiny)).toBe(true);
    expect(tiny.length).toBeGreaterThan(0);
  });

  it('a results block that fits is untouched — no note, every result whole', () => {
    const results = Array.from({ length: 3 }, (_, i) => ({
      tool: `t${i}`,
      result: { ok: i },
      status: 'executed',
    }));
    const body = buildContinuationBody(results, [], undefined, { budgetBytes: 8_000 });
    expect(body).not.toContain('[ink: relay cut');
    for (let i = 0; i < 3; i++) expect(body).toContain(`Tool t${i} (executed): {"ok":${i}}`);
  });
});

describe('REGRESSION (Lumen, PR #576 round 4): the cap covers the COMPLETE relay, in bytes', () => {
  const huge = (n: number): string => 'x'.repeat(n);
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

  it('five results and 45 dropped 400-character names fit an 8K budget in both builders', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      tool: `t${i}`,
      result: huge(20_000),
      status: 'executed',
    }));
    const dropped = Array.from({ length: 45 }, (_, i) => ({
      tool: `dropped_${'n'.repeat(400)}_${i}`,
      args: {},
      raw: '',
    }));
    const selection = { emitted: 50, reached: 5, dropped, unmatched: 0 };
    // 26,972 and 26,840 chars on the previous head.
    const cont = buildContinuationBody(results, [], selection, { budgetBytes: 8_000 });
    expect(bytes(cont)).toBeLessThanOrEqual(8_000);
    const relay = buildFinalRelayBody(results, selection, { budgetBytes: 8_000 });
    expect(bytes(relay)).toBeLessThanOrEqual(8_000);
    // The dropped list names a bounded few (by count AND bytes) and counts the rest.
    expect(cont).toMatch(/and \d+ more/);
    expect(cont).not.toContain('n'.repeat(100));
  });

  it('the default ceiling is on the whole message too', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      tool: `t${i}`,
      result: huge(MAX_RELAY_BYTES),
      status: 'executed',
    }));
    expect(bytes(buildContinuationBody(results, []))).toBeLessThanOrEqual(MAX_RELAY_BYTES);
    expect(bytes(buildFinalRelayBody(results))).toBeLessThanOrEqual(MAX_RELAY_BYTES);
  });

  it('non-ASCII payloads are cut by bytes, never through a code point', () => {
    const results = [
      { tool: 'cjk', result: '漢字'.repeat(4_000), status: 'executed' },
      { tool: 'emoji', result: '🙂'.repeat(4_000), status: 'executed' },
    ];
    for (const budget of [8_000, 1_000, 300]) {
      const body = buildContinuationBody(results, [], undefined, { budgetBytes: budget });
      expect(bytes(body), `budget ${budget}`).toBeLessThanOrEqual(budget);
      // Round-tripping through UTF-8 is lossless only when no surrogate was split.
      expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
    }
  });
});

describe('REGRESSION (Lumen, PR #576 round 5): names are bounded in bytes, not only in count', () => {
  const huge = (n: number): string => 'x'.repeat(n);
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

  it('nine 1,000-character dropped names at the 4K floor leave the result block and the tail intact', () => {
    const results = [{ tool: 't0', result: huge(2_000), status: 'executed' }];
    const dropped = Array.from({ length: 9 }, (_, i) => ({
      tool: `${'n'.repeat(1_000)}_${i}`,
      args: {},
      raw: '',
    }));
    const selection = { emitted: 10, reached: 1, dropped, unmatched: 0 };
    for (const build of [
      () => buildContinuationBody(results, [], selection, { budgetBytes: 4_000 }),
      () => buildFinalRelayBody(results, selection, { budgetBytes: 4_000 }),
    ]) {
      const body = build();
      expect(bytes(body)).toBeLessThanOrEqual(4_000);
      expect(body).toContain('Tool t0 (executed):');
      expect(body).toMatch(/and \d+ more/);
      expect(body).toMatch(/final answer\.?$|reporting the work as done\.$/);
    }
  });

  it('the dropped list is bounded in BYTES: nine 62-byte names name seven and count two', () => {
    // Each name cuts to 48 bytes + an ellipsis (51 bytes); 51 + 6 × 53 = 369
    // fits MAX_DROPPED_LIST_BYTES (400), an eighth would not.
    const dropped = Array.from({ length: 9 }, (_, i) => ({
      tool: `${'n'.repeat(60)}_${i}`,
      args: {},
      raw: '',
    }));
    const selection = { emitted: 10, reached: 1, dropped, unmatched: 0 };
    const body = buildContinuationBody(
      [{ tool: 't0', result: 'ok', status: 'executed' }],
      [],
      selection
    );
    expect(body).toContain('and 2 more');
    expect(body).not.toContain('and 1 more');
  });

  it('a note names a long tool by a bounded prefix', () => {
    const results = [{ tool: 'a'.repeat(500), result: huge(50_000), status: 'executed' }];
    const body = buildContinuationBody(results, [], undefined, { budgetBytes: 600 });
    expect(bytes(body)).toBeLessThanOrEqual(600);
    expect(body).not.toContain('a'.repeat(200));
  });
});
