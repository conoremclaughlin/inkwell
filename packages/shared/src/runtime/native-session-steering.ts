/** Native steering evidence, never a hosted ledger input or a replayable turn. */
import type { SessionLog } from './session-log.js';
import {
  MAX_STEERING_GENERATION_BYTES,
  MAX_STEERING_RECEIPTS,
  parseSessionSteering,
  type SessionSteeringReceipt,
  type SessionSteeringRequest,
} from './session-steering.js';

export interface NativeSteeringDispatchResult {
  /** Acceptance is not evidence that a provider inserted the text. */
  status: 'accepted' | 'refused' | 'unknown';
  /** Static diagnostic code only; arbitrary provider output is not journaled. */
  reason?: string;
}
export interface NativeSessionSteeringPorts {
  turnEpoch: string;
  log: Pick<SessionLog, 'append' | 'flush'>;
  assertCurrent(): void;
  dispatch(request: SessionSteeringRequest): Promise<NativeSteeringDispatchResult>;
  receipt?(receipt: SessionSteeringReceipt): void;
}

const textBytes = (text: string) => new TextEncoder().encode(text).byteLength;
const diagnostic = (reason: string | undefined, fallback: string) =>
  reason && /^[a-z0-9_:-]{1,128}$/.test(reason) ? reason : fallback;

/**
 * One admitted native generation. It starts accepting and cannot be reopened.
 * The host authenticates ownership and binds a dispatch to the already-running
 * native turn. Only a trustworthy, correlated provider echo may call
 * observeInserted; RPC acceptance alone must never do so.
 *
 * submit acknowledges durable admission without waiting for the dispatch RPC.
 * Its later outcome is published through receipt/reconciliation. end fences
 * synchronously and settles without waiting for a stuck RPC. Neither method
 * starts a new turn, retries a dispatch, or falls back to the ordinary queue.
 */
