import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest, BackendRunResult } from './backend-runner.js';
import type { BackendMessageSource, BackendTextSource, BackendTurnEvent } from './stream.js';
import { runToolStreamingAttempt } from './tool-stream-attempt.js';
import { createStreamToolDispatch } from '../runtime/stream-tool-dispatch.js';
import { ClaudeStreamParser } from './claude-stream.js';
import { CodexStreamParser } from './codex-stream.js';

const parent: BackendMessageSource = { messageId: 'synthetic-parent', origin: 'parent' };
const source = (blockId = 'synthetic-block', offset = 0): BackendTextSource => ({
  ...parent,
  blockId,
  offset,
});
const call = (name = 'remember') =>
  '```ink-tool\n' + JSON.stringify({ tool: name, args: {} }) + '\n```\n';
const delta = (text: string, over: Partial<BackendTextSource> = {}): BackendTurnEvent => ({
  kind: 'text-delta',
  text,
  source: { ...source(), ...over },
});
const snapshot = (text: string, over: Partial<BackendTextSource> = {}): BackendTurnEvent => ({
  kind: 'text',
  text,
  source: { ...source(), ...over },
});
const final = (text: string, over: Partial<BackendRunResult> = {}): BackendRunResult => ({
  success: true,
  responseText: text,
  responseSource: parent,
  stdout: text,
  stderr: '',
  exitCode: 0,
  childExited: true,
  durationMs: 0,
  command: 'synthetic provider',
  ...over,
});

/** Real admission/extraction and scheduler, but no provider, process or effect port. */
async function harness() {
  let emit!: NonNullable<BackendRunRequest['onEvent']>;
  let end!: (result: BackendRunResult) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = new Promise<BackendRunResult>((resolve) => {
    end = resolve;
  });
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    success: true,
  }));
  const onEvent = vi.fn();
  const reportFailure = vi.fn();
  const abort = vi.fn();
  const controller = new AbortController();
  let ordinal = 0;
  const running = runToolStreamingAttempt({
    request: { onEvent } as BackendRunRequest,
    signal: controller.signal,
    startTurn(request) {
      emit = request.onEvent!;
      ready();
      return { result, abort };
    },
    onAbortHandle: () => {},
    ports: {
      open: async (signal) => {
        const stream = createStreamToolDispatch({
          enabled: true,
          executor: {
            policy: { canCallInkTool: () => ({ allowed: true, reason: 'fixture' }) },
            mintInvocationId: () => `synthetic-invocation-${++ordinal}`,
            impossibleCallRefusal: () => null,
            commitIntent: async () => {},
            callTool,
            promptForApproval: async () => false,
            signal,
          },
        })!;
        return {
          signal,
          markGenerationEnded: () => {},
          append: (text) => stream.append(text),
          finish: async (options) => ({ ...(await stream.finish(options)), records: [] }),
        };
      },
      reportFailure,
    },
  });
  await started;
  return { emit, end, running, callTool, onEvent, reportFailure, abort, controller };
}

