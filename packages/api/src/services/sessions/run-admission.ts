/**
 * D1 runner adoption: the server side of ink://specs/live-agent-surfaces v40,
 * "Deployment recovery and early runner adoption".
 *
 * Every backend run the server starts goes through two layers:
 *
 *   1. `admittedRun`, once per command (a turn, or a compaction): the startup
 *      recovery barrier, the journal's health, and the outer turn admission
 *      (`admitLeasedTurn` / `admitTurn` behind the `TurnAuthority` port).
 *   2. `InvocationGate`, once per PHYSICAL spawn, including a runner's own
 *      retries (ClaudeRunner's fresh-session fallback, InkRunner's attempt
 *      loop). Each spawn commits its intent to the journal and is re-authorized
 *      before the process starts, and the final check is synchronous so no
 *      await sits between it and `spawn()`.
 *
 * Spawn records go ONLY through the journal. Its store projects them into the
 * invocation index in the same transaction (journal-writer.ts: "No separate
 * projection call is allowed"), so nothing here calls `record_invocation`.
 * A journal receipt is evidence that a record committed, never permission to
 * spawn; permission comes from `DispatchAuthority`, per spawn.
 *
 * Unknown means refused, and an obligation once made is never forgotten. A
 * missing port, a stopped journal, a projection other than `recorded`, a
 * barrier that is not `clear`, or any earlier obligation of the turn not
 * proved settled: each refuses before a process starts. An intent whose append
 * threw may have committed, so it stays an obligation; a spawn that started and
 * could not be bound stays unresolved; neither is ever reported `not_spawned`.
 *
 * DARK. No production caller yet.
 */

import { randomUUID } from 'crypto';
import type {
  JournalCommitReceipt,
  JournalRecord,
  JournalTarget,
  JournalWriter,
  SpawnBindingBody,
  SpawnIntentBody,
  SpawnObservationBody,
} from '@inklabs/shared/runtime';

/** The part of `JournalWriter` the runner path uses. */
export interface RunJournal {
  append(record: JournalRecord): Promise<JournalCommitReceipt>;
  /** Set once the writer has stopped; it never writes again after that. */
  readonly failure: JournalWriter['failure'];
}

/** A physical spawn's intent: exactly the journal's intent body. */
export type SpawnAttempt = SpawnIntentBody;
export type SpawnProcessBinding = Omit<
  Extract<SpawnBindingBody, { kind: 'process_binding' }>,
  'kind'
>;
export type SpawnObservation = SpawnObservationBody;

/**
 * The observations that prove nothing of a spawn still runs. `parent_exited`
 * and `group_empty` are recorded as what they are and never count: an escaped
 * descendant survives both.
 */
const SETTLED_OBSERVATIONS: ReadonlySet<string> = new Set(['tree_quiescent', 'not_spawned']);
/** Observations that reopen any earlier settlement, permanently. */
const NEGATIVE_OBSERVATIONS: ReadonlySet<string> = new Set([
  'child_alive',
  'contradiction',
  'unknown',
]);

// --- Authority ports ---------------------------------------------------------

export type RunKind = 'turn' | 'compaction';

export interface RunRequest {
  sessionId: string;
  /** The command's canonical id. A retry keeps it; it is never re-minted to dodge uncertainty. */
  commandUuid: string;
  kind: RunKind;
}

export interface AdmittedTurn {
  readonly sessionId: string;
  readonly tenureId: string;
  readonly epoch: string;
  readonly commandUuid: string;
  readonly kind: RunKind;
}

export type TurnAdmission =
  | ({ outcome: 'admitted' } & AdmittedTurn)
  | { outcome: 'refused'; reason: string };

/** The outer seam: `admitLeasedTurn` / `admitTurn` for the session's holder. */
export interface TurnAuthority {
  admit(request: RunRequest): Promise<TurnAdmission>;
}

export type DispatchDecision = { outcome: 'dispatch' } | { outcome: 'refused'; reason: string };

/**
 * Per physical spawn, under the same authority as the outer admission: this
 * is still the current owner, turn and command; the invocation has an
 * unresolved committed intent; and it has not been dispatched before. Only an
 * explicit `dispatch` permits; a refusal, an error or anything unknown never
 * does, and nothing here reads authority from a journal commit receipt.
 *
 * The gate's own same-turn retry check covers only the spawn obligations it
 * holds. Tree quiescence alone does not clear unresolved external effects, so
 * the authority must refuse a retry while any of the command's effects are
 * unresolved. The runner's existing final synchronous owner and cancel checks
 * (main's `admitSpawn` fence) stay composed with this one-shot gate, never
 * replaced by it. No production implementation yet (Lumen, pr:701 1c87651b).
 */
export interface DispatchAuthority {
  authorize(turn: AdmittedTurn, invocationId: string): Promise<DispatchDecision>;
}

