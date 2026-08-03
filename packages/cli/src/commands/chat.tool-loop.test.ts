import { describe, it, expect } from 'vitest';
import { isTerminalSignalToolResult } from './chat.js';

/**
 * Regression for the per-heartbeat multiplication: one ink spawn was emitting
 * signal_status(completed) 4x and opening 5 backend/Claude sessions, because the
 * local-tool loop re-invoked the backend as long as any tool executed — and
 * signal_status counts. A terminal signal must stop the loop.
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

// Mirror the loop's stop decision (chat.ts): stop on a terminal signal OR when
// no tool executed OR at the iteration cap. This is the exact predicate the fix
// added, isolated so the multiplication regression is guarded directly.
function shouldStop(
  iterationResults: Array<{ tool: string; status: string; result?: unknown }>,
  iteration: number,
  max: number
): boolean {
  const hasExecutedTools = iterationResults.some(
    (r) => r.status === 'executed' || r.status === 'approved'
  );
  const signaledDone = iterationResults.some(
    (r) => r.tool === 'signal_status' && isTerminalSignalToolResult(r.result)
  );
  return signaledDone || !hasExecutedTools || iteration >= max;
}

describe('tool-loop stop decision', () => {
  const MAX = 5;

  it('STOPS the iteration that signals completed, even alongside real work', () => {
    // The exact 3 PM heartbeat shape: real tools AND a completion signal.
    const results = [
      { tool: 'list_calendar_events', status: 'executed' },
      { tool: 'send_response', status: 'executed' },
      { tool: 'remember', status: 'executed' },
      { tool: 'signal_status', status: 'executed', result: signalResult('completed') },
    ];
    expect(shouldStop(results, 2, MAX)).toBe(true);
  });

  it('CONTINUES when the agent only did work and did not signal (real agentic step)', () => {
    const results = [{ tool: 'list_emails', status: 'executed' }];
    expect(shouldStop(results, 1, MAX)).toBe(false);
  });

  it('CONTINUES on a non-terminal continuing signal', () => {
    const results = [
      { tool: 'read', status: 'executed' },
      { tool: 'signal_status', status: 'executed', result: signalResult('continuing') },
    ];
    expect(shouldStop(results, 2, MAX)).toBe(false);
  });

  it('STOPS when no tool executed (nothing to reason about)', () => {
    expect(shouldStop([{ tool: 'list_emails', status: 'blocked' }], 1, MAX)).toBe(true);
  });

  it('STOPS at the iteration cap as a backstop', () => {
    expect(shouldStop([{ tool: 'read', status: 'executed' }], MAX, MAX)).toBe(true);
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
      if (shouldStop(results, iteration, MAX)) break;
    }
    expect(backendInvocations).toBe(2); // was 5 pre-fix
    expect(signalCalls).toEqual(['completed']); // was ['completed','completed','completed','completed']
  });
});
