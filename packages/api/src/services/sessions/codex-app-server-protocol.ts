/** One owned stdio connection, one native turn. Never attach, retry, or queue a turn. */
import { randomUUID } from 'crypto';
import { classifyError, type ErrorClassification } from '@inklabs/shared';
import type { SessionSteeringRequest } from '@inklabs/shared/runtime';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Classify only a scoped provider failure; never retain its diagnostic text. */
function classifyTurnFailure(value: unknown): ErrorClassification | undefined {
  const error = object(value);
  if (!error) return undefined;
  const info = error.codexErrorInfo;
  const variant = typeof info === 'string' ? info : undefined;
  const details = object(info);
  const connection =
    object(details?.httpConnectionFailed) ??
    object(details?.responseStreamConnectionFailed) ??
    object(details?.responseStreamDisconnected) ??
    object(details?.responseTooManyFailedAttempts);
  const status = connection?.httpStatusCode;
  // These are the camel-case v2 wire variants, not display names. Prefer
  // structured evidence over incidental words in the provider's message.
  const signal =
    variant === 'usageLimitExceeded' ||
    variant === 'sessionBudgetExceeded' ||
    variant === 'rateLimitExceeded' ||
    status === 429
      ? 'usage limit'
      : variant === 'unauthorized' || status === 401 || status === 403
        ? 'unauthorized'
        : variant === 'serverOverloaded' ||
            variant === 'flexUnavailable' ||
            status === 503 ||
            status === 529
          ? 'overloaded'
          : connection
            ? 'network error'
            : typeof error.message === 'string'
              ? error.message
              : '';
  const classification = classifyError({ errorText: signal, backend: 'codex-cli' });
  // A turn already began. Even matching diagnostic text cannot manufacture
  // the pre-acceptance owner refusal reserved for a thread/resume RPC reply.
  if (classification.category === 'owner_conflict' || classification.category === 'unknown')
    return undefined;
  const summaries = {
    quota: 'Codex provider usage limit reached',
    auth: 'Codex provider authentication failed',
    network: 'Codex provider network request failed',
    capacity: 'Codex provider capacity unavailable',
    timeout: 'Codex provider request timed out',
    config: 'Codex provider configuration failed',
    crash: 'Codex provider crashed',
  };
  return { ...classification, summary: summaries[classification.category] };
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    readonly classification?: ErrorClassification
  ) {
    // Provider error bodies can contain prompts, arguments, or credentials.
    super(`Codex app-server request failed (${code})`);
  }
}

export interface CodexAppServerPorts {
  /** Must throw on a closed input. A successful write is not a delivery receipt. */
  write(line: string): void;
  assertCurrent(): void;
  inserted(messageId: string): void;
  event(method: string, params: ObjectValue): void;
  terminal(error?: string): void;
  requestTimeoutMs?: number;
}