/**
 * Startup recovery. After a restart every hosted lineage starts `unverified`
 * until the executor has re-asserted or disproved its children; only `clear`
 * admits work.
 */
export interface RecoveryBarrier {
  state(sessionId: string): 'clear' | 'held' | 'unverified';
}

export interface RunAdmissionPorts {
  journal: RunJournal;
  turns: TurnAuthority;
  dispatch: DispatchAuthority;
  recovery: RecoveryBarrier;
  /** Mints one id per physical spawn. Injectable for tests. */
  mintInvocationId?: () => string;
}

// --- Refusals ----------------------------------------------------------------

export type RunRefusalReason =
  | 'ports_missing'
  | 'recovery_held'
  | 'recovery_unverified'
  | 'journal_failed'
  | 'journal_refused'
  | 'projection_not_recorded'
  | 'turn_refused'
  | 'dispatch_refused'
  | 'prior_invocation_unresolved'
  | 'permit_used'
  | 'permit_stale'
  | 'aborted';

export interface RunRefusal {
  outcome: 'refused';
  reason: RunRefusalReason;
  /** The authority's own reason, when it refused. */
  detail?: string;
  /**
   * Set when the refusal came after the turn was admitted: the host owns that
   * turn and must take it through its canonical finish or hold path.
   */
  admittedTurn?: AdmittedTurn;
}

function refusal(reason: RunRefusalReason, detail?: string): RunRefusal {
  return detail === undefined
    ? { outcome: 'refused', reason }
    : { outcome: 'refused', reason, detail };
}

/** The run-level conditions, checked again after every await. */
function standingRefusal(
  ports: RunAdmissionPorts,
  sessionId: string,
  signal: AbortSignal | undefined
): RunRefusal | null {
  if (signal?.aborted) return refusal('aborted');
  const state = ports.recovery.state(sessionId);
  if (state !== 'clear') return refusal(state === 'held' ? 'recovery_held' : 'recovery_unverified');
  const failure = ports.journal.failure;
  if (failure) return refusal('journal_failed', failure.code);
  return null;
}

// --- The per-spawn gate ------------------------------------------------------

/** Permission for exactly one physical spawn, valid until used or invalidated. */
export interface InvocationPermit {
  readonly invocationId: string;
}

type InvocationPhase =
  /** Preparation holds the slot; nothing else may prepare until it ends. */
  | 'reserved'
  /** The intent append threw: it may have committed. */
  | 'intent_ambiguous'
  /** The intent committed, and no spawn followed: dispatch refused or failed, or the run stopped. */
  | 'undispatched'
  | 'permitted'
  | 'spawned';

interface InvocationState {
  readonly invocationId: string;
  permit: InvocationPermit | null;
  phase: InvocationPhase;
  /** A committed `tree_quiescent` or `not_spawned`, from the frozen submitted record. */
  settled: boolean;
  /** A committed negative observation, a held projection or a failed observation write. Sticky. */
  reopened: boolean;
}

export type BindOutcome = 'bound' | 'unresolved';

function echoes(receipt: JournalCommitReceipt, type: string, invocationId: string): boolean {
  return receipt.entry.type === type && receipt.entry.target?.invocationId === invocationId;
}

export class InvocationGate {
  private readonly invocations: InvocationState[] = [];
  private readonly mint: () => string;

  constructor(
    private readonly ports: RunAdmissionPorts,
    readonly turn: AdmittedTurn,
    private readonly signal?: AbortSignal
  ) {
    this.mint = ports.mintInvocationId ?? randomUUID;
  }

  private target(invocationId: string): JournalTarget {
    return {
      tenureId: this.turn.tenureId,
      epoch: this.turn.epoch,
      commandUuid: this.turn.commandUuid,
      invocationId,
    };
  }

  private find(permit: InvocationPermit): InvocationState | undefined {
    return this.invocations.find((state) => state.permit === permit);
  }

  /**
   * Obligations of this turn not proved settled: reserved, ambiguous,
   * undispatched, permitted, or spawned without a settled observation, plus
   * any reopened since. A REPORT for the host, never release or finish
   * authority: zero does not end the turn; the canonical finish path does.
   */
  get unresolvedInvocations(): number {
    return this.invocations.filter((state) => !state.settled || state.reopened).length;
  }

  /** Any OTHER obligation of the turn not proved settled, rechecked after every await. */
  private othersUnresolved(except: InvocationState): boolean {
    return this.invocations.some((state) => state !== except && (!state.settled || state.reopened));
  }