describe('provider effect provenance', () => {
  // Wren's source inspection of Claude Code 2.1.300 found snapshot-before-stop
  // today. These synthetic alternate orders deliberately do not depend on that
  // internal ordering; they are not recorded frames or a live provider probe.
  it.each(['before-stop', 'after-stop', 'after-message-end'])(
    'dispatches a streamed block only once when its snapshot arrives %s',
    async (order) => {
      const h = await harness();
      const p = new ClaudeStreamParser();
      const line = (frame: object) => JSON.stringify(frame) + '\n';
      const partial = (event: object) =>
        line({ type: 'stream_event', parent_tool_use_id: null, event });
      const text = call();
      const emit = (frames: string) => p.push(frames).forEach(h.emit);
      emit(
        partial({ type: 'message_start', message: { id: parent.messageId } }) +
          partial({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      );
      await vi.waitFor(() => expect(h.callTool).toHaveBeenCalledOnce());
      const snap = line({
        type: 'assistant',
        uuid: 'synthetic-snapshot',
        parent_tool_use_id: null,
        message: { id: parent.messageId, content: [{ type: 'text', text }] },
      });
      const stop = partial({ type: 'content_block_stop', index: 0 });
      const end =
        partial({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
        partial({ type: 'message_stop' });
      emit(
        order === 'before-stop'
          ? snap + stop + end
          : order === 'after-stop'
            ? stop + snap + end
            : stop + end + snap
      );
      // Let the fake executor drain before final confirmation, so a refusal at
      // final cannot conceal a second effect already caused by the snapshot.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const effectsBeforeFinal = h.callTool.mock.calls.length;
      const parsedFinal = p.push(line({ type: 'result', subtype: 'success', result: '' })).at(-1);
      if (parsedFinal?.kind !== 'result') throw new Error('Missing fixture final');
      h.end(final(parsedFinal.text!, { responseSource: parsedFinal.source }));
      const settled = await h.running;
      expect(effectsBeforeFinal).toBe(1);
      expect(settled.success, settled.stderr).toBe(true);
      expect(h.callTool).toHaveBeenCalledOnce();
    }
  );

  it('dispatches a proven parent prefix before completion and does not replay positions or snapshots', async () => {
    const h = await harness();
    const text = call();
    h.emit(delta(text));
    await vi.waitFor(() => expect(h.callTool).toHaveBeenCalledOnce());
    h.emit(delta(text));
    h.emit(snapshot(text));
    h.emit(snapshot(text));
    h.end(final(text));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).toHaveBeenCalledOnce();
    expect(h.onEvent).toHaveBeenCalledTimes(4);
  });

  it('includes initial text and uses UTF-16 positions for overlapping deltas', async () => {
    const h = await harness();
    const text = '🌙\n' + call();
    h.emit({
      kind: 'text-boundary',
      boundary: 'block-start',
      source: source(),
      text: text.slice(0, 8),
    });
    h.emit(delta(text.slice(3), { offset: 3 }));
    h.emit(snapshot(text));
    h.end(final(text));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).toHaveBeenCalledOnce();
  });

  it('ignores child text and boundaries, even with identical parent message and block IDs', async () => {
    const h = await harness();
    const child = {
      ...source(),
      origin: 'child' as const,
      parentToolUseId: 'synthetic-child-tool',
    };
    h.emit({ kind: 'text-boundary', boundary: 'message-start', source: child });
    h.emit(snapshot(call('send_response'), child));
    h.emit({ kind: 'text-boundary', boundary: 'message-end', source: child, complete: false });
    h.emit(snapshot('Parent reply.'));
    h.end(final('Parent reply.'));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.onEvent).toHaveBeenCalledTimes(4);
  });

  it.each(['missing', 'unknown', 'contradictory-parent', 'empty-message', 'empty-block'])(
    'refuses %s provenance without a tool effect',
    async (mode) => {
      const h = await harness();
      const event = delta(call());
      if (event.kind !== 'text-delta') throw new Error('fixture');
      if (mode === 'missing') delete event.source;
      if (mode === 'unknown') event.source!.origin = 'unknown';
      if (mode === 'contradictory-parent') event.source!.parentToolUseId = 'synthetic-child-tool';
      if (mode === 'empty-message') event.source!.messageId = '';
      if (mode === 'empty-block') event.source!.blockId = '';
      h.emit(event);
      h.end(final(call()));
      expect((await h.running).success).toBe(false);
      expect(h.callTool).not.toHaveBeenCalled();
      expect(h.reportFailure).toHaveBeenCalledOnce();
      expect(h.abort).toHaveBeenCalledOnce();
      expect(h.onEvent).toHaveBeenCalledWith(event);
    }
  );

  it.each([-1, 1, 0.5, NaN, Infinity])(
    'refuses a gap or invalid first offset %s',
    async (offset) => {
      const h = await harness();
      h.emit(delta(call(), { offset }));
      h.end(final(call()));
      expect((await h.running).success).toBe(false);
      expect(h.callTool).not.toHaveBeenCalled();
    }
  );

  it('retains a settled prefix on conflicting replay and refuses every later event', async () => {
    const h = await harness();
    const text = call();
    h.emit(snapshot(text));
    await vi.waitFor(() => expect(h.callTool).toHaveBeenCalledOnce());
    const conflict = snapshot(call('send_response'));
    h.emit(conflict);
    h.emit(snapshot(call('recall'), { blockId: 'second-block' }));
    h.end(final(text));
    const result = await h.running;
    expect(result.success).toBe(false);
    expect(result.toolStream?.results).toMatchObject([
      { tool: 'remember', dispatchState: 'returned' },
    ]);
    expect(h.callTool).toHaveBeenCalledOnce();
    expect(h.onEvent).toHaveBeenCalledWith(conflict);
  });

  it('keeps equal text in distinct blocks and ignores an older exact snapshot', async () => {
    const h = await harness();
    const text = call();
    h.emit(snapshot(text));
    h.emit(snapshot(text, { blockId: 'second-block' }));
    h.emit(snapshot(text));
    h.end(final(text + text));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).toHaveBeenCalledTimes(2);
  });

  it('repairs missing delta suffixes only through the identified block snapshot', async () => {
    const h = await harness();
    const text = call();
    h.emit(delta(text.slice(0, 12)));
    h.emit(snapshot(text));
    h.end(final(text));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).toHaveBeenCalledOnce();
  });

  it.each([
    'open-block',
    'closed-block-extension',
    'snapshot-offset',
    'truncated-snapshot',
    'ended-message',
  ])('refuses %s rather than assembling ambiguous text', async (mode) => {
    const h = await harness();
    h.emit(delta('Checking.\n'));
    if (mode === 'open-block') h.emit(snapshot(call(), { blockId: 'second-block' }));
    if (mode === 'closed-block-extension') {
      h.emit({ kind: 'text-boundary', boundary: 'block-end', source: source() });
      h.emit(delta(call(), { offset: 'Checking.\n'.length }));
    }
    if (mode === 'snapshot-offset') h.emit(snapshot(call(), { offset: 'Checking.\n'.length }));
    if (mode === 'truncated-snapshot') h.emit(snapshot('Check'));
    if (mode === 'ended-message') {
      h.emit({ kind: 'text-boundary', boundary: 'message-end', source: parent, complete: true });
      h.emit(snapshot(call(), { blockId: 'second-block' }));
    }
    h.end(final('Checking.\n' + call()));
    expect((await h.running).success).toBe(false);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'child', 'different', 'stdout', 'unseen-suffix'])(
    'does not authorize EOF from a %s final',
    async (mode) => {
      const h = await harness();
      const text = call().trimEnd();
      h.emit(delta(text));
      const result = final(text);
      if (mode === 'missing') delete result.responseSource;
      if (mode === 'unknown') result.responseSource = { ...parent, origin: 'unknown' };
      if (mode === 'child')
        result.responseSource = { ...parent, origin: 'child', parentToolUseId: 'synthetic-child' };
      if (mode === 'different') result.responseSource = { ...parent, messageId: 'other-parent' };
      if (mode === 'stdout') delete result.responseText;
      if (mode === 'unseen-suffix') result.responseText += '\n' + call('send_response');
      h.end(result);
      expect((await h.running).success).toBe(false);
      expect(h.callTool).not.toHaveBeenCalled();
    }
  );

  it('does not create an executable block identity from a final message alone', async () => {
    const h = await harness();
    h.end(final(call()));
    expect((await h.running).success).toBe(false);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('waits for the successful named final, not message-end, before accepting an EOF fence', async () => {
    const h = await harness();
    const text = call().trimEnd();
    h.emit(snapshot(text));
    h.emit({ kind: 'text-boundary', boundary: 'message-end', source: parent, complete: true });
    expect(h.callTool).not.toHaveBeenCalled();
    h.end(final(text));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).toHaveBeenCalledOnce();
  });

  it('does not promote an interrupted message-end into a successful final', async () => {
    const h = await harness();
    const text = call().trimEnd();
    h.emit(snapshot(text));
    h.emit({ kind: 'text-boundary', boundary: 'message-end', source: parent, complete: false });
    h.end(final(text));
    expect((await h.running).success).toBe(false);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('still refuses a second parent message without joining fences across messages', async () => {
    const h = await harness();
    const text = call().trimEnd();
    h.emit(snapshot(text.slice(0, -3)));
    h.emit(snapshot('```\n', { messageId: 'second-parent' }));
    h.end(final(text));
    expect((await h.running).success).toBe(false);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('keeps the imitation cut across distinct blocks in the same message', async () => {
    const h = await harness();
    h.emit(snapshot('[Tool res'));
    h.emit(snapshot('ults from previous turn]\n' + call(), { blockId: 'second-block' }));
    h.end(final('[Tool results from previous turn]\n' + call()));
    expect((await h.running).success).toBe(true);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('ignores late events after successful settlement without reopening or alerting', async () => {
    const h = await harness();
    h.emit(snapshot('Done.'));
    h.end(final('Done.'));
    expect((await h.running).success).toBe(true);
    h.emit(snapshot(call(), { blockId: 'late' }));
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
  });

  it('resets provider identities for each fresh host-owned attempt', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const h = await harness();
      h.emit(snapshot(call()));
      h.end(final(call()));
      expect((await h.running).success).toBe(true);
      expect(h.callTool).toHaveBeenCalledOnce();
    }
  });

  it('composes the real Claude parser, indexed blocks, initial text, child exclusion and final confirmation', async () => {
    const h = await harness();
    const parser = new ClaudeStreamParser();
    const text = call();
    const partial = (event: object) => ({ type: 'stream_event', parent_tool_use_id: null, event });
    const assistant = (uuid: string, contents: string, child = false) => ({
      type: 'assistant',
      uuid,
      parent_tool_use_id: child ? 'synthetic-child' : null,
      message: { id: parent.messageId, content: [{ type: 'text', text: contents }] },
    });
    const frames = [
      partial({ type: 'message_start', message: { id: parent.messageId } }),
      partial({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: text.slice(0, 8) },
      }),
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(8) },
      }),
      assistant('synthetic-first-snapshot', text),
      partial({ type: 'content_block_stop', index: 0 }),
      assistant('synthetic-child-snapshot', call('send_response'), true),
      partial({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }),
      partial({ type: 'content_block_stop', index: 1 }),
      partial({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
      assistant('synthetic-second-snapshot', text),
      partial({ type: 'content_block_stop', index: 2 }),
      assistant('synthetic-first-snapshot', text),
      partial({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      partial({ type: 'message_stop' }),
      { type: 'result', subtype: 'success', result: '' },
    ];
    const events = parser.push(frames.map((frame) => JSON.stringify(frame) + '\n').join(''));
    for (const event of events) h.emit(event);
    const parsedFinal = events.at(-1);
    if (parsedFinal?.kind !== 'result') throw new Error('Missing fixture final');
    h.end(final(parsedFinal.text!, { responseSource: parsedFinal.source }));
    const settled = await h.running;
    expect(settled.success, settled.stderr).toBe(true);
    expect(h.callTool).toHaveBeenCalledTimes(2);
    expect(h.callTool.mock.calls.every(([name]) => name === 'remember')).toBe(true);
  });

  it('refuses Codex adapter output whose parent origin remains unknown', async () => {
    const h = await harness();
    const parser = new CodexStreamParser();
    const events = parser.push(
      [
        {
          type: 'item.completed',
          item: { type: 'agent_message', id: 'synthetic-codex-item', text: call() },
        },
        { type: 'turn.completed', usage: {} },
      ]
        .map((frame) => JSON.stringify(frame) + '\n')
        .join('')
    );
    for (const event of events) h.emit(event);
    const parsedFinal = events.at(-1);
    if (parsedFinal?.kind !== 'result') throw new Error('Missing fixture final');
    h.end(final(parsedFinal.text!, { responseSource: parsedFinal.source }));
    expect((await h.running).success).toBe(false);
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.reportFailure).toHaveBeenCalledOnce();
  });
});