export function createNativeSessionSteering(ports: NativeSessionSteeringPorts) {
  if (!parseSessionSteering({ messageId: ports.turnEpoch, text: 'generation' }))
    throw new Error('Invalid steering generation');
  type Entry = {
    request: SessionSteeringRequest;
    receipt: SessionSteeringReceipt;
    ready: Promise<SessionSteeringReceipt>;
    chain: Promise<void>;
    dispatched: boolean;
    observation?: Promise<SessionSteeringReceipt>;
  };
  const entries = new Map<string, Entry>();
  const work = new Set<Promise<unknown>>();
  let accepting = true;
  let poisoned = false;
  let usedBytes = 0;
  let endReason = 'turn_finished';
  let ending: Promise<void> | undefined;

  function assertHealthy() {
    ports.assertCurrent();
    if (poisoned) throw new Error('Native steering evidence is uncertain');
  }
  const pending = (entry: Entry) => entry.receipt.status === 'pending';
  function publish(entry: Entry, receipt: SessionSteeringReceipt) {
    entry.receipt = receipt;
    try {
      ports.receipt?.({ ...receipt });
    } catch {
      /* Presentation cannot change the durable outcome. */
    }
    return { ...receipt };
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise)
    );
    return promise;
  }
  function serial<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const result = entry.chain.then(action);
    entry.chain = result.then(
      () => undefined,
      () => undefined
    );
    return track(result);
  }
  function append(type: string, fields: Record<string, unknown>) {
    ports.assertCurrent();
    return ports.log.append({ type, version: 1, turnEpoch: ports.turnEpoch, ...fields });
  }
  async function flush() {
    ports.assertCurrent();
    await ports.log.flush();
    ports.assertCurrent();
  }
  async function recordReceipt(entry: Entry, receipt: SessionSteeringReceipt) {
    append('native_steering_receipt', {
      messageId: receipt.messageId,
      status: receipt.status,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.eid === undefined ? {} : { observationEid: receipt.eid }),
    });
    await flush();
    // An inserted or pending acknowledgment cannot cross the terminal fence.
    if (!accepting && (receipt.status === 'inserted' || receipt.status === 'pending'))
      throw new Error('Native steering generation ended during persistence');
    return publish(entry, receipt);
  }
  async function unknown(entry: Entry, reason = 'persistence_or_owner_uncertain') {
    poisoned = true;
    const receipt = publish(entry, {
      messageId: entry.request.messageId,
      status: 'unknown',
      reason,
    });
    // Best effort only while this is still the current journal owner. Losing
    // ownership never licenses another append to a replacement generation.
    try {
      append('native_steering_receipt', receipt);
      await flush();
    } catch {
      /* The in-memory outcome remains unknown, never a definitive refusal. */
    }
    return receipt;
  }
  async function refuse(entry: Entry, reason: string) {
    try {
      return await recordReceipt(entry, {
        messageId: entry.request.messageId,
        status: 'refused',
        reason,
      });
    } catch {
      return unknown(entry);
    }
  }
  async function handleDispatch(entry: Entry, result: NativeSteeringDispatchResult) {
    // A later transport result cannot replace an already committed observation
    // or terminal settlement. In particular, it cannot upgrade unknown.
    if (!pending(entry)) return { ...entry.receipt };
    try {
      assertHealthy();
      if (!accepting) return unknown(entry, endReason);
      if (result?.status === 'accepted')
        return await recordReceipt(entry, {
          messageId: entry.request.messageId,
          status: 'pending',
          reason: 'provider_accepted',
        });
      if (result?.status === 'refused')
        return await refuse(entry, diagnostic(result.reason, 'provider_refused'));
      return unknown(entry, diagnostic(result?.reason, 'provider_dispatch_uncertain'));
    } catch {
      return unknown(entry);
    }
  }
  function dispatch(entry: Entry) {
    assertHealthy();
    if (!accepting) throw new Error('Native steering generation ended');
    // Set before invocation: a trustworthy echo may arrive synchronously from
    // the provider transport, even before its dispatch promise is returned.
    entry.dispatched = true;
    let result: Promise<NativeSteeringDispatchResult>;
    try {
      result = ports.dispatch({ ...entry.request });
    } catch {
      result = Promise.resolve({ status: 'unknown', reason: 'provider_dispatch_uncertain' });
    }
    track(
      Promise.resolve(result).then(
        (answer) => serial(entry, () => handleDispatch(entry, answer)),
        () =>
          serial(entry, () =>
            handleDispatch(entry, { status: 'unknown', reason: 'provider_dispatch_uncertain' })
          )
      )
    );
  }
  const declined = (messageId: string, reason: string): SessionSteeringReceipt => ({
    messageId,
    status: 'refused',
    reason,
  });
  function end(reason = 'turn_finished'): Promise<void> {
    // This must happen before the first await or queued persistence callback.
    accepting = false;
    if (ending) return ending;
    endReason = diagnostic(reason, 'turn_finished');
    ending = Promise.all(
      [...entries.values()].map((entry) =>
        serial(entry, async () => {
          if (!pending(entry)) return;
          if (entry.dispatched) await unknown(entry, endReason);
          else await refuse(entry, endReason);
        })
      )
    ).then(() => undefined);
    return ending;
  }
  return {
    assertHealthy,
    submit(value: SessionSteeringRequest): Promise<SessionSteeringReceipt> {
      const request = parseSessionSteering(value);
      if (!request)
        return Promise.resolve(
          declined(typeof value?.messageId === 'string' ? value.messageId : '', 'invalid_steering')
        );
      const prior = entries.get(request.messageId);
      if (prior)
        return prior.request.text === request.text
          ? prior.ready.then(() => ({ ...prior.receipt }))
          : Promise.resolve(declined(request.messageId, 'message_id_conflict'));
      try {
        assertHealthy();
      } catch {
        return Promise.resolve(declined(request.messageId, 'owner_unavailable'));
      }
      if (!accepting) return Promise.resolve(declined(request.messageId, 'no_active_turn'));
      if (
        entries.size >= MAX_STEERING_RECEIPTS ||
        usedBytes + textBytes(request.text) > MAX_STEERING_GENERATION_BYTES
      )
        return Promise.resolve(declined(request.messageId, 'steering_capacity'));
      const receipt: SessionSteeringReceipt = { messageId: request.messageId, status: 'pending' };
      const entry: Entry = {
        request,
        receipt,
        ready: Promise.resolve(receipt),
        chain: Promise.resolve(),
        dispatched: false,
      };
      entries.set(request.messageId, entry);
      usedBytes += textBytes(request.text);
      entry.ready = serial(entry, async () => {
        try {
          assertHealthy();
          if (!accepting) return await refuse(entry, endReason);
          append('native_steering_request', { ...request });
          await flush();
          assertHealthy();
          if (!accepting) return await refuse(entry, endReason);
          await recordReceipt(entry, receipt);
          assertHealthy();
          if (!accepting) return await refuse(entry, endReason);
          dispatch(entry);
          assertHealthy();
          if (!accepting) return await unknown(entry, endReason);
          return { ...entry.receipt };
        } catch {
          return unknown(entry);
        }
      });
      return entry.ready;
    },
    observeInserted(messageId: string): Promise<SessionSteeringReceipt> {
      const entry = entries.get(messageId);
      if (!entry || !entry.dispatched)
        return Promise.resolve(declined(messageId, 'not_dispatched'));
      if (!accepting) return Promise.resolve(declined(messageId, 'no_active_turn'));
      if (!pending(entry)) return Promise.resolve(declined(messageId, 'observation_not_pending'));
      // Duplicate echoes share one outstanding barrier, rather than growing
      // an unbounded queue behind a blocked journal for one accepted ID.
      if (entry.observation) return entry.observation;
      entry.observation = serial(entry, async () => {
        if (!pending(entry)) return declined(messageId, 'observation_not_pending');
        try {
          assertHealthy();
          if (!accepting) return declined(messageId, 'no_active_turn');
          const eid = append('native_steering_observation', { messageId });
          await flush();
          assertHealthy();
          if (!accepting) return await unknown(entry, endReason);
          // eid refers only to native provider evidence, not a local ledger.
          return await recordReceipt(entry, { messageId, status: 'inserted', eid });
        } catch {
          return unknown(entry);
        }
      });
      return entry.observation;
    },
    end,
    close: (reason = 'owner_stopped') => end(reason),
    /** Diagnostics/tests only: unlike end, this waits for dispatch RPC settlement. */
    async settled() {
      while (work.size) await Promise.all([...work]);
    },
  };
}
