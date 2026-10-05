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
 * Unknown means refused. A missing port, a stopped journal, a projection other
 * than `recorded`, a barrier that is not `clear`, or a previous spawn in the
 * same turn without proof that nothing of it still runs: each refuses before
 * a process starts. A spawn that did start and could not be bound stays
 * unresolved; it is never reported as `not_spawned`.
 *
 * DARK. No production caller yet. The journal types below are structural
 * copies of the contract in packages/shared/src/runtime/journal-record.ts and
 * journal-writer.ts on #701, to be replaced by imports once that lands.
 */

import { randomUUID } from 'crypto';

// --- Journal contract (structural, type-only) -------------------------------

export interface RunJournalTarget {
  tenureId: string;
  epoch: string;
  commandUuid: string;
  invocationId: string | null;
}

export interface RunJournalRecord {
  type: string;
  target: RunJournalTarget | null;
  body: Record<string, unknown>;
}

export type RunJournalProjection =
  | 'none'
  | 'recorded'
  | 'already_recorded'
  | 'contradiction'
  | 'needs_reconciler';

export interface RunJournalReceipt {
  outcome: 'committed' | 'already_committed';
  projection: RunJournalProjection;
  entry: { eid: number; type: string };
  committedEid: number;
}

/** The part of `JournalWriter` the runner path uses. */
export interface RunJournal {
  append(record: RunJournalRecord): Promise<RunJournalReceipt>;
  /** Set once the writer has stopped; it never writes again after that. */
  readonly failure: { code: string } | undefined;
}

export type SpawnAdapter = 'claude-code' | 'codex-cli' | 'ink' | 'gemini' | 'antigravity';
export type SpawnHostMode = 'server_hosted' | 'interactive_wrapper' | 'native_external';
export type SpawnExecution =
  | { kind: 'known'; hostId: string; bootId: string }
  | { kind: 'unverified'; reasonCode: string };

export type SpawnContainment =
  | { kind: 'unknown' }
  | { kind: 'process_group'; pgid: number; evidenceRef: string }
  | { kind: 'attested_tree'; identity: string; evidenceRef: string };

export type SpawnObservation =
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

/**
 * The observations that prove nothing of a spawn still runs. `parent_exited`
 * and `group_empty` are recorded as what they are and never count: an escaped
 * descendant survives both.
 */
const SETTLED_OBSERVATIONS = new Set(['tree_quiescent', 'not_spawned']);

// --- Authority ports ---------------------------------------------------------

export type RunKind = 'turn' | 'compaction';

export interface RunRequest {
  sessionId: string;
  /** The command's canonical id. A retry keeps it; it is never re-minted to dodge uncertainty. */
  commandUuid: string;
  kind: RunKind;
}

export interface AdmittedTurn {
  sessionId: string;
  tenureId: string;
  epoch: string;
  commandUuid: string;
  kind: RunKind;
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
 * No production implementation yet (Lumen, pr:701 1c87651b).
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
}

function refusal(reason: RunRefusalReason, detail?: string): RunRefusal {
  return detail === undefined
    ? { outcome: 'refused', reason }
    : { outcome: 'refused', reason, detail };
}

function barrierRefusal(recovery: RecoveryBarrier, sessionId: string): RunRefusal | null {
  const state = recovery.state(sessionId);
  if (state === 'clear') return null;
  return refusal(state === 'held' ? 'recovery_held' : 'recovery_unverified');
}

// --- The per-spawn gate ------------------------------------------------------

export interface SpawnAttempt {
  adapter: SpawnAdapter;
  hostMode: SpawnHostMode;
  /** The command's attempt identity, inherited by every spawn of the attempt; null when there is none. */
  attemptId: string | null;
  deadlineAt: string | null;
  execution: SpawnExecution;
}

/** Permission for exactly one physical spawn, valid until used or invalidated. */
export interface InvocationPermit {
  readonly invocationId: string;
}

interface InvocationState {
  permit: InvocationPermit;
  spawned: boolean;
  used: boolean;
  /** The latest observation recorded for this spawn, if any. */
  observed: SpawnObservation['kind'] | null;
}

