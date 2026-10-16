/** Default native Claude input queue; no interruption, transcript surgery or replay. */
import { randomUUID } from 'crypto';
import { createNativeSessionSteering } from '@inklabs/shared/runtime';
import type { NativeSteeringBinding } from './native-steering-binding.js';

export async function openClaudeInputQueue(ports: {
  binding: NativeSteeringBinding;
  nativeSessionId: string;
  write(line: string): void;
  endInput(): void;
  failed(): void;
}) {
  const { binding } = ports;
  const log = await binding.openLog();
  const inputs = new Map<
    string,
    { messageId?: string; started: boolean; completed: boolean; result: boolean }
  >();
  let admitting = true;
  let initialized = false;
  let admissions = 0;
  let release: (() => void) | undefined;
  let error: string | undefined;
  let drained = false;
  let finishing: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;

  function fail() {
    error ??= 'Claude native input delivery could not be confirmed';
    admitting = false;
    void mailbox.close('transport_uncertain');
    ports.failed();
  }
  function writeInput(text: string, messageId?: string) {
    binding.assertCurrent();
    const uuid = randomUUID();
    // Register before writing: a write can synchronously produce output in a host adapter.
    inputs.set(uuid, { messageId, started: false, completed: false, result: false });
    ports.write(
      JSON.stringify({
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        client_composed: true,
        message: { role: 'user', content: text },
      }) + '\n'
    );
  }
  const mailbox = createNativeSessionSteering({
    turnEpoch: binding.turnEpoch,
    log,
    assertCurrent: binding.assertCurrent,
    dispatch: async (request) => {
      if (!admitting) return { status: 'refused', reason: 'input_closed' };
      try {
        writeInput(request.text, request.messageId);
        // A successful pipe write is NOT insertion evidence.
        return { status: 'accepted' };
      } catch {
        fail();
        return { status: 'unknown', reason: 'input_write_uncertain' };
      }
    },
  });

  function maybeFinish() {
    if (
      !admitting ||
      admissions ||
      !inputs.size ||
      [...inputs.values()].some((input) => !input.completed || !input.result)
    )
      return;
    // Seal synchronously, before any persistence await. A later arrival belongs
    // to the next host run; an already admitted but not yet written input holds us.
    admitting = false;
    finishing = (async () => {
      await mailbox.settled();
      await mailbox.close('turn_finished');
      drained = true;
      ports.endInput();
    })().catch(fail);
  }

  return {
    get error() {
      return error;
    },
    get drained() {
      return drained;
    },
    start(text: string) {
      if (!admitting || inputs.size)
        throw new Error('Claude input queue already started or closed');
      ports.write(
        JSON.stringify({
          type: 'control_request',
          request_id: 'ink-initialize',
          request: { subtype: 'initialize', hooks: {} },
        }) + '\n'
      );
      writeInput(text);
    },
    receive(frame: Record<string, unknown>) {
      if (!admitting || frame.session_id !== ports.nativeSessionId || frame.parent_tool_use_id)
        return;
      if (frame.type === 'system' && frame.subtype === 'init' && !initialized) {
        // Do not offer steering on a native binary that lacks the observed
        // per-input lifecycle contract. Its version alone is not the capability.
        if (
          !Array.isArray(frame.capabilities) ||
          !frame.capabilities.includes('msg_lifecycle_v1')
        ) {
          fail();
          return;
        }
        initialized = true;
        try {
          release = binding.bind(async (request) => {
            if (!admitting)
              return { messageId: request.messageId, status: 'refused', reason: 'no_active_turn' };
            admissions++;
            try {
              return await mailbox.submit(request);
            } finally {
              admissions--;
              maybeFinish();
            }
          });
        } catch {
          fail();
        }
      }
      if (frame.type === 'command_lifecycle' && typeof frame.command_uuid === 'string') {
        const input = inputs.get(frame.command_uuid);
        if (!input) return;
        if (frame.state === 'started' && !input.started) {
          input.started = true;
          // Only the owned transport's host-generated UUID can correlate an
          // observation. This is provider intake, not comprehension, success,
          // or durable restart settlement. The source input remains host-owned.
          if (input.messageId) void mailbox.observeInserted(input.messageId);
        }
        if (frame.state === 'completed') input.completed = true;
      }
      if (frame.type === 'result') {
        if (!Array.isArray(frame.user_message_uuids)) {
          fail();
          return;
        }
        for (const uuid of frame.user_message_uuids) {
          if (typeof uuid !== 'string') continue;
          const input = inputs.get(uuid);
          if (input) input.result = true;
        }
        if (frame.is_error === true) error ??= 'Claude native query failed';
      }
      maybeFinish();
    },
    stop() {
      admitting = false;
      return mailbox.close('owner_stopped');
    },
    dispose() {
      return (disposing ??= (async () => {
        admitting = false;
        await finishing;
        await mailbox.close('process_closed');
        try {
          await log.close();
        } catch {
          error ??= 'Claude native evidence close failed';
        } finally {
          release?.();
        }
      })());
    },
  };
}

export type ClaudeInputQueue = Awaited<ReturnType<typeof openClaudeInputQueue>>;