  /**
   * Everything a spawn needs before its process may start: the run-level
   * conditions, no unsettled obligation earlier in the turn, a committed
   * intent, and the dispatch authority's yes. Resolves to a permit, or to a
   * refusal with nothing spawned.
   */
  async prepare(attempt: SpawnAttempt): Promise<InvocationPermit | RunRefusal> {
    const standing = standingRefusal(this.ports, this.turn.sessionId, this.signal);
    if (standing) return standing;
    // A runner's own retry (Claude's fresh-session fallback, an Ink attempt
    // loop iteration) is another physical spawn of the same turn. It runs only
    // once every earlier obligation is proved settled; a failure string from
    // the first attempt is not that proof. A preparation in progress counts.
    if (this.unresolvedInvocations > 0) return refusal('prior_invocation_unresolved');

    // Reserve synchronously, before the first await, so a concurrent prepare
    // sees this one and refuses.
    const invocationId = this.mint();
    const state: InvocationState = {
      invocationId,
      permit: null,
      phase: 'reserved',
      settled: false,
      reopened: false,
    };
    this.invocations.push(state);

    const intent: SpawnIntentBody = {
      adapter: attempt.adapter,
      hostMode: attempt.hostMode,
      attemptId: attempt.attemptId,
      deadlineAt: attempt.deadlineAt,
      execution:
        attempt.execution.kind === 'known'
          ? { kind: 'known', hostId: attempt.execution.hostId, bootId: attempt.execution.bootId }
          : { kind: 'unverified', reasonCode: attempt.execution.reasonCode },
    };
    let receipt: JournalCommitReceipt;
    try {
      receipt = await this.ports.journal.append({
        type: 'provider_spawn_intent',
        target: this.target(invocationId),
        body: intent,
      });
    } catch {
      state.phase = 'intent_ambiguous';
      return refusal('journal_refused');
    }
    state.phase = 'undispatched';
    // A fresh invocation id must project as a new obligation. `already_recorded`
    // for an id minted a moment ago means the store and this process disagree.
    if (
      receipt.outcome !== 'committed' ||
      receipt.projection !== 'recorded' ||
      !echoes(receipt, 'provider_spawn_intent', invocationId)
    ) {
      return refusal('projection_not_recorded', receipt.projection);
    }
    const afterIntent = standingRefusal(this.ports, this.turn.sessionId, this.signal);
    if (afterIntent) return afterIntent;
    // An earlier spawn may have been reopened while this intent was appended.
    if (this.othersUnresolved(state)) return refusal('prior_invocation_unresolved');

    let decision: DispatchDecision;
    try {
      decision = await this.ports.dispatch.authorize(this.turn, invocationId);
    } catch {
      return refusal('dispatch_refused');
    }
    if (decision.outcome !== 'dispatch') return refusal('dispatch_refused', decision.reason);
    if (this.othersUnresolved(state)) return refusal('prior_invocation_unresolved');

    state.permit = Object.freeze({ invocationId });
    state.phase = 'permitted';
    return state.permit;
  }

  /**
   * The last check, synchronous, immediately before `spawn()`: a runner calls
   * it after its last await and spawns only on `undefined`. One permit, one
   * spawn. It also refuses, and spends the permit, when any other obligation
   * of the turn is unresolved now, such as an earlier spawn reopened after
   * this permit was issued. Returns the refusal reason otherwise.
   */
  admitSpawn(permit: InvocationPermit): RunRefusalReason | undefined {
    const state = this.find(permit);
    if (!state) return 'permit_stale';
    if (state.phase !== 'permitted') return 'permit_used';
    const standing = standingRefusal(this.ports, this.turn.sessionId, this.signal);
    if (standing) {
      state.phase = 'undispatched';
      return standing.reason;
    }
    if (this.othersUnresolved(state)) {
      state.phase = 'undispatched';
      return 'prior_invocation_unresolved';
    }
    state.phase = 'spawned';
    return undefined;
  }

  /**
   * Records the started process's identity. A failure here leaves the spawn
   * unresolved: the child may be alive, so it is never reported as not
   * spawned and never retried.
   */
  async bind(permit: InvocationPermit, binding: SpawnProcessBinding): Promise<BindOutcome> {
    const state = this.find(permit);
    if (state?.phase !== 'spawned') return 'unresolved';
    const body: SpawnBindingBody = {
      kind: 'process_binding',
      pid: binding.pid,
      startIdentity: binding.startIdentity,
      containment: { ...binding.containment },
    };
    try {
      const receipt = await this.ports.journal.append({
        type: 'provider_spawn_binding',
        target: this.target(state.invocationId),
        body,
      });
      if (!echoes(receipt, 'provider_spawn_binding', state.invocationId)) return 'unresolved';
      if (receipt.projection === 'contradiction' || receipt.projection === 'needs_reconciler') {
        state.reopened = true;
        return 'unresolved';
      }
      return receipt.projection === 'recorded' || receipt.projection === 'already_recorded'
        ? 'bound'
        : 'unresolved';
    } catch {
      return 'unresolved';
    }
  }

