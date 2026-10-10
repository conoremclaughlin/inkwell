/** Direct owner-text input for one hosted generation, never an ordinary wake. */
import type { ContextLedger } from './context-ledger.js';
import type { SessionLog } from './session-log.js';

export interface SessionSteeringRequest {
  messageId: string;
  text: string;
}
export interface SessionSteeringReceipt {
  messageId: string;
  /** Inserted means committed to context, not provider delivery or comprehension. */
  status: 'pending' | 'inserted' | 'refused' | 'unknown';
  reason?: string;
  eid?: number;
}
export interface SessionSteeringInsertion extends SessionSteeringRequest {
  eid: number;
}
export const MAX_STEERING_TEXT_BYTES = 8192;
export const MAX_STEERING_GENERATION_BYTES = 32768;
export const MAX_STEERING_RECEIPTS = 128;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);

/** No sender, role, source inbox ID, grants, media, or automatic fallback. */
export function parseSessionSteering(value: unknown): SessionSteeringRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => key !== 'messageId' && key !== 'text') ||
    !validId(v.messageId) ||
    typeof v.text !== 'string' ||
    v.text.length > MAX_STEERING_TEXT_BYTES ||
    !v.text.trim() ||
    v.text.includes('\0') ||
    bytes(v.text) > MAX_STEERING_TEXT_BYTES
  )
    return undefined;
  return { messageId: v.messageId, text: v.text };
}

/** Only inserted records restore user context; request intents never execute on replay. */
export function readSessionSteeringInput(
  event: Record<string, unknown>
): (SessionSteeringRequest & { turnEpoch: string; boundary: number }) | undefined {
  if (
    event.type !== 'steering_input' ||
    event.version !== 1 ||
    !validId(event.turnEpoch) ||
    !Number.isSafeInteger(event.boundary) ||
    (event.boundary as number) < 1
  )
    return undefined;
  const request = parseSessionSteering({ messageId: event.messageId, text: event.text });
  return request
    ? { ...request, turnEpoch: event.turnEpoch, boundary: event.boundary as number }
    : undefined;
}

export interface SessionSteeringPorts {
  turnEpoch: string;
  log: Pick<SessionLog, 'append' | 'flush'>;
  ledger: ContextLedger;
  assertCurrent(): void;
  receipt?(receipt: SessionSteeringReceipt): void;
}

/**
 * The host authenticates the principal and pins the exact generation. This
 * mailbox owns bounded deduplication, write barriers and turn-local acceptance.
 * A restart cannot resume this mailbox: the host must refuse its retired epoch.
 * Nothing here reads inbox cursors, starts a provider or authorizes a tool.
 */