/** Protocol only: no process, credentials, persistence, or session registry. */
export function createCodexAppServerProtocol(ports: CodexAppServerPorts) {
  let serial = 0;
  let closed = false;
  let refusalClassification: ErrorClassification | undefined;
  let failureClassification: ErrorClassification | undefined;
  let started = false;
  let startingTurn = false;
  let sawTurnStarted = false;
  let turnConfirmed = false;
  let bufferedBytes = 0;
  let buffered: unknown[] = [];
  let threadId: string | undefined;
  let turnId: string | undefined;
  const pending = new Map<
    number,
    {
      method: string;
      resolve(value: ObjectValue): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      accept?: (value: ObjectValue) => void;
    }
  >();
  // An unpredictable transport-local tag distinguishes equal user texts and
  // the initial prompt. It is never an authority claim supplied by the caller.
  const observations = new Map<string, string>();

  function current() {
    if (closed) throw new Error('Codex app-server connection is closed');
    ports.assertCurrent();
  }
  function close() {
    if (closed) return;
    closed = true;
    observations.clear();
    buffered = [];
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex app-server connection ended'));
    }
    pending.clear();
  }
  function terminal(error?: string) {
    if (closed) return;
    close();
    ports.terminal(error);
  }
  function request(
    method: string,
    params: ObjectValue,
    accept?: (value: ObjectValue) => void
  ): Promise<ObjectValue> {
    try {
      current();
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Codex app-server request acknowledgment timed out'));
      }, ports.requestTimeoutMs ?? 10_000);
      pending.set(requestId, { method, resolve, reject, timer, accept });
      try {
        ports.write(JSON.stringify({ id: requestId, method, params }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  function receive(value: unknown) {
    if (closed) return;
    const message = object(value);
    if (!message) return terminal('Malformed Codex app-server frame');
    try {
      current();
    } catch {
      return terminal('Codex turn ownership was lost');
    }
    if (typeof message.method !== 'string') {
      if (typeof message.id !== 'number') return;
      const waiting = pending.get(message.id);
      if (!waiting) return; // Late acknowledgment cannot revive a timed-out request.
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      const error = object(message.error);
      const result = object(message.result);
      if (error) {
        // Only the trusted reply to thread/resume can establish this known
        // pre-acceptance refusal. Inspect the diagnostic transiently; never
        // retain its body or the classifier's raw-text summary on the Error.
        const ownerConflict =
          waiting.method === 'thread/resume' &&
          typeof error.message === 'string' &&
          classifyError({ errorText: `thread/resume: ${error.message}`, backend: 'codex-cli' })
            .category === 'owner_conflict';
        if (ownerConflict)
          refusalClassification = {
            category: 'owner_conflict',
            summary: 'Codex thread resume refused: another writer holds the thread',
            retryable: false,
          };
        waiting.reject(
          new CodexRpcError(
            typeof error.code === 'number' ? error.code : -32603,
            refusalClassification
          )
        );
      } else if (result) {
        try {
          // Identity validation must be synchronous with the response, not in
          // a later promise continuation after subsequent stream frames ran.
          waiting.accept?.(result);
          waiting.resolve(result);
        } catch (error) {
          waiting.reject(error instanceof Error ? error : new Error('Invalid native response'));
          terminal('Codex app-server response identity was invalid');
        }
      } else waiting.reject(new Error('Malformed Codex app-server response'));
      return;
    }
    // This headless host cannot grant approvals, answer elicitation, or execute
    // dynamic tools. Unknown server requests fail closed rather than hanging.
    if (message.id !== undefined) {
      ports.write(
        JSON.stringify({
          id: message.id,
          error: { code: -32601, message: 'Interactive requests are unavailable in this host' },
        }) + '\n'
      );
      return;
    }
    const params = object(message.params);
    if (!params || params.threadId !== threadId) return;
    if (message.method === 'turn/started') {
      const incoming = object(params.turn)?.id;
      if (
        sawTurnStarted ||
        (!startingTurn && !turnId) ||
        !id(incoming) ||
        (turnId && incoming !== turnId)
      )
        return terminal('Codex app-server attempted an unexpected turn');
      sawTurnStarted = true;
      turnId = incoming;
      return;
    }
    const eventTurnId = params.turnId ?? object(params.turn)?.id;
    if (startingTurn && !turnConfirmed) {
      bufferedBytes += JSON.stringify(message).length;
      if (buffered.length >= 32 || bufferedBytes > 1024 * 1024)
        return terminal('Codex notifications exceeded the startup bound');
      buffered.push(message);
      return;
    }
    if (!turnId || eventTurnId !== turnId) return;
    if (message.method === 'item/completed') {
      const item = object(params.item);
      if (
        item?.type === 'userMessage' &&
        Array.isArray(item.content) &&
        item.content.length === 1
      ) {
        const block = object(item.content[0]);
        const messageId =
          block?.type === 'text' && typeof block.text === 'string'
            ? observations.get(block.text)
            : undefined;
        if (messageId) {
          observations.delete(block!.text as string);
          ports.inserted(messageId);
        }
      }
    }
    if (message.method === 'error') {
      // Retrying notifications are not the turn's final outcome. A terminal
      // notification can still explain an EOF before turn/completed arrives.
      failureClassification =
        params.willRetry === false ? classifyTurnFailure(params.error) : undefined;
    }
    ports.event(message.method, params);
    if (message.method === 'turn/completed') {
      const turn = object(params.turn);
      const status = turn?.status;
      failureClassification =
        status === 'failed'
          ? turn?.error == null
            ? failureClassification
            : classifyTurnFailure(turn.error)
          : undefined;
      terminal(status === 'completed' ? undefined : 'Codex turn did not complete successfully');
    }
  }

  return {
    receive,
    close,
    async start(input: {
      backendSessionId?: string;
      text: string;
      cwd: string;
      model?: string;
      effort?: string;
      sandbox?: 'workspace-write' | 'danger-full-access';
    }) {
      if (started) throw new Error('Codex app-server host owns exactly one turn');
      started = true;
      await request('initialize', { clientInfo: { name: 'inkwell-runner', version: '1' } });
      current();
      ports.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      await request(
        input.backendSessionId ? 'thread/resume' : 'thread/start',
        {
          ...(input.backendSessionId ? { threadId: input.backendSessionId } : {}),
          cwd: input.cwd,
          approvalPolicy: 'never',
          sandbox: input.sandbox ?? 'workspace-write',
          ...(input.model ? { model: input.model } : {}),
        },
        (thread) => {
          const resolved = object(thread.thread)?.id;
          if (!id(resolved) || (input.backendSessionId && resolved !== input.backendSessionId))
            throw new Error('Codex app-server returned a different thread');
          threadId = resolved;
        }
      );
      current();
      startingTurn = true;
      await request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: input.text }],
          ...(input.effort ? { effort: input.effort } : {}),
        },
        (response) => {
          const resolvedTurn = object(response.turn)?.id;
          if (!id(resolvedTurn) || (turnId && resolvedTurn !== turnId))
            throw new Error('Codex app-server returned a different turn');
          turnId = resolvedTurn;
          turnConfirmed = true;
          const waiting = buffered;
          buffered = [];
          bufferedBytes = 0;
          for (const message of waiting) receive(message);
        }
      );
      current();
      startingTurn = false;
      return { threadId: threadId!, turnId: turnId! };
    },
    async steer(
      input: SessionSteeringRequest
    ): Promise<{ status: 'accepted' | 'refused' | 'unknown'; reason?: string }> {
      if (closed || !threadId || !turnId || startingTurn)
        return { status: 'refused', reason: 'no_active_native_turn' };
      try {
        current();
      } catch {
        return { status: 'refused', reason: 'owner_retired' };
      }
      const expectedTurnId = turnId;
      const text = `[Owner steering ${randomUUID()}]\n${input.text}`;
      observations.set(text, input.messageId);
      try {
        const response = await request('turn/steer', {
          threadId,
          expectedTurnId,
          input: [{ type: 'text', text }],
        });
        current();
        if (response.turnId !== expectedTurnId) throw new Error('Steering turn mismatch');
        return { status: 'accepted' };
      } catch {
        // Even an error response is not evidence of non-execution unless its
        // contract says so. No resend, fresh turn, or ordinary-inbox fallback.
        return { status: 'unknown', reason: 'provider_outcome_uncertain' };
      }
    },
    // Captured synchronously with the trusted refusal frame, before a close
    // in the same chunk can overtake start()'s promise rejection handler.
    get refusalClassification() {
      return refusalClassification ? { ...refusalClassification } : undefined;
    },
    get failureClassification() {
      return failureClassification ? { ...failureClassification } : undefined;
    },
    get threadId() {
      return threadId;
    },
    get turnId() {
      return turnId;
    },
  };
}
