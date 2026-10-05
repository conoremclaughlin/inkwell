/** D1's host-independent wire contract. Validation is not execution authority. */
export type JournalJson =
  | null
  | boolean
  | number
  | string
  | JournalJson[]
  | { [key: string]: JournalJson };

export interface JournalIdentity {
  journalId: string;
  sessionId: string;
  writerTenureId: string;
  hostInstanceId: string;
}

/** The observed owner may differ from the writer for negative observations. */
export interface JournalTarget {
  tenureId: string;
  epoch: string;
  commandUuid: string;
  invocationId: string | null;
}

export type SpawnIntentBody = {
  adapter: 'claude-code' | 'codex-cli' | 'ink' | 'gemini' | 'antigravity';
  hostMode: 'server_hosted' | 'interactive_wrapper' | 'native_external';
  /** Inherited attempt reference, or explicitly absent; never minted on retry. */
  attemptId: string | null;
  deadlineAt: string | null;
  execution:
    | { kind: 'known'; hostId: string; bootId: string }
    | { kind: 'unverified'; reasonCode: string };
};

export type SpawnBindingBody =
  | {
      kind: 'process_binding';
      pid: number;
      startIdentity: string;
      containment:
        | { kind: 'unknown' }
        | { kind: 'process_group'; pgid: number; evidenceRef: string }
        | { kind: 'attested_tree'; identity: string; evidenceRef: string };
    }
  | { kind: 'transcript_binding'; providerTranscriptId: string };

export type SpawnObservationBody =
  | {
      kind:
        | 'parent_exited'
        | 'group_empty'
        | 'tree_quiescent'
        | 'not_spawned'
        | 'child_alive'
        | 'contradiction';
      evidenceRef: string;
    }
  | { kind: 'unknown'; reasonCode: string };

/** Ordinary bodies preserve existing replay fields, excluding owned metadata. */
export interface JournalRecord {
  type: string;
  target: JournalTarget | null;
  body: { [key: string]: JournalJson };
}

export interface JournalEntry extends JournalIdentity, JournalRecord {
  version: 1;
  eid: number;
  ts: string;
}

export class JournalRecordError extends Error {
  constructor(readonly code: 'invalid_entry' | 'entry_too_large') {
    super(`Journal record refused: ${code}`);
    this.name = 'JournalRecordError';
  }
}

/**
 * Accept data, never raw transport JSON. The host must reject duplicate keys
 * before parsing raw JSON. No getters, toJSON, lossy undefined/NaN, cycles,
 * sparse arrays, custom prototypes or metadata overrides are normalized away.
 * Sorting object keys gives exact-retry equality without a digest trust gap.
 */
export function canonicalJournalJson(value: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError('Invalid journal byte limit');
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let nodes = 0;
  const invalid = (): never => {
    throw new JournalRecordError('invalid_entry');
  };
  const emit = (chunk: string): void => {
    if (chunk.length > maxBytes - bytes) throw new JournalRecordError('entry_too_large');
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > maxBytes) throw new JournalRecordError('entry_too_large');
    chunks.push(chunk);
  };
  const string = (text: string): void => {
    if (text.length > maxBytes - bytes) throw new JournalRecordError('entry_too_large');
    // PostgreSQL jsonb cannot preserve NUL or an unpaired UTF-16 surrogate.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0 || (c >= 0xdc00 && c <= 0xdfff)) invalid();
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      }
    }
    emit(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) invalid();
    if (item === null) return emit('null');
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return emit(String(item));
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) invalid();
      return emit(String(item));
    }
    if (typeof item !== 'object' || !item || ancestors.has(item)) invalid();
    const object = item as object;
    const array = Array.isArray(object);
    if (
      Object.getPrototypeOf(object) !== (array ? Array.prototype : Object.prototype) &&
      !(Object.getPrototypeOf(object) === null && !array)
    )
      invalid();
    const keys = Reflect.ownKeys(object);
    if (keys.length > 100_000 || keys.some((key) => typeof key !== 'string')) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const key of keys as string[]) {
      const d = descriptors[key];
      if (!('value' in d) || (!d.enumerable && !(array && key === 'length'))) invalid();
    }
    ancestors.add(object);
    if (array) {
      const values = object as unknown[];
      if (keys.length !== values.length + 1) invalid();
      emit('[');
      for (let i = 0; i < values.length; i++) {
        const d = descriptors[String(i)];
        if (!d) invalid();
        if (i) emit(',');
        visit(d.value, depth + 1);
      }
      emit(']');
    } else {
      emit('{');
      (keys as string[]).sort().forEach((key, i) => {
        if (i) emit(',');
        string(key);
        emit(':');
        visit(descriptors[key].value, depth + 1);
      });
      emit('}');
    }
    ancestors.delete(object);
  };
  visit(value, 0);
  return chunks.join('');
}