export function createSessionSteering(ports: SessionSteeringPorts) {
  if (!validId(ports.turnEpoch)) throw new Error('Invalid steering generation');
  type Entry = {
    request: SessionSteeringRequest;
    receipt: SessionSteeringReceipt;
    ready: Promise<SessionSteeringReceipt>;
  };
  const entries = new Map<string, Entry>();
  let pending: string[] = [];
  let accepting = false;
  let closed = false;
  let poisoned = false;
  let usedBytes = 0;
  let boundary = 0;
  let draining: Promise<SessionSteeringInsertion[]> | undefined;
  let ending: Promise<void> | undefined;

  function assertHealthy(signal?: AbortSignal) {
    signal?.throwIfAborted();
    ports.assertCurrent();
    if (poisoned) throw new Error('Steering persistence is uncertain');
  }
  function publish(entry: Entry, receipt: SessionSteeringReceipt) {
    entry.receipt = receipt;
    try {
      ports.receipt?.({ ...receipt });
    } catch {
      /* presentation is not authority */
    }
    return { ...receipt };
  }
  async function unknown(entry: Entry) {
    poisoned = true;
    const receipt = publish(entry, {
      messageId: entry.request.messageId,
      status: 'unknown',
      reason: 'persistence_or_owner_uncertain',
    });
    // Preserve the terminal uncertainty when the writer is still usable. A
    // failed/retired writer may itself prevent recording this fact; never
    // pretend that a failed attempt to record uncertainty makes it a refusal.
    try {
      ports.log.append({
        type: 'steering_receipt',
        version: 1,
        turnEpoch: ports.turnEpoch,
        ...receipt,
      });
      await ports.log.flush();
    } catch {
      /* receipt remains unknown */
    }
    return receipt;
  }
  async function recordReceipt(entry: Entry, receipt: SessionSteeringReceipt) {
    ports.log.append({
      type: 'steering_receipt',
      version: 1,
      turnEpoch: ports.turnEpoch,
      messageId: receipt.messageId,
      status: receipt.status,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.eid === undefined ? {} : { inputEid: receipt.eid }),
    });
    await ports.log.flush();
    return publish(entry, receipt);
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
  function endTurn(reason = 'turn_finished'): Promise<void> {
    // Synchronous fence: admissions arriving during settlement cannot spill.
    accepting = false;
    if (ending) return ending;
    ending = (async () => {
      if (draining) {
        try {
          await draining;
        } catch {
          /* its entries already carry uncertainty */
        }
      }
      const remaining = pending;
      pending = [];
      for (const id of remaining) {
        const entry = entries.get(id)!;
        await entry.ready;
        if (entry.receipt.status === 'pending') await refuse(entry, reason);
      }
    })().finally(() => {
      ending = undefined;
    });
    return ending;
  }
  return {
    assertHealthy,
    pendingTextBytes() {
      let total = 0;
      for (const entry of entries.values()) {
        if (entry.receipt.status === 'pending') total += bytes(entry.request.text);
      }
      return total;
    },
    beginTurn() {
      assertHealthy();
      if (closed || accepting || draining || ending || pending.length)
        throw new Error('Steering owner not ready');
      accepting = true;
    },
    enqueue(value: SessionSteeringRequest): Promise<SessionSteeringReceipt> {
      const request = parseSessionSteering(value);
      const refused = (reason: string) =>
        Promise.resolve<SessionSteeringReceipt>({
          messageId: typeof value?.messageId === 'string' ? value.messageId : '',
          status: 'refused',
          reason,
        });
      if (!request) return refused('invalid_steering');
      // Reconciliation is read-only, including after a write poisoned intake.
      // Never turn a known uncertain prior delivery into a definitive refusal.
      const prior = entries.get(request.messageId);
      if (prior)
        return prior.request.text === request.text
          ? prior.ready.then(() => ({ ...prior.receipt }))
          : refused('message_id_conflict');
      try {
        assertHealthy();
      } catch {
        return refused('owner_unavailable');
      }
      if (closed || !accepting) return refused('no_active_turn');
      if (
        entries.size >= MAX_STEERING_RECEIPTS ||
        usedBytes + bytes(request.text) > MAX_STEERING_GENERATION_BYTES
      )
        return refused('steering_capacity');
      const entry: Entry = {
        request,
        receipt: { messageId: request.messageId, status: 'pending' },
        ready: Promise.resolve({ messageId: request.messageId, status: 'pending' }),
      };
      entries.set(request.messageId, entry);
      usedBytes += bytes(request.text);
      pending.push(request.messageId);
      entry.ready = (async () => {
        try {
          ports.log.append({
            type: 'steering_request',
            version: 1,
            turnEpoch: ports.turnEpoch,
            ...request,
          });
          await ports.log.flush();
          assertHealthy();
          // A late acknowledgment never promotes an input after its turn closed.
          if (!accepting || closed) return await refuse(entry, 'turn_finished');
          return publish(entry, entry.receipt);
        } catch {
          return unknown(entry);
        }
      })();
      return entry.ready;
    },
    /** Called only after a complete tool round, immediately before continuation. */
    drain(signal?: AbortSignal): Promise<SessionSteeringInsertion[]> {
      if (draining) return Promise.reject(new Error('Steering already draining'));
      const ids = pending;
      pending = [];
      const work = async () => {
        const inserted: SessionSteeringInsertion[] = [];
        try {
          assertHealthy(signal);
          if (!accepting || closed) throw new Error('Steering turn closed');
          const round = ++boundary;
          for (const id of ids) {
            const entry = entries.get(id)!;
            await entry.ready;
            if (entry.receipt.status !== 'pending') continue;
            let attemptingWrite = false;
            try {
              assertHealthy(signal);
              if (!accepting || closed) {
                await refuse(entry, 'turn_finished');
                continue;
              }
              attemptingWrite = true;
              const eid = ports.log.append({
                type: 'steering_input',
                version: 1,
                turnEpoch: ports.turnEpoch,
                ...entry.request,
                boundary: round,
              });
              await ports.log.flush();
              assertHealthy(signal);
              if (!accepting || closed) throw new Error('Steering turn closed during persistence');
              ports.ledger.addEntry('user', entry.request.text, 'steering', eid);
              await recordReceipt(entry, { messageId: id, status: 'inserted', eid });
              assertHealthy(signal);
              inserted.push({ ...entry.request, eid });
            } catch (error) {
              if (attemptingWrite) await unknown(entry);
              else await refuse(entry, 'owner_stopped');
              throw error;
            }
          }
          assertHealthy(signal);
          return inserted;
        } catch (error) {
          // Snapshot entries must not disappear if an earlier write fails.
          for (const id of ids) {
            const entry = entries.get(id)!;
            await entry.ready;
            if (entry.receipt.status === 'pending') await refuse(entry, 'boundary_failed');
          }
          throw error;
        }
      };
      draining = work().finally(() => {
        draining = undefined;
      });
      return draining;
    },
    endTurn,
    async close(reason = 'owner_closed') {
      closed = true;
      await endTurn(reason);
    },
  };
}
