import { describe, expect, it, vi } from 'vitest';
import { ContextLedger, entryRefHash } from './context-ledger.js';
import { computeContextOccupancy } from './context-tools.js';
import { SbHookRegistry } from './hook-registry.js';
import { SessionLog } from './session-log.js';
import { SerialInputDrain } from './serial-input-drain.js';
import {
  SessionTurnCoordinator,
  type SessionTurnExecution,
  type SessionTurnInput,
  type SessionTurnState,
} from './session-turn.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function outcome(
  overrides: Partial<SessionTurnExecution<string>['loop']> = {}
): SessionTurnExecution<string> {
  return {
    loop: {
      success: true,
      stopReason: 'no-tools',
      responseText: 'raw reply',
      assistantDisplayText: 'reply',
      toolResults: [],
      iterations: 1,
      protocolViolations: [],
      ...overrides,
    },
    backend: { success: true, exitCode: 0, durationMs: 123, stderr: '' },
    value: 'host data',
  };
}

function harness() {
  const ledger = new ContextLedger();
  const hooks = new SbHookRegistry();
  const events: Record<string, unknown>[] = [];
  const order: string[] = [];
  const log = new SessionLog({
    path: 'memory',
    sink: {
      write: (line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        events.push(entry);
        order.push(String(entry.type));
      },
    },
  });
  const state: SessionTurnState = {
    sbSlug: 'echo',
    sessionId: 's1',
    backend: 'claude',
    maxContextTokens: 100_000,
    compactionInFlight: false,
  };
  const recordEviction = vi.fn();
  const ports = {
    ledger,
    hooks,
    log,
    state: () => state,
    occupancy: () =>
      computeContextOccupancy(ledger.totalTokens(), 0, state.maxContextTokens, undefined),
    compact: vi.fn(async () => {
      order.push('compact');
    }),
    inputRecorded: vi.fn(async () => {
      order.push('inputRecorded');
    }),
    recordEviction,
  };
  const coordinator = new SessionTurnCoordinator(ports);
  return { coordinator, ports, ledger, hooks, events, order, log, state, recordEviction };
}