function fail(): never {
  throw new JournalRecordError('invalid_entry');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function id(value: unknown): void {
  // The existing tenure/invocation projection stores these in <=200 chars.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value)) fail();
}
function reasonCode(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-z0-9_.:-]{1,100}$/.test(value)) fail();
}
function pid(value: unknown): void {
  positive(value);
  if ((value as number) > 2_147_483_647) fail();
}
function uuid(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    fail();
}
function oneOf(value: unknown, values: string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) fail();
}
function positive(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail();
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail();
  const time = Date.parse(value as string);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail();
}

function validateSpawn(type: string, body: Record<string, unknown>): void {
  if (type === 'provider_spawn_intent') {
    keys(body, ['adapter', 'hostMode', 'attemptId', 'deadlineAt', 'execution']);
    oneOf(body.adapter, ['claude-code', 'codex-cli', 'ink', 'gemini', 'antigravity']);
    oneOf(body.hostMode, ['server_hosted', 'interactive_wrapper', 'native_external']);
    if (body.attemptId !== null) id(body.attemptId);
    if (body.deadlineAt !== null) timestamp(body.deadlineAt);
    const execution = object(body.execution);
    if (execution.kind === 'known') {
      keys(execution, ['kind', 'hostId', 'bootId']);
      id(execution.hostId);
      id(execution.bootId);
    } else {
      keys(execution, ['kind', 'reasonCode']);
      oneOf(execution.kind, ['unverified']);
      reasonCode(execution.reasonCode);
    }
  } else if (type === 'provider_spawn_binding') {
    if (body.kind === 'process_binding') {
      keys(body, ['kind', 'pid', 'startIdentity', 'containment']);
      pid(body.pid);
      id(body.startIdentity);
      const containment = object(body.containment);
      if (containment.kind === 'unknown') keys(containment, ['kind']);
      else if (containment.kind === 'process_group') {
        keys(containment, ['kind', 'pgid', 'evidenceRef']);
        pid(containment.pgid);
        id(containment.evidenceRef);
      } else {
        keys(containment, ['kind', 'identity', 'evidenceRef']);
        oneOf(containment.kind, ['attested_tree']);
        id(containment.identity);
        id(containment.evidenceRef);
      }
    } else {
      keys(body, ['kind', 'providerTranscriptId']);
      oneOf(body.kind, ['transcript_binding']);
      id(body.providerTranscriptId);
    }
  } else if (type === 'provider_spawn_observation') {
    if (body.kind === 'unknown') {
      keys(body, ['kind', 'reasonCode']);
      reasonCode(body.reasonCode);
    } else {
      keys(body, ['kind', 'evidenceRef']);
      oneOf(body.kind, [
        'parent_exited',
        'group_empty',
        'tree_quiescent',
        'not_spawned',
        'child_alive',
        'contradiction',
      ]);
      id(body.evidenceRef);
    }
  } else fail();
}

function freezeJson(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

/** Validates a bounded data snapshot, never the caller's later-mutated object. */
export function freezeJournalEntry(
  value: unknown,
  maxBytes: number
): { entry: Readonly<JournalEntry>; json: string; bytes: number } {
  const json = canonicalJournalJson(value, maxBytes);
  const entry = object(JSON.parse(json));
  keys(entry, [
    'version',
    'journalId',
    'sessionId',
    'writerTenureId',
    'hostInstanceId',
    'eid',
    'ts',
    'type',
    'target',
    'body',
  ]);
  if (entry.version !== 1) fail();
  uuid(entry.journalId);
  uuid(entry.sessionId);
  uuid(entry.writerTenureId);
  id(entry.hostInstanceId);
  positive(entry.eid);
  timestamp(entry.ts);
  id(entry.type);
  const body = object(entry.body);
  const spawn = (entry.type as string).startsWith('provider_spawn_');
  if (entry.target !== null) {
    const target = object(entry.target);
    keys(target, ['tenureId', 'epoch', 'commandUuid', 'invocationId']);
    uuid(target.tenureId);
    id(target.epoch);
    uuid(target.commandUuid);
    if (target.invocationId !== null) id(target.invocationId);
    if (spawn && target.invocationId === null) fail();
    const negative =
      entry.type === 'provider_spawn_observation' &&
      ['unknown', 'child_alive', 'contradiction'].includes(body.kind as string);
    if (!negative && target.tenureId !== entry.writerTenureId) fail();
  } else if (spawn) fail();
  if (spawn) validateSpawn(entry.type as string, body);
  // Keep replay's flat envelope safe, even for ordinary runtime events.
  for (const reserved of [
    'eid',
    'ts',
    'type',
    'version',
    'journalId',
    'sessionId',
    'writerTenureId',
    'hostInstanceId',
    'target',
    'body',
  ]) {
    if (Object.hasOwn(body, reserved)) fail();
  }
  freezeJson(entry);
  return {
    entry: entry as unknown as Readonly<JournalEntry>,
    json,
    bytes: new TextEncoder().encode(json).byteLength,
  };
}

/** Existing replay semantics: storage authority metadata is not event payload. */
export function journalReplayEvent(entry: Readonly<JournalEntry>): Record<string, unknown> {
  return { ...entry.body, type: entry.type, ts: entry.ts, eid: entry.eid };
}
