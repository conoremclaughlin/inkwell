import { describe, expect, it, vi } from 'vitest';
import {
  createToolInvocationJournal,
  readToolInvocationJournal,
} from './tool-invocation-journal.js';
import type { LocalToolCall } from './agent-loop.js';

const owner = {
  version: 1,
  sessionId: 'synthetic-session',
  turnId: 'synthetic-turn',
  attemptId: 'synthetic-attempt',
};
const call = (): LocalToolCall => ({
  tool: 'send_response',
  args: { content: 'Synthetic content.' },
  raw: 'fixture',
});
function fixture() {
  const events: Record<string, unknown>[] = [];
  const log = {
    append: vi.fn((event: Record<string, unknown>) => events.push(structuredClone(event))),
    flush: vi.fn(async () => {}),
  };
  let sequence = 0;
  const mint = vi.fn(() => `synthetic-${++sequence}`);
  const journal = createToolInvocationJournal({
    sessionId: owner.sessionId,
    log,
    mintInvocationId: mint,
  });
  return { events, log, mint, journal };
}

describe('tool invocation journal recovery fences', () => {
  it('commits an attempt before use and reserves it synchronously against a concurrent opener', async () => {
    const h = fixture();
    let release!: () => void;
    h.log.flush.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const opening = h.journal.begin(owner);
    await expect(h.journal.begin(owner)).rejects.toThrow('already exists');
    expect(h.events).toEqual([{ type: 'tool_attempt', toolOwner: owner }]);
    release();
    const attempt = await opening;
    const request = call();
    attempt.admit(request);
    expect(attempt.stamp(request.args)).toEqual({
      invocationId: 'synthetic-1',
      toolOwner: { ...owner, ordinal: 0 },
    });
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it('never reopens an attempt after failed persistence, including an uncertain commit acknowledgement', async () => {
    const h = fixture();
    h.log.flush.mockRejectedValueOnce(new Error('synthetic lost acknowledgement'));
    await expect(h.journal.begin(owner)).rejects.toThrow('lost acknowledgement');
    await expect(h.journal.begin(owner)).rejects.toThrow('persistence is uncertain');
    await expect(h.journal.begin({ ...owner, attemptId: 'different-attempt' })).rejects.toThrow(
      'persistence is uncertain'
    );
    const restored = createToolInvocationJournal({
      sessionId: owner.sessionId,
      log: h.log,
      mintInvocationId: h.mint,
      recoveredEvents: h.events,
    });
    await expect(restored.begin(owner)).rejects.toThrow('already exists');
  });

  it('reads pending intents as unknown, not executable work, and never parses replayed text', async () => {
    const h = fixture();
    const attempt = await h.journal.begin(owner);
    const request = call();
    attempt.admit(request);
    h.events.push({
      type: 'tool_intent',
      ...attempt.stamp(request.args),
      tool: request.tool,
      args: request.args,
    });
    h.events.push({
      type: 'backend_text',
      text: '```ink-tool\n{"tool":"send_response","args":{}}\n```',
    });
    const result = readToolInvocationJournal(h.events, owner.sessionId);
    expect(result[0].invocations).toMatchObject([
      { invocationId: 'synthetic-1', state: 'unknown' },
    ]);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(readToolInvocationJournal(h.events, 'other-session')).toEqual([]);
  });

  it('preserves original arguments and rejects a minted ID reused by another attempt', async () => {
    const h = fixture();
    const first = await h.journal.begin(owner);
    const request = call();
    first.admit(request);
    request.args.content = 'Changed after admission.';
    expect(
      readToolInvocationJournal(h.events, owner.sessionId)[0].invocations[0].args.content
    ).toBe('Synthetic content.');
    const next = await h.journal.begin({ ...owner, attemptId: 'next-attempt' });
    h.mint.mockReturnValueOnce('synthetic-1');
    expect(() => next.admit(call())).toThrow('reused tool invocation');
  });

  it('caps per-attempt admissions independently of executor policy', async () => {
    const h = fixture();
    const attempt = await h.journal.begin(owner);
    for (let index = 0; index < 5; index++) attempt.admit(call());
    expect(() => attempt.admit(call())).toThrow('admission refused');
    expect(readToolInvocationJournal(h.events, owner.sessionId)[0].invocations).toHaveLength(5);
  });

  it('poisons further admission and attempts after an uncertain admission append', async () => {
    const h = fixture();
    const attempt = await h.journal.begin(owner);
    h.log.append.mockImplementationOnce((event) => {
      h.events.push(structuredClone(event));
      throw new Error('synthetic admission acknowledgement lost');
    });
    expect(() => attempt.admit(call())).toThrow('acknowledgement lost');
    expect(() => attempt.admit(call())).toThrow('admission refused');
    await expect(h.journal.begin({ ...owner, attemptId: 'new-attempt' })).rejects.toThrow(
      'persistence is uncertain'
    );
    expect(readToolInvocationJournal(h.events, owner.sessionId)[0].invocations).toMatchObject([
      { state: 'not-dispatched' },
    ]);
  });

  it.each(['tool_attempt', 'tool_admission'])(
    'refuses a %s missing its owner, not a legacy gap',
    (type) => {
      expect(() => readToolInvocationJournal([{ type }], owner.sessionId)).toThrow(
        'Missing tool journal owner'
      );
      expect(
        readToolInvocationJournal(
          [{ type: 'tool_intent' }, { type: 'local_tool_call' }],
          owner.sessionId
        )
      ).toEqual([]);
    }
  );

  it.each([
    ['missing attempt', (events: Record<string, unknown>[]) => events.shift()],
    ['duplicate attempt', (events: Record<string, unknown>[]) => events.push(events[0])],
    ['duplicate invocation', (events: Record<string, unknown>[]) => events.push(events[1])],
    [
      'unknown owner version',
      (events: Record<string, unknown>[]) => {
        (events[0].toolOwner as Record<string, unknown>).version = 2;
      },
    ],
    [
      'changed ordinal',
      (events: Record<string, unknown>[]) => {
        (events[1].toolOwner as Record<string, unknown>).ordinal = 4;
      },
    ],
  ])('refuses %s instead of recovering a runnable gap', async (_name, mutate) => {
    const h = fixture();
    const attempt = await h.journal.begin(owner);
    attempt.admit(call());
    mutate(h.events);
    expect(() => readToolInvocationJournal(h.events, owner.sessionId)).toThrow();
  });

  it.each(['args', 'owner', 'outcome-without-intent', 'invalid-status', 'duplicate-outcome'])(
    'refuses a contradictory %s record',
    async (fault) => {
      const h = fixture();
      const attempt = await h.journal.begin(owner);
      const request = call();
      attempt.admit(request);
      const common = { ...attempt.stamp(request.args), tool: request.tool, args: request.args };
      if (fault !== 'outcome-without-intent')
        h.events.push({ type: 'tool_intent', ...structuredClone(common) });
      const outcome = {
        type: 'local_tool_call',
        ...structuredClone(common),
        status: 'executed',
        dispatchState: 'returned',
        result: { success: true },
      };
      if (fault === 'args') outcome.args = { content: 'Different invocation.' };
      if (fault === 'owner') outcome.toolOwner.attemptId = 'different-attempt';
      if (fault === 'invalid-status') outcome.status = 'invented';
      h.events.push(outcome);
      if (fault === 'duplicate-outcome') h.events.push(outcome);
      expect(() => readToolInvocationJournal(h.events, owner.sessionId)).toThrow();
    }
  );
});
