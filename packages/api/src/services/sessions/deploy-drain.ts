import type {
  DeployDrainMode,
  DeployDrainSnapshot,
  DrainAdmission,
  DrainAttempt,
  DrainBlocker,
  DrainCommitResult,
  DrainReceipt,
} from './deploy-drain.types.js';

const blockerKinds = new Set<DrainBlocker['kind']>([
  'reservation',
  'executing-turn',
  'unfinalized-turn',
  'owned-child',
  'state-write',
  'effect-write',
  'compaction',
  'launch-hold',
  'coverage-gap',
  'unknown',
]);

const nonblank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Unwired pre-deploy admission gate, distinct from active-runs' shutdown gate.
 *
 * No singleton, endpoint, timer, child termination, persistence or automatic
 * recovery. A drain does not revoke existing-generation authority or close its
 * state writers. Existing registries remain the execution owners; reservations
 * here only bridge asynchronous preparation to synchronous registration there.
 *
 * The caller must supply a fresh API-process incarnation (not OS boot ID), an
 * authorized operator boundary and a COMPLETE synchronous census. It must report
 * missing coverage as a blocker, including durable input handoff, compaction,
 * children, finalization and unresolved effects. Omitting the census fails closed.
 * No production caller instantiates this gate yet.
 */
export class DeployDrainGate {
  private mode: DeployDrainMode = 'open';
  private attempt = 0;
  private revision = 0;
  private readonly reservations = new Map<DrainAdmission, 'pending' | 'committing' | 'unknown'>();

  constructor(
    private readonly incarnation: string,
    private readonly readBlockers: () => readonly DrainBlocker[] = () => [
      { kind: 'coverage-gap', id: 'census-not-wired' },
    ]
  ) {
    if (!nonblank(incarnation)) throw new TypeError('A process incarnation is required');
  }

  /** Reserve before asynchronous preparation; this grants NO dispatch authority. */
  reserveAdmission(admission: DrainAdmission): DrainAdmission | undefined {
    if (
      this.mode !== 'open' ||
      !nonblank(admission.id) ||
      !['turn', 'compaction', 'child-turn'].includes(admission.kind) ||
      [...this.reservations.keys()].some((entry) => entry.id === admission.id)
    )
      return undefined;
    const reservation = Object.freeze({ id: admission.id, kind: admission.kind });
    this.reservations.set(reservation, 'pending');
    this.revision++;
    return reservation;
  }

  /**
   * Transfer into the canonical registry with no await between gate and register.
   * `register` must be synchronous, registration-only (no executor/effect launch).
   * False or a closed gate keeps the reservation until preparation is cleaned up.
   * An exception/reentrant mutation is UNKNOWN, not permission for a second try.
   */
  commitAdmission(reservation: DrainAdmission, register: () => boolean): DrainCommitResult {
    const state = this.reservations.get(reservation);
    if (!state) return { status: 'refused', reason: 'stale-reservation' };
    if (state !== 'pending') return { status: 'unknown', reason: 'previous-unknown' };
    if (this.mode !== 'open') return { status: 'refused', reason: 'admission-closed' };
    this.reservations.set(reservation, 'committing');
    const revision = ++this.revision;
    let result: boolean;
    try {
      result = register();
    } catch {
      this.reservations.set(reservation, 'unknown');
      this.revision++;
      return { status: 'unknown', reason: 'registration-threw' };
    }
    if (this.revision !== revision || this.mode !== 'open') {
      this.reservations.set(reservation, 'unknown');
      this.revision++;
      return { status: 'unknown', reason: 'gate-changed' };
    }
    if (result !== true && result !== false) {
      this.reservations.set(reservation, 'unknown');
      this.revision++;
      return { status: 'unknown', reason: 'invalid-registration-result' };
    }
    if (result) this.reservations.delete(reservation);
    else this.reservations.set(reservation, 'pending');
    this.revision++;
    return result ? { status: 'committed' } : { status: 'refused', reason: 'registration-refused' };
  }

  /** Only after preparation cleanup. Cannot erase an uncertain registration. */
  releaseReservation(reservation: DrainAdmission): boolean {
    if (this.reservations.get(reservation) !== 'pending') return false;
    this.reservations.delete(reservation);
    this.revision++;
    return true;
  }

  /** Repeated start on the same attempt is idempotent; shutdown is irreversible. */
  beginDrain(): DrainAttempt | undefined {
    if (this.mode === 'shutdown') return undefined;
    if (this.mode === 'open') {
      this.mode = 'draining';
      this.attempt++;
      this.revision++;
    }
    return { incarnation: this.incarnation, attempt: this.attempt };
  }

  cancelDrain(expected: DrainAttempt): boolean {
    if (this.mode !== 'draining' || !this.matchesAttempt(expected)) return false;
    this.mode = 'open';
    this.revision++;
    return true;
  }

  snapshot(): DeployDrainSnapshot {
    const blockers = this.collectBlockers();
    const ready = (this.mode === 'draining' || this.mode === 'sealed') && blockers.length === 0;
    return {
      incarnation: this.incarnation,
      attempt: this.attempt,
      revision: this.revision,
      mode: this.mode,
      blockers,
      ready,
      ...(ready ? { receipt: this.receipt() } : {}),
    };
  }

  /**
   * Revalidate the ready observation and close the cancel/reopen window. Does not
   * restart anything. The operator must check the returned receipt again just
   * before its separately authorized restart; external blockers can still arise.
   */
  sealDrain(expected: DrainReceipt): DrainReceipt | undefined {
    if (this.mode !== 'draining' || !this.matchesReceipt(expected)) return undefined;
    if (this.collectBlockers().length !== 0 || !this.matchesReceipt(expected)) return undefined;
    this.mode = 'sealed';
    this.revision++;
    return this.receipt();
  }

  isRestartReady(expected: DrainReceipt): boolean {
    return (
      this.mode === 'sealed' &&
      this.matchesReceipt(expected) &&
      this.collectBlockers().length === 0 &&
      this.mode === 'sealed' &&
      this.matchesReceipt(expected)
    );
  }

  /** Actual shutdown is a separate, terminal state, never a graceful timeout. */
  closeForShutdown(): void {
    if (this.mode === 'shutdown') return;
    this.mode = 'shutdown';
    this.revision++;
  }

  private matchesAttempt(expected: DrainAttempt): boolean {
    return expected.incarnation === this.incarnation && expected.attempt === this.attempt;
  }

  private matchesReceipt(expected: DrainReceipt): boolean {
    return this.matchesAttempt(expected) && expected.revision === this.revision;
  }

  private receipt(): DrainReceipt {
    return { incarnation: this.incarnation, attempt: this.attempt, revision: this.revision };
  }

  private collectBlockers(): DrainBlocker[] {
    const blockers: DrainBlocker[] = [...this.reservations].map(([entry, state]) => ({
      kind: state === 'unknown' ? 'unknown' : 'reservation',
      id: entry.id,
    }));
    const revision = this.revision;
    try {
      const external = this.readBlockers();
      if (
        !Array.isArray(external) ||
        external.some((entry) => !entry || !blockerKinds.has(entry.kind) || !nonblank(entry.id))
      )
        throw new TypeError('Invalid drain census');
      blockers.push(...external.map(({ kind, id }) => ({ kind, id })));
    } catch {
      // Do not echo error text; the census may have failed with private data.
      blockers.push({ kind: 'unknown', id: 'census-unavailable' });
    }
    if (revision !== this.revision) blockers.push({ kind: 'unknown', id: 'census-mutated-gate' });
    return blockers;
  }
}