  /**
   * Records what was observed about the spawn. Local state follows only the
   * frozen record submitted here, confirmed by the committed echo; never the
   * caller's object after the await. A failed or held write, or any negative
   * observation, leaves the spawn unresolved for good. A negative is known
   * the moment it is observed, so it reopens the spawn before the append is
   * even awaited: the conservative local hold, not a claim that it is durable.
   */
  async observe(permit: InvocationPermit, observation: SpawnObservation): Promise<void> {
    const state = this.find(permit);
    if (state?.phase !== 'spawned') return;
    const submitted: SpawnObservationBody = Object.freeze(
      observation.kind === 'unknown'
        ? { kind: 'unknown', reasonCode: observation.reasonCode }
        : { kind: observation.kind, evidenceRef: observation.evidenceRef }
    );
    if (NEGATIVE_OBSERVATIONS.has(submitted.kind)) state.reopened = true;
    let receipt: JournalCommitReceipt;
    try {
      receipt = await this.ports.journal.append({
        type: 'provider_spawn_observation',
        target: this.target(state.invocationId),
        body: { ...submitted },
      });
    } catch {
      state.reopened = true;
      return;
    }
    const committedKind = receipt.entry.body.kind;
    if (
      !echoes(receipt, 'provider_spawn_observation', state.invocationId) ||
      committedKind !== submitted.kind ||
      (receipt.projection !== 'recorded' && receipt.projection !== 'already_recorded')
    ) {
      state.reopened = true;
      return;
    }
    // A negative already reopened the spawn before the await.
    if (SETTLED_OBSERVATIONS.has(submitted.kind)) state.settled = true;
  }
}

// --- The outer facade --------------------------------------------------------

export type AdmittedRunOutcome<T> =
  | {
      outcome: 'ran';
      result: T;
      turn: AdmittedTurn;
      /**
       * Obligations not proved settled. A report: non-zero holds the session's
       * next command, and zero is not release or finish authority.
       */
      unresolvedInvocations: number;
    }
  | {
      /**
       * `execute` threw after the turn was admitted. It may already have
       * spawned or produced effects, so this is never a pre-dispatch refusal:
       * the host takes `admittedTurn` through its canonical hold or finish path.
       */
      outcome: 'failed';
      error: unknown;
      admittedTurn: AdmittedTurn;
      unresolvedInvocations: number;
    }
  | RunRefusal;

/**
 * One command's run under D1. Both runner seams use it (S1, a turn;
 * S2, a compaction). `execute` receives the gate and must take every physical
 * spawn through it; it is not called at all when the run is refused. Every
 * outcome after admission carries the admitted turn.
 */
export async function admittedRun<T>(
  ports: RunAdmissionPorts | undefined,
  request: RunRequest,
  execute: (gate: InvocationGate) => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<AdmittedRunOutcome<T>> {
  if (!ports?.journal || !ports.turns || !ports.dispatch || !ports.recovery) {
    return refusal('ports_missing');
  }
  // Read the caller's request once; nothing below looks at the original again.
  const asked: RunRequest = Object.freeze({
    sessionId: request.sessionId,
    commandUuid: request.commandUuid,
    kind: request.kind,
  });
  const before = standingRefusal(ports, asked.sessionId, options.signal);
  if (before) return before;

  let admission: TurnAdmission;
  try {
    admission = await ports.turns.admit({ ...asked });
  } catch {
    return refusal('turn_refused', 'admission_failed');
  }
  if (admission.outcome !== 'admitted') return refusal('turn_refused', admission.reason);
  if (
    admission.sessionId !== asked.sessionId ||
    admission.commandUuid !== asked.commandUuid ||
    admission.kind !== asked.kind ||
    typeof admission.tenureId !== 'string' ||
    !admission.tenureId ||
    typeof admission.epoch !== 'string' ||
    !admission.epoch
  ) {
    return refusal('turn_refused', 'admission_mismatch');
  }

  const turn: AdmittedTurn = Object.freeze({
    sessionId: admission.sessionId,
    tenureId: admission.tenureId,
    epoch: admission.epoch,
    commandUuid: admission.commandUuid,
    kind: admission.kind,
  });
  const after = standingRefusal(ports, asked.sessionId, options.signal);
  if (after) return { ...after, admittedTurn: turn };

  const gate = new InvocationGate(ports, turn, options.signal);
  let result: T;
  try {
    // Inside the try, so a synchronous throw is caught as well as a rejection.
    result = await execute(gate);
  } catch (error) {
    return {
      outcome: 'failed',
      error,
      admittedTurn: turn,
      unresolvedInvocations: gate.unresolvedInvocations,
    };
  }
  return { outcome: 'ran', result, turn, unresolvedInvocations: gate.unresolvedInvocations };
}
