import { z } from 'zod';
import type {
  InboxNativeClaimRef,
  InboxNativeSettlementDecision,
} from './inbox-native-settlement.types.js';

// Projection budget, not a native intake capability or a provider batch limit.
const MAX_CLAIMS = 128;
const id = z.string().min(1).max(256).regex(/^\S+$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const evidenceDigest = z.string().regex(/^[0-9a-f]{64}$/);
const binding = z
  .object({
    userId: id,
    sbId: id,
    sessionId: id,
    backend: z.literal('claude-code'),
    nativeSessionId: id,
  })
  .strict();
const claim = z
  .object({ claimId: id, claimRevision: revision, deliveryId: id, messageId: id, threadId: id })
  .strict();
const claims = z
  .array(claim)
  .min(1)
  .max(MAX_CLAIMS)
  .refine((items) =>
    (['claimId', 'deliveryId', 'messageId'] as const).every(
      (key) => new Set(items.map((item) => item[key])).size === items.length
    )
  );
const batchShape = { binding, obligationId: id, originatingTurnEpoch: id, claims };
const expectedSchema = z.object(batchShape).strict();
const obligationShape = {
  ...batchShape,
  kind: z.literal('obligation'),
  schemaVersion: z.literal(1),
  revision,
};
const observationSchema = z.union([
  z.object({ kind: z.enum(['unavailable', 'empty']) }).strict(),
  z.object({ ...obligationShape, state: z.enum(['pending', 'reconciling', 'unknown']) }).strict(),
  z
    .object({
      ...obligationShape,
      state: z.literal('resolved-awaiting-ack'),
      outcome: z.enum(['consumed', 'definitely-not-written', 'confirmed-removed']),
      evidenceDigest,
    })
    .strict(),
]);

function sameClaim(a: InboxNativeClaimRef, b: InboxNativeClaimRef): boolean {
  return (
    a.claimId === b.claimId &&
    a.claimRevision === b.claimRevision &&
    a.deliveryId === b.deliveryId &&
    a.messageId === b.messageId &&
    a.threadId === b.threadId
  );
}

/**
 * Pure, unwired settlement planning, NOT proof of consumption or durable writes.
 * Inputs must be projections from the canonical source/native repositories;
 * shape validation is not authentication. The native owner validates transcript
 * attribution, persistent removal and consumption before producing an outcome.
 * In particular a clean immediate PostToolBatch cut is NOT confirmed-removed.
 *
 * No clocks, lease expiry, current epoch, callbacks, native transport or storage
 * are consulted here. A missing record never means safe fallback. A later DB
 * race must still lose the repository CAS, even if this snapshot once planned.
 */
export function planInboxNativeSettlement(
  expectedInput: unknown,
  observationInput: unknown
): InboxNativeSettlementDecision {
  try {
    const parsedExpected = expectedSchema.safeParse(expectedInput);
    const parsedObservation = observationSchema.safeParse(observationInput);
    if (!parsedExpected.success || !parsedObservation.success) {
      return { status: 'held', reason: 'invalid-input' };
    }
    const expected = parsedExpected.data;
    const observed = parsedObservation.data;
    if (observed.kind === 'unavailable') return { status: 'held', reason: 'native-unavailable' };
    if (observed.kind === 'empty') return { status: 'held', reason: 'native-missing' };
    if (observed.kind !== 'obligation') return { status: 'held', reason: 'invalid-input' };
    for (const key of ['userId', 'sbId', 'sessionId', 'backend', 'nativeSessionId'] as const) {
      if (expected.binding[key] !== observed.binding[key]) {
        return { status: 'held', reason: 'binding-mismatch' };
      }
    }
    if (
      expected.obligationId !== observed.obligationId ||
      expected.originatingTurnEpoch !== observed.originatingTurnEpoch
    ) {
      return { status: 'held', reason: 'obligation-mismatch' };
    }
    const byClaimId = new Map(observed.claims.map((item) => [item.claimId, item]));
    if (
      expected.claims.length !== observed.claims.length ||
      !expected.claims.every((item) => {
        const other = byClaimId.get(item.claimId);
        return other !== undefined && sameClaim(item, other);
      })
    ) {
      return { status: 'held', reason: 'batch-mismatch' };
    }
    if (observed.state !== 'resolved-awaiting-ack') {
      return { status: 'held', reason: 'native-unresolved' };
    }
    // Zod copied the inputs; freeze the complete plan so it cannot be retargeted
    // by mutation while a later repository operation is in flight.
    return Object.freeze({
      status: 'planned',
      plan: Object.freeze({
        binding: Object.freeze(expected.binding),
        obligationId: expected.obligationId,
        originatingTurnEpoch: expected.originatingTurnEpoch,
        claims: Object.freeze(expected.claims.map((item) => Object.freeze(item))),
        nativeRevision: observed.revision,
        outcome: observed.outcome,
        evidenceDigest: observed.evidenceDigest,
        disposition: observed.outcome === 'consumed' ? 'mark-consumed' : 'make-queue-eligible',
        next: 'persist-source-settlement',
      }),
    });
  } catch {
    // Includes malformed accessor inputs. Never publish error/input bodies.
    return { status: 'held', reason: 'invalid-input' };
  }
}