describe('SessionTurnCoordinator', () => {
  it.each([
    ['user', 'user', 'user', 'repl'],
    ['system', 'system_turn', 'system', 'server'],
    ['inbox-auto', 'auto_turn', 'system', 'auto-run'],
  ] as const)(
    'preserves %s input provenance and transcript shapes',
    async (source, type, role, label) => {
      const h = harness();
      const result = await h.coordinator.run(
        { raw: 'hello', source, displayLabel: 'server' },
        async () => outcome()
      );
      expect(h.events[0]).toMatchObject({
        type,
        content: 'hello',
        ...(source === 'system' ? { label: 'server' } : {}),
      });
      expect(h.ledger.listEntries()[0]).toMatchObject({
        role,
        source: label,
        content: source === 'inbox-auto' ? '[auto-run inbox] hello' : 'hello',
      });
      expect(result?.execution.value).toBe('host data');
      expect(h.events.at(-1)).toMatchObject({
        type: 'assistant',
        backend: 'claude',
        model: null,
        success: true,
        content: 'reply',
        rawContent: 'raw reply',
        approxTokens: 2,
        usage: null,
      });
    }
  );

  it('keeps the full auto input in the log but bounds its ledger line', async () => {
    const h = harness();
    await h.coordinator.run({ raw: 'word '.repeat(500), source: 'inbox-auto' }, async () =>
      outcome()
    );
    expect(String(h.events[0]?.content).length).toBe(2500);
    expect(h.ledger.listEntries()[0]!.content.length).toBeLessThan(550);
  });

  it('sequences compaction, measured-occupancy recall, execution and end hooks', async () => {
    const h = harness();
    const occupancy = computeContextOccupancy(123, 100, 1000, undefined);
    h.ports.occupancy = () => occupancy;
    for (const event of ['prompt_build', 'turn_end'] as const) {
      h.hooks.register({
        name: event,
        event,
        handler: async (ctx) => {
          h.order.push(event);
          expect(ctx.runtime.budgetUtilization).toBe(occupancy.utilization);
          expect(ctx.runtime.turnCount).toBe(event === 'prompt_build' ? 0 : 1);
          expect(ctx.lastTurn?.turnIndex).toBe(1);
          expect(ctx.lastTurn?.assistantResponse).toBe(event === 'prompt_build' ? '' : 'reply');
          return {
            inject: [{ role: 'system', content: event, source: 'passive-recall', memoryId: event }],
          };
        },
      });
    }
    await h.coordinator.run({ raw: 'hi', source: 'user' }, async (turn) => {
      h.order.push('execute');
      expect(turn.promptHooks.injectedEntries[0]?.memoryId).toBe('prompt_build');
      expect(turn.occupancy).toBe(occupancy);
      expect(h.events.at(-1)).toMatchObject({ type: 'hook_injection', memoryId: 'prompt_build' });
      return outcome();
    });
    expect(h.order).toEqual([
      'user',
      'inputRecorded',
      'compact',
      'prompt_build',
      'hook_injection',
      'execute',
      'assistant',
      'turn_end',
      'hook_injection',
    ]);
    expect(h.coordinator.turnCount).toBe(1);
  });

  it('awaits end-hook injection and persistence before the next queued input', async () => {
    const h = harness();
    const started = deferred();
    const release = deferred();
    h.hooks.register({
      name: 'slow recall',
      event: 'turn_end',
      handler: async (ctx) => {
        if (ctx.runtime.turnCount !== 1) return;
        started.resolve();
        await release.promise;
        return { inject: [{ role: 'system', content: 'late memory', source: 'passive-recall' }] };
      },
    });
    const execute = vi.fn(async () => outcome());
    const drain = new SerialInputDrain<SessionTurnInput>({
      maxPendingInputs: 2,
      maxPendingBytes: 100,
      sizeOf: () => 1,
      run: async (input) => {
        await h.coordinator.run(input, execute);
      },
    });
    const first = drain.enqueue({ raw: 'first', source: 'user' });
    const second = drain.enqueue({ raw: 'second', source: 'user' });
    await started.promise;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e.type === 'user')).toHaveLength(1);
    await expect(h.coordinator.run({ raw: 'overlap', source: 'user' }, execute)).rejects.toThrow(
      'already running'
    );
    release.resolve();
    await Promise.all([first, second]);
    expect(h.events.map((e) => e.type)).toEqual([
      'user',
      'assistant',
      'hook_injection',
      'user',
      'assistant',
    ]);
  });

  it('uses separate state and pending hooks for two sessions in one process', async () => {
    const a = harness();
    const b = harness();
    const release = deferred();
    const started = deferred();
    a.hooks.register({
      name: 'pause',
      event: 'prompt_build',
      handler: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const first = a.coordinator.run({ raw: 'a', source: 'user' }, async () => outcome());
    await started.promise;
    await b.coordinator.run({ raw: 'b', source: 'system' }, async () => outcome());
    expect(b.coordinator.turnCount).toBe(1);
    expect(a.coordinator.turnCount).toBe(0);
    expect(b.ledger.listEntries().some((e) => e.content === 'a')).toBe(false);
    release.resolve();
    await first;
  });

  it('awaits asynchronous writes before execution and before reporting completion', async () => {
    const h = harness();
    const before = deferred();
    const after = deferred();
    const executing = deferred();
    let writes = 0;
    h.ports.log = new SessionLog({
      path: 'async',
      sink: {
        write: async () => {
          if (++writes === 1) await before.promise;
          else await after.promise;
        },
      },
    });
    const execute = vi.fn(async () => {
      executing.resolve();
      return outcome();
    });
    let completed = false;
    const running = h.coordinator.run({ raw: 'hi', source: 'user' }, execute).then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    before.resolve();
    await executing.promise;
    await Promise.resolve();
    expect(completed).toBe(false);
    after.resolve();
    await running;
    expect(completed).toBe(true);
  });

  it.each(['input', 'final'] as const)(
    'propagates %s persistence failure instead of false success',
    async (phase) => {
      const h = harness();
      let writes = 0;
      h.ports.log = new SessionLog({
        path: 'failed',
        sink: {
          write: async () => {
            if (++writes === (phase === 'input' ? 1 : 2)) throw new Error('disk failed');
          },
        },
      });
      const execute = vi.fn(async () => outcome());
      await expect(h.coordinator.run({ raw: 'hi', source: 'user' }, execute)).rejects.toThrow(
        'disk failed'
      );
      expect(execute).toHaveBeenCalledTimes(phase === 'input' ? 0 : 1);
    }
  );

  it('records cancellation without adding partial output to assistant context', async () => {
    const h = harness();
    const end = vi.fn(async () => {});
    h.hooks.register({ name: 'recall', event: 'turn_end', handler: end });
    await h.coordinator.run({ raw: 'hi', source: 'user' }, async () =>
      outcome({ stopReason: 'aborted', success: false })
    );
    expect(h.ledger.listEntries().filter((e) => e.role === 'assistant')).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({
      type: 'assistant',
      success: false,
      cancelled: true,
      content: null,
    });
    expect(h.coordinator.turnCount).toBe(1);
    expect(end).not.toHaveBeenCalled();
  });

  it('notifies a persisted reply before bounded end hooks; drops late injection and eviction', async () => {
    vi.useFakeTimers();
    const h = harness();
    const coordinator = new SessionTurnCoordinator({ ...h.ports, endHookTimeoutMs: 50 });
    const release = deferred();
    const started = deferred();
    const target = h.ledger.addEntry('system', 'keep me', 'fixture');
    h.hooks.register({
      name: 'late',
      event: 'turn_end',
      handler: async () => {
        started.resolve();
        await release.promise;
        return {
          inject: [{ role: 'system', content: 'late', source: 'fixture' }],
          evict: [target.id],
        };
      },
    });
    const notify = vi.fn(() => {
      expect(h.events.at(-1)).toMatchObject({ type: 'assistant', content: 'reply' });
    });
    try {
      const running = coordinator.run({ raw: 'hi', source: 'user' }, async () => outcome(), notify);
      await started.promise;
      expect(notify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);
      expect((await running)?.endHooks.interrupted).toBe(true);
      expect(h.events.at(-1)).toMatchObject({
        type: 'hook_timeout',
        event: 'turn_end',
        timeoutMs: 50,
      });
      const before = h.events.length;
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events).toHaveLength(before);
      expect(h.ledger.listEntries().map((e) => e.content)).toContain('keep me');
      expect(h.ledger.listEntries().map((e) => e.content)).not.toContain('late');
      h.hooks.unregister('late');
      await coordinator.run({ raw: 'next', source: 'user' }, async () => outcome());
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  it.each([0, -1, Infinity, NaN, 0.5, 60_001])(
    'refuses an unbounded/invalid end-hook budget %s',
    (ms) => {
      expect(
        () => new SessionTurnCoordinator({ ...harness().ports, endHookTimeoutMs: ms })
      ).toThrow(RangeError);
    }
  );

  it.each([0, -1, Infinity, NaN, 0.5, 60_001])(
    'refuses an unbounded/invalid prompt-hook budget %s',
    (ms) => {
      expect(
        () => new SessionTurnCoordinator({ ...harness().ports, promptHookTimeoutMs: ms })
      ).toThrow(RangeError);
    }
  );

  it('bounds prompt hooks before dispatch and drops their late results', async () => {
    vi.useFakeTimers();
    const h = harness();
    const coordinator = new SessionTurnCoordinator({ ...h.ports, promptHookTimeoutMs: 30 });
    const release = deferred();
    const started = deferred();
    h.hooks.register({
      name: 'slow-prompt',
      event: 'prompt_build',
      handler: async () => {
        started.resolve();
        await release.promise;
        return { inject: [{ role: 'system', content: 'late prompt', source: 'fixture' }] };
      },
    });
    const execute = vi.fn(async () => outcome());
    try {
      const run = coordinator.run({ raw: 'hi', source: 'user' }, execute);
      await started.promise;
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30);
      await run;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: 'hook_timeout', event: 'prompt_build', timeoutMs: 30 })
      );
      const before = h.events.length;
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events).toHaveLength(before);
      expect(h.ledger.listEntries().map((e) => e.content)).not.toContain('late prompt');
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  it('parent cancellation ends a prompt hook wait without dispatch or a synthetic timeout', async () => {
    const h = harness();
    const stop = new AbortController();
    const release = deferred();
    const started = deferred();
    const abortError = new Error('stopped by host');
    h.hooks.register({
      name: 'gated-prompt',
      event: 'prompt_build',
      handler: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const execute = vi.fn(async () => outcome());
    const run = h.coordinator.run({ raw: 'hi', source: 'user' }, execute, undefined, stop.signal);
    const assertion = expect(run).rejects.toBe(abortError);
    await started.promise;
    stop.abort(abortError);
    await assertion;
    expect(execute).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.type === 'hook_timeout')).toBe(false);
    expect(h.events.at(-1)).toMatchObject({
      type: 'input_cancelled',
      inputEid: h.events[0].eid,
      stage: 'before_ordinary_dispatch',
    });
    release.resolve();
  });

  it.each(['user', 'system', 'inbox-auto'] as const)(
    '%s cancelled after recording stays history with a receipt, not a pending command',
    async (source) => {
      const h = harness();
      const stop = new AbortController();
      h.ports.inputRecorded.mockImplementation(async () => {
        stop.abort(new Error('stopped'));
      });
      const execute = vi.fn(async () => outcome());
      await expect(
        h.coordinator.run({ raw: 'retained input', source }, execute, undefined, stop.signal)
      ).rejects.toThrow('stopped');
      expect(execute).not.toHaveBeenCalled();
      expect(h.events).toHaveLength(2);
      expect(h.events[0].content).toBe('retained input');
      expect(h.events[1]).toMatchObject({
        type: 'input_cancelled',
        inputEid: h.events[0].eid,
        stage: 'before_ordinary_dispatch',
      });
      expect(h.ledger.listEntries()).toHaveLength(1);
      expect(h.coordinator.turnCount).toBe(0);
    }
  );

  it('awaits the cancellation receipt before returning; compaction is not claimed effect-free', async () => {
    const h = harness();
    const stop = new AbortController();
    const release = deferred();
    const writing = deferred();
    h.ports.log = new SessionLog({
      path: 'memory',
      sink: {
        write: async (line) => {
          const entry = JSON.parse(line);
          if (entry.type === 'input_cancelled') {
            writing.resolve();
            await release.promise;
          }
          h.events.push(entry);
        },
      },
    });
    h.ports.compact.mockImplementation(async () => {
      h.ports.log.append({ type: 'synthetic_compaction_effect' });
      stop.abort(new Error('stopped'));
    });
    const execute = vi.fn(async () => outcome());
    let returned = false;
    const run = h.coordinator
      .run({ raw: 'hi', source: 'user' }, execute, undefined, stop.signal)
      .catch((error: unknown) => {
        returned = true;
        return error;
      });
    await writing.promise;
    expect(returned).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    release.resolve();
    await run;
    expect(h.events.map((event) => event.type)).toEqual([
      'user',
      'synthetic_compaction_effect',
      'input_cancelled',
    ]);
    expect(h.events.at(-1)).toMatchObject({ stage: 'before_ordinary_dispatch' });
  });

  it('does not report cancellation confirmation if the receipt cannot be persisted', async () => {
    const h = harness();
    const stop = new AbortController();
    h.ports.inputRecorded.mockImplementation(async () => {
      stop.abort(new Error('stopped'));
    });
    h.ports.log = new SessionLog({
      path: 'memory',
      sink: {
        write: (line) => {
          const entry = JSON.parse(line);
          if (entry.type === 'input_cancelled') throw new Error('receipt unavailable');
          h.events.push(entry);
        },
      },
    });
    const execute = vi.fn(async () => outcome());
    await expect(
      h.coordinator.run({ raw: 'hi', source: 'user' }, execute, undefined, stop.signal)
    ).rejects.toThrow('receipt unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect(h.events.map((event) => event.type)).toEqual(['user']);
  });

  it('never writes a before-dispatch receipt for a cancellation after execute was entered', async () => {
    const h = harness();
    const stop = new AbortController();
    await expect(
      h.coordinator.run(
        { raw: 'hi', source: 'user' },
        async () => {
          stop.abort(new Error('stopped after entry'));
          throw stop.signal.reason;
        },
        undefined,
        stop.signal
      )
    ).rejects.toThrow('stopped after entry');
    expect(h.events.map((event) => event.type)).toEqual(['user']);
  });

  it('an already cancelled submission does not persist input', async () => {
    const h = harness();
    const stop = new AbortController();
    stop.abort(new Error('cancelled'));
    await expect(
      h.coordinator.run(
        { raw: 'hi', source: 'user' },
        async () => outcome(),
        undefined,
        stop.signal
      )
    ).rejects.toThrow('cancelled');
    expect(h.events).toHaveLength(0);
  });

  it('a throwing outcome observer rejects after the assistant is persisted, without retrying it', async () => {
    const h = harness();
    const execute = vi.fn(async () => outcome());
    const tail = vi.fn(async () => {});
    h.hooks.register({ name: 'tail', event: 'turn_end', handler: tail });
    await expect(
      h.coordinator.run({ raw: 'hi', source: 'user' }, execute, () => {
        throw new Error('view failed');
      })
    ).rejects.toThrow('view failed');
    expect(h.events.at(-1)).toMatchObject({ type: 'assistant', content: 'reply' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tail).not.toHaveBeenCalled();
    expect(h.coordinator.turnCount).toBe(1);
  });

  it('preserves failed-backend transcript metadata without turning it into success', async () => {
    const h = harness();
    const failure = outcome({ success: false, stopReason: 'backend-failure' });
    failure.backend = { success: false, exitCode: 1, durationMs: 10, stderr: 'failed' };
    await h.coordinator.run({ raw: 'hi', source: 'user' }, async () => failure);
    expect(h.events.at(-1)).toMatchObject({
      success: false,
      exitCode: 1,
      stderr: 'failed',
      content: 'reply',
    });
  });

  it('does not synthesize a completed outcome after an execution throw, and releases its local guard', async () => {
    const h = harness();
    await expect(
      h.coordinator.run({ raw: 'first', source: 'user' }, async () => {
        throw new Error('spawn');
      })
    ).rejects.toThrow('spawn');
    expect(h.events.map((e) => e.type)).toEqual(['user']);
    expect(h.coordinator.turnCount).toBe(0);
    await h.coordinator.run({ raw: 'second', source: 'user' }, async () => outcome());
    expect(h.coordinator.turnCount).toBe(1);
  });

  it('skips blank input without lifecycle calls', async () => {
    const h = harness();
    const execute = vi.fn(async () => outcome());
    expect(await h.coordinator.run({ raw: ' \n', source: 'user' }, execute)).toBeUndefined();
    expect(h.events).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(h.ports.compact).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'aborted', 'compacting'] as const)(
    'preserves consumed-result eviction policy on %s turns',
    async (mode) => {
      const h = harness();
      const content = 'local tool recall -> ' + 'x'.repeat(40_000);
      const old = h.ledger.addEntry('system', content, 'local-tool', 20);
      h.ledger.addEntry('assistant', 'old', 'claude');
      h.ledger.addEntry('assistant', 'recent', 'claude');
      const recent = h.ledger.addEntry(
        'system',
        'local tool recall -> still needed',
        'local-tool',
        21
      );
      h.state.compactionInFlight = mode === 'compacting';
      const result = await h.coordinator.run({ raw: 'next', source: 'user' }, async () =>
        outcome(mode === 'aborted' ? { success: false, stopReason: 'aborted' } : {})
      );
      expect(h.ledger.listEntries().some((e) => e.id === recent.id)).toBe(true);
      if (mode !== 'ordinary') {
        expect(h.recordEviction).not.toHaveBeenCalled();
        expect(h.ledger.listEntries().some((e) => e.id === old.id)).toBe(true);
      } else {
        expect(result?.autoEviction).toMatchObject({ entries: 1, tools: ['recall'] });
        expect(h.recordEviction).toHaveBeenCalledWith(
          'system',
          expect.any(String),
          old.approxTokens,
          [expect.objectContaining({ eid: 20, hash: entryRefHash('system', content) })]
        );
        expect(h.ledger.listEntries().some((e) => e.id === old.id)).toBe(false);
        const tombstone = h.events.find((e) => e.type === 'context_note');
        expect(tombstone).toBeDefined();
        expect(h.ledger.listEntries().find((e) => e.source === 'auto-evict')?.eid).toBe(
          tombstone?.eid
        );
      }
    }
  );
});
