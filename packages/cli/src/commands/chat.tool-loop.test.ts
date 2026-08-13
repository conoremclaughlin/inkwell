import { describe, it, expect } from 'vitest';
import { isTerminalSignalToolResult, decideToolLoopNext } from './chat.js';

/**
 * Regression for the per-heartbeat multiplication: one ink spawn was emitting
 * signal_status(completed) 4x and opening 5 backend/Claude sessions, because the
 * local-tool loop re-invoked the backend as long as any tool executed — and
 * signal_status counts. A terminal signal must stop the loop.
 *
 * And regression for the Aug 13 silent drop: the loop executed the capped
 * iteration's tools, then broke without relaying their results — a
 * send_response that failed validation on iteration 5/5 read to the agent as
 * delivered. Exits at the cap (or after an iteration where nothing executed)
 * must relay the pending results in one final round-trip.
 */

// Shape a signal_status result the way handleClientLocalTool returns it.
function signalResult(status: string, reason = 'r') {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ success: true, signal: { status, reason } }) },
    ],
  };
}

describe('isTerminalSignalToolResult', () => {
  it('is true for completed', () => {
    expect(isTerminalSignalToolResult(signalResult('completed'))).toBe(true);
  });

  it('is true for blocked', () => {
    expect(isTerminalSignalToolResult(signalResult('blocked'))).toBe(true);
  });

  it('is false for continuing (agent wants another round)', () => {
    expect(isTerminalSignalToolResult(signalResult('continuing'))).toBe(false);
  });

  it('is false for unknown status', () => {
    expect(isTerminalSignalToolResult(signalResult('anything-else'))).toBe(false);
  });

  it('is false for malformed / non-signal results', () => {
    expect(isTerminalSignalToolResult(undefined)).toBe(false);
    expect(isTerminalSignalToolResult(null)).toBe(false);
    expect(isTerminalSignalToolResult({})).toBe(false);
    expect(isTerminalSignalToolResult({ content: [{ text: 'not json' }] })).toBe(false);
    expect(isTerminalSignalToolResult({ content: [{ text: '{}' }] })).toBe(false);
    expect(isTerminalSignalToolResult({ content: [] })).toBe(false);
  });
});

describe('decideToolLoopNext', () => {
  const MAX = 5;

  it('STOPS (no relay) the iteration that signals completed, even alongside real work', () => {
    // The exact 3 PM heartbeat shape: real tools AND a completion signal.
    const results = [
      { tool: 'list_calendar_events', status: 'executed' },
      { tool: 'send_response', status: 'executed' },
      { tool: 'remember', status: 'executed' },
      { tool: 'signal_status', status: 'executed', result: signalResult('completed') },
    ];
    expect(decideToolLoopNext(results, 2, MAX)).toBe('stop');
  });

  it('CONTINUES when the agent only did work and did not signal (real agentic step)', () => {
    const results = [{ tool: 'list_emails', status: 'executed' }];
    expect(decideToolLoopNext(results, 1, MAX)).toBe('continue');
  });

  it('CONTINUES on a non-terminal continuing signal', () => {
    const results = [
      { tool: 'read', status: 'executed' },
      { tool: 'signal_status', status: 'executed', result: signalResult('continuing') },
    ];
    expect(decideToolLoopNext(results, 2, MAX)).toBe('continue');
  });

  it('RELAYS then stops when no tool executed — the model must hear the denial', () => {
    expect(decideToolLoopNext([{ tool: 'list_emails', status: 'blocked' }], 1, MAX)).toBe(
      'relay-then-stop'
    );
    expect(decideToolLoopNext([{ tool: 'bash', status: 'denied' }], 1, MAX)).toBe(
      'relay-then-stop'
    );
    expect(decideToolLoopNext([{ tool: 'bash', status: 'error' }], 1, MAX)).toBe('relay-then-stop');
  });

  it('RELAYS then stops at the iteration cap — capped results must reach the model', () => {
    // The Aug 13 shape: send_response executed on iteration 5/5 with a
    // validation-error result. Pre-fix this was a plain break, and the agent
    // exited believing the message was delivered.
    const results = [{ tool: 'send_response', status: 'executed' }];
    expect(decideToolLoopNext(results, MAX, MAX)).toBe('relay-then-stop');
  });

  it('terminal signal wins over the cap (no relay after a signaled-done iteration)', () => {
    const results = [
      { tool: 'signal_status', status: 'executed', result: signalResult('completed') },
    ];
    expect(decideToolLoopNext(results, MAX, MAX)).toBe('stop');
  });

  it('stops without relay when there is nothing to relay', () => {
    expect(decideToolLoopNext([], MAX, MAX)).toBe('stop');
  });

  it('a completed turn no longer runs the full 5 iterations (regression)', () => {
    // Simulate the loop: iteration 2 both works and signals completed → stop.
    // Pre-fix, signal_status kept hasExecutedTools true → ran to iteration 5.
    let iteration = 0;
    let backendInvocations = 0;
    const signalCalls: string[] = [];
    while (true) {
      iteration += 1;
      backendInvocations += 1; // each loop body is one backend round-trip
      const results =
        iteration === 1
          ? [{ tool: 'list_emails', status: 'executed' }]
          : [
              { tool: 'send_response', status: 'executed' },
              { tool: 'signal_status', status: 'executed', result: signalResult('completed') },
            ];
      if (iteration >= 2) signalCalls.push('completed');
      if (decideToolLoopNext(results, iteration, MAX) !== 'continue') break;
    }
    expect(backendInvocations).toBe(2); // was 5 pre-fix
    expect(signalCalls).toEqual(['completed']); // was ['completed','completed','completed','completed']
  });

  it('a capped turn makes exactly one relay round-trip, then ends (no relay loop)', () => {
    // Simulate the chat.ts loop shape: a relay is one more backend call whose
    // output is never parsed for tools — even if the model emits blocks anyway.
    const MAX_ITER = 5;
    let backendCalls = 1; // the initial delivery call
    let iteration = 0;
    let finalRelay = false;
    while (true) {
      if (finalRelay) break; // relay output is final — no extraction, no execution
      // every backend response emits another tool call (busy agent)
      iteration += 1;
      const results = [{ tool: 'get_artifact', status: 'executed' }];
      const decision = decideToolLoopNext(results, iteration, MAX_ITER);
      if (decision === 'stop') break;
      finalRelay = decision === 'relay-then-stop';
      backendCalls += 1; // continuation or relay round-trip
    }
    expect(iteration).toBe(MAX_ITER); // executed exactly the cap
    expect(backendCalls).toBe(MAX_ITER + 1); // delivery + 4 continuations + 1 relay
  });
});
