/** Process-local drain state; none of these values is an operator credential. */
export type DeployDrainMode = 'open' | 'draining' | 'sealed' | 'shutdown';

export interface DrainAttempt {
  readonly incarnation: string;
  readonly attempt: number;
}

export interface DrainReceipt extends DrainAttempt {
  readonly revision: number;
}

/** Caller supplies a stable admission ID, not message text or a credential. */
export interface DrainAdmission {
  readonly id: string;
  readonly kind: 'turn' | 'compaction' | 'child-turn';
}

export interface DrainBlocker {
  readonly kind:
    | 'reservation'
    | 'executing-turn'
    | 'unfinalized-turn'
    | 'owned-child'
    | 'state-write'
    | 'effect-write'
    | 'compaction'
    | 'launch-hold'
    | 'coverage-gap'
    | 'unknown';
  readonly id: string;
}

export interface DeployDrainSnapshot {
  readonly incarnation: string;
  readonly attempt: number;
  readonly revision: number;
  readonly mode: DeployDrainMode;
  readonly blockers: readonly DrainBlocker[];
  /** Only as complete as the supplied census. Not permission to restart. */
  readonly ready: boolean;
  readonly receipt?: DrainReceipt;
}

export type DrainCommitResult =
  | { status: 'committed' }
  | {
      status: 'refused';
      reason: 'stale-reservation' | 'admission-closed' | 'registration-refused';
    }
  | {
      status: 'unknown';
      reason:
        | 'registration-threw'
        | 'invalid-registration-result'
        | 'gate-changed'
        | 'previous-unknown';
    };
