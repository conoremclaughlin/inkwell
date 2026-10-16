/** Server-owned identities, not caller-supplied authorization or native proof. */
export interface InboxNativeBinding {
  readonly userId: string;
  readonly sbId: string;
  readonly sessionId: string;
  /** Captured native key; never inferred from a replacement session row. */
  readonly backend: 'claude-code';
  readonly nativeSessionId: string;
}

export interface InboxNativeClaimRef {
  readonly claimId: string;
  readonly claimRevision: number;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly threadId: string;
}

/** Immutable claim batch captured before native intake, not today's turn epoch. */
export interface InboxNativeExpectedBatch {
  readonly binding: InboxNativeBinding;
  readonly obligationId: string;
  readonly originatingTurnEpoch: string;
  readonly claims: readonly InboxNativeClaimRef[];
}

export type InboxNativeOutcome = 'consumed' | 'definitely-not-written' | 'confirmed-removed';

/** Projection of the native owner's recovery port. No prompt or transcript path. */
export type InboxNativeObservation =
  | { readonly kind: 'unavailable' | 'empty' }
  | (InboxNativeExpectedBatch & {
      readonly kind: 'obligation';
      readonly schemaVersion: 1;
      readonly revision: number;
    } & (
        | { readonly state: 'pending' | 'reconciling' | 'unknown' }
        | {
            readonly state: 'resolved-awaiting-ack';
            readonly outcome: InboxNativeOutcome;
            readonly evidenceDigest: string;
          }
      ));

/**
 * A conditional, whole-batch write plan ONLY. A repository must persist the
 * exact claim revisions and outcome atomically/idempotently before separately
 * acknowledging the captured backend/nativeSessionId + native obligation ID +
 * revision + outcome + evidence digest and original ordered claim batch. Reads
 * must use that native key even when the record is absent. A planned fallback is not
 * permission to dispatch; unresolved native recovery still gates later launch.
 */
export interface InboxNativeSettlementPlan extends InboxNativeExpectedBatch {
  readonly nativeRevision: number;
  readonly outcome: InboxNativeOutcome;
  /** Native resolution identity to persist with the receipt, not proof by itself. */
  readonly evidenceDigest: string;
  readonly disposition: 'mark-consumed' | 'make-queue-eligible';
  readonly next: 'persist-source-settlement';
}

export type InboxNativeSettlementDecision =
  | { readonly status: 'planned'; readonly plan: InboxNativeSettlementPlan }
  | {
      readonly status: 'held';
      readonly reason:
        | 'invalid-input'
        | 'native-unavailable'
        | 'native-missing'
        | 'native-unresolved'
        | 'binding-mismatch'
        | 'obligation-mismatch'
        | 'batch-mismatch';
    };
