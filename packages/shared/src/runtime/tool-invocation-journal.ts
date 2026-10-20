import { MAX_TOOL_CALLS_PER_ITERATION, type LocalToolCall } from './agent-loop.js';
import type { ToolCallResult } from './tool-call-executor.js';

export interface ToolAttemptOwner {
  sessionId: string;
  turnId: string;
  attemptId: string;
}
export interface ToolInvocationStamp extends ToolAttemptOwner {
  version: 1;
  ordinal: number;
}
type Log = { append(event: Record<string, unknown>): number; flush(): Promise<void> };
export interface RecoveredToolInvocation {
  invocationId: string;
  toolOwner: ToolInvocationStamp;
  tool: string;
  args: Record<string, unknown>;
  /** A persisted intent without an outcome is uncertain, never runnable work. */
  state: 'not-dispatched' | 'unknown' | 'settled';
  /** The tool payload is opaque JSON, including null, arrays and primitives. */
  result?: Omit<ToolCallResult, 'result'> & { result?: unknown };
}
export interface RecoveredToolAttempt {
  owner: ToolAttemptOwner;
  invocations: RecoveredToolInvocation[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const key = (owner: ToolAttemptOwner) =>
  JSON.stringify([owner.sessionId, owner.turnId, owner.attemptId]);
function readOwner(value: unknown): ToolAttemptOwner {
  if (
    !record(value) ||
    value.version !== 1 ||
    !validId(value.sessionId) ||
    !validId(value.turnId) ||
    !validId(value.attemptId)
  ) {
    throw new Error('Invalid tool journal owner');
  }
  return { sessionId: value.sessionId, turnId: value.turnId, attemptId: value.attemptId };
}

/**
 * Rehydrate metadata only, never executable calls or replayed provider text.
 * Malformed/contradictory owned records refuse recovery rather than treating a
 * missing identity as permission to try an external effect again.
 */
export function readToolInvocationJournal(
  events: Iterable<Record<string, unknown>>,
  sessionId: string
): RecoveredToolAttempt[] {
  if (!validId(sessionId)) throw new Error('Invalid tool journal session');
  const attempts = new Map<string, RecoveredToolAttempt>();
  const ids = new Map<string, RecoveredToolInvocation>();
  for (const event of events) {
    if (
      !['tool_attempt', 'tool_admission', 'tool_intent', 'local_tool_call'].includes(
        String(event.type)
      )
    )
      continue;
    if (event.toolOwner === undefined) {
      // These two record types were introduced with stream ownership; they
      // cannot be legacy entries. Ignoring one could reopen a lost attempt.
      if (event.type === 'tool_attempt' || event.type === 'tool_admission')
        throw new Error('Missing tool journal owner');
      continue; // Pre-stream intent/outcome entries are not claims.
    }
    const owner = readOwner(event.toolOwner);
    if (owner.sessionId !== sessionId) continue;
    const attemptKey = key(owner);
    if (event.type === 'tool_attempt') {
      if (attempts.has(attemptKey)) throw new Error('Duplicate tool attempt in journal');
      attempts.set(attemptKey, { owner, invocations: [] });
      continue;
    }
    const attempt = attempts.get(attemptKey);
    const stamp = event.toolOwner as Record<string, unknown>;
    if (
      !attempt ||
      !Number.isSafeInteger(stamp.ordinal) ||
      (stamp.ordinal as number) < 0 ||
      !validId(event.invocationId) ||
      typeof event.tool !== 'string' ||
      !event.tool ||
      !record(event.args)
    ) {
      throw new Error('Invalid tool invocation in journal');
    }
    const toolOwner: ToolInvocationStamp = {
      ...owner,
      version: 1,
      ordinal: stamp.ordinal as number,
    };
    if (event.type === 'tool_admission') {
      if (ids.has(event.invocationId) || toolOwner.ordinal !== attempt.invocations.length)
        throw new Error('Duplicate or nonsequential tool invocation');
      const invocation: RecoveredToolInvocation = {
        invocationId: event.invocationId,
        toolOwner,
        tool: event.tool,
        args: structuredClone(event.args),
        state: 'not-dispatched',
      };
      attempt.invocations.push(invocation);
      ids.set(invocation.invocationId, invocation);
      continue;
    }
    const invocation = ids.get(event.invocationId);
    if (
      !invocation ||
      key(invocation.toolOwner) !== attemptKey ||
      invocation.toolOwner.ordinal !== toolOwner.ordinal ||
      invocation.tool !== event.tool ||
      JSON.stringify(invocation.args) !== JSON.stringify(event.args) ||
      invocation.state === 'settled'
    ) {
      throw new Error('Contradictory tool invocation in journal');
    }
    if (event.type === 'tool_intent') {
      if (invocation.state !== 'not-dispatched') throw new Error('Duplicate tool intent');
      invocation.state = 'unknown';
      continue;
    }
    const statuses: ToolCallResult['status'][] = [
      'executed',
      'approved',
      'blocked',
      'denied',
      'error',
    ];
    if (
      !statuses.includes(event.status as ToolCallResult['status']) ||
      (event.dispatchState !== undefined &&
        !['not-dispatched', 'returned', 'unknown'].includes(String(event.dispatchState))) ||
      (event.reason !== undefined && typeof event.reason !== 'string') ||
      (event.error !== undefined && typeof event.error !== 'string') ||
      ((event.dispatchState === 'returned' || event.dispatchState === 'unknown') &&
        invocation.state !== 'unknown')
    ) {
      throw new Error('Invalid tool outcome in journal');
    }
    invocation.state = 'settled';
    invocation.result = {
      invocationId: invocation.invocationId,
      tool: invocation.tool,
      args: structuredClone(invocation.args),
      status: event.status as ToolCallResult['status'],
      ...(event.dispatchState === undefined
        ? {}
        : { dispatchState: event.dispatchState as ToolCallResult['dispatchState'] }),
      ...(event.result === undefined ? {} : { result: structuredClone(event.result) }),
      ...(event.reason === undefined ? {} : { reason: event.reason as string }),
      ...(event.error === undefined ? {} : { error: event.error as string }),
    };
  }
  return [...attempts.values()];
}

export interface ToolAttemptJournal {
  admit(call: LocalToolCall): void;
  stamp(args: Record<string, unknown>): { invocationId: string; toolOwner: ToolInvocationStamp };
}

/**
 * One session owner, one ordered log. Hosts supply UUID minting and replayed
 * records, and retain the normal session lease; this is not a process lock.
 * Existing attempts can be inspected but NEVER reopened for dispatch. A new
 * actual provider request must get a new attempt ID, including resume/reseed.
 */
export function createToolInvocationJournal(options: {
  sessionId: string;
  log: Log;
  mintInvocationId(): string;
  recoveredEvents?: Iterable<Record<string, unknown>>;
}) {
  const recovered = readToolInvocationJournal(options.recoveredEvents ?? [], options.sessionId);
  const knownAttempts = new Set(recovered.map((a) => key(a.owner)));
  const invocationIds = new Set(recovered.flatMap((a) => a.invocations.map((i) => i.invocationId)));
  let poisoned = false;
  return {
    log: options.log,
    sessionId: options.sessionId,
    recovered,
    /** A failed write is distinct from a pre-write validation/replay refusal. */
    get persistenceUncertain() {
      return poisoned;
    },
    async begin(
      owner: Pick<ToolAttemptOwner, 'turnId' | 'attemptId'>
    ): Promise<ToolAttemptJournal> {
      const fullOwner = readOwner({ ...owner, sessionId: options.sessionId, version: 1 });
      const attemptKey = key(fullOwner);
      if (poisoned) throw new Error('Tool journal persistence is uncertain');
      if (knownAttempts.has(attemptKey))
        throw new Error('Tool attempt already exists; inspect its outcomes, never redispatch it');
      knownAttempts.add(attemptKey); // Reserve before the first await, also after a failed write.
      try {
        options.log.append({ type: 'tool_attempt', toolOwner: { ...fullOwner, version: 1 } });
        await options.log.flush();
      } catch (error) {
        poisoned = true;
        throw error;
      }
      const bindings = new WeakMap<
        Record<string, unknown>,
        { invocationId: string; toolOwner: ToolInvocationStamp }
      >();
      let ordinal = 0;
      return {
        admit(call) {
          if (poisoned || ordinal >= MAX_TOOL_CALLS_PER_ITERATION || bindings.has(call.args))
            throw new Error('Tool admission refused by journal');
          const invocationId = options.mintInvocationId();
          if (!validId(invocationId) || invocationIds.has(invocationId))
            throw new Error('Invalid or reused tool invocation ID');
          invocationIds.add(invocationId);
          const identity = {
            invocationId,
            toolOwner: { ...fullOwner, version: 1 as const, ordinal: ordinal++ },
          };
          bindings.set(call.args, identity);
          try {
            options.log.append({
              type: 'tool_admission',
              ...identity,
              tool: call.tool,
              args: structuredClone(call.args),
            });
          } catch (error) {
            poisoned = true;
            throw error;
          }
        },
        stamp(args) {
          const identity = bindings.get(args);
          if (!identity) throw new Error('Tool call has no admitted invocation identity');
          return structuredClone(identity);
        },
      };
    },
  };
}