export type BindOutcome = 'bound' | 'unresolved';

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

  private target(invocationId: string): RunJournalTarget {
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

  /** Spawns that started without a settled observation: an obligation the next turn sees. */
  get unresolvedInvocations(): number {
    return this.invocations.filter(
      (state) => state.spawned && !(state.observed && SETTLED_OBSERVATIONS.has(state.observed))
    ).length;
  }

  /**
   * Everything a spawn needs before its process may start: the barrier, the
   * journal, proof that no earlier spawn of this turn still runs, a committed
   * intent, and the dispatch authority's yes. Resolves to a permit, or to a
   * refusal with nothing spawned.
   */
  async prepare(attempt: SpawnAttempt): Promise<InvocationPermit | RunRefusal> {
    if (this.signal?.aborted) return refusal('aborted');
    const held = barrierRefusal(this.ports.recovery, this.turn.sessionId);
    if (held) return held;
    if (this.ports.journal.failure)
      return refusal('journal_failed', this.ports.journal.failure.code);

    // A runner's own retry (Claude's fresh-session fallback, an Ink attempt
    // loop iteration) is another physical spawn of the same turn. It runs only
    // once the earlier spawn is proved quiescent or never started; a failure
    // string from the first attempt is not that proof.
    // The same holds for an intent that committed without a spawn (dispatch
    // refused, or the run stopped at the last check) and for a permit still
    // outstanding: one spawn at a time, and none after an unproved one.
    if (this.unresolvedInvocations > 0) return refusal('prior_invocation_unresolved');
    if (this.invocations.some((state) => !state.spawned)) {
      return refusal('prior_invocation_unresolved');
    }

    const invocationId = this.mint();
    let receipt: RunJournalReceipt;
    try {
      receipt = await this.ports.journal.append({
        type: 'provider_spawn_intent',
        target: this.target(invocationId),
        body: {
          adapter: attempt.adapter,
          hostMode: attempt.hostMode,
          attemptId: attempt.attemptId,
          deadlineAt: attempt.deadlineAt,
          execution: attempt.execution,
        },
      });
    } catch {
      return refusal('journal_refused');
    }
    // A fresh invocation id must project as a new obligation. `already_recorded`
    // for an id minted a moment ago means the store and this process disagree.
    if (receipt.outcome !== 'committed' || receipt.projection !== 'recorded') {
      return refusal('projection_not_recorded', receipt.projection);
    }

    // The intent is committed whatever happens next, so the obligation is
    // tracked from here, before dispatch is asked: a refused or failed
    // authorization leaves a committed intent that no later spawn may pass.
    const state: InvocationState = {
      permit: Object.freeze({ invocationId }),
      spawned: false,
      used: false,
      observed: null,
    };
    this.invocations.push(state);

    let decision: DispatchDecision;
    try {
      decision = await this.ports.dispatch.authorize(this.turn, invocationId);
    } catch {
      state.used = true;
      return refusal('dispatch_refused');
    }
    if (decision.outcome !== 'dispatch') {
      state.used = true;
      return refusal('dispatch_refused', decision.reason);
    }
    return state.permit;
  }

  /**
   * The last check, synchronous, immediately before `spawn()`: a runner calls
   * it after its last await and spawns only on `undefined`. One permit, one
   * spawn. Returns the refusal reason otherwise.
   */
  admitSpawn(permit: InvocationPermit): RunRefusalReason | undefined {
    const state = this.find(permit);
    if (!state) return 'permit_stale';
    if (state.used) return 'permit_used';
    state.used = true;
    if (this.signal?.aborted) return 'aborted';
    const held = barrierRefusal(this.ports.recovery, this.turn.sessionId);
    if (held) return held.reason;
    if (this.ports.journal.failure) return 'journal_failed';
    state.spawned = true;
    return undefined;
  }

  /**
   * Records the started process's identity. A failure here leaves the spawn
   * unresolved: the child may be alive, so it is never reported as not
   * spawned and never retried.
   */
  async bind(
    permit: InvocationPermit,
    binding: { pid: number; startIdentity: string; containment: SpawnContainment }
  ): Promise<BindOutcome> {
    const state = this.find(permit);
    if (!state?.spawned) return 'unresolved';
    try {
      const receipt = await this.ports.journal.append({
        type: 'provider_spawn_binding',
        target: this.target(permit.invocationId),
        body: {
          kind: 'process_binding',
          pid: binding.pid,
          startIdentity: binding.startIdentity,
          containment: binding.containment,
        },
      });
      return receipt.projection === 'recorded' || receipt.projection === 'already_recorded'
        ? 'bound'
        : 'unresolved';
    } catch {
      return 'unresolved';
    }
  }

  /**
   * Records what was observed about the spawn. Only an observation that
   * committed and projected cleanly is remembered; anything else leaves the
   * spawn unresolved.
   */
  async observe(permit: InvocationPermit, observation: SpawnObservation): Promise<void> {
    const state = this.find(permit);
    if (!state) return;
    try {
      const receipt = await this.ports.journal.append({
        type: 'provider_spawn_observation',
        target: this.target(permit.invocationId),
        body: { ...observation },
      });
      if (receipt.projection === 'recorded' || receipt.projection === 'already_recorded') {
        state.observed = observation.kind;
      }
    } catch {
      // Unrecorded: the spawn stays unresolved.
    }
  }
}

// --- The outer facade --------------------------------------------------------

export type AdmittedRunOutcome<T> =
  | {
      outcome: 'ran';
      result: T;
      /** Started spawns without a settled observation. Non-zero holds the session's next command. */
      unresolvedInvocations: number;
    }
  | RunRefusal;

/**
 * One command's run under D1. Both runner seams use it (S1, a turn;
 * S2, a compaction). `execute` receives the gate and must take every physical
 * spawn through it; it is not called at all when the run is refused.
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
  if (options.signal?.aborted) return refusal('aborted');
  const held = barrierRefusal(ports.recovery, request.sessionId);
  if (held) return held;
  if (ports.journal.failure) return refusal('journal_failed', ports.journal.failure.code);

  let admission: TurnAdmission;
  try {
    admission = await ports.turns.admit(request);
  } catch {
    return refusal('turn_refused', 'admission_failed');
  }
  if (admission.outcome !== 'admitted') return refusal('turn_refused', admission.reason);
  if (admission.sessionId !== request.sessionId || admission.commandUuid !== request.commandUuid) {
    return refusal('turn_refused', 'admission_mismatch');
  }

  const turn: AdmittedTurn = {
    sessionId: admission.sessionId,
    tenureId: admission.tenureId,
    epoch: admission.epoch,
    commandUuid: admission.commandUuid,
    kind: request.kind,
  };
  const gate = new InvocationGate(ports, turn, options.signal);
  const result = await execute(gate);
  return { outcome: 'ran', result, unresolvedInvocations: gate.unresolvedInvocations };
}
