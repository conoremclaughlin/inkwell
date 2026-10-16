import { describe, expect, it } from 'vitest';
import { planInboxNativeSettlement } from './inbox-native-settlement.js';
import type {
  InboxNativeExpectedBatch,
  InboxNativeOutcome,
} from './inbox-native-settlement.types.js';

const digest = '0123456789abcdef'.repeat(4);

function expectedBatch(): InboxNativeExpectedBatch {
  return {
    binding: {
      userId: 'owner',
      sbId: 'sb',
      sessionId: 'session',
      backend: 'claude-code',
      nativeSessionId: 'native',
    },
    obligationId: 'obligation',
    originatingTurnEpoch: 'original-epoch',
    claims: ['a', 'b'].map((id) => ({
      claimId: `claim-${id}`,
      claimRevision: 3,
      deliveryId: `delivery-${id}`,
      messageId: `message-${id}`,
      threadId: `thread-${id}`,
    })),
  };
}

function resolved(outcome: InboxNativeOutcome = 'consumed') {
  return {
    ...expectedBatch(),
    kind: 'obligation' as const,
    schemaVersion: 1 as const,
    revision: 7,
    state: 'resolved-awaiting-ack' as const,
    outcome,
    evidenceDigest: digest,
  };
}

describe('inbox/native settlement planning (unwired, no durable-store claims)', () => {
  it.each([
    ['consumed', 'mark-consumed'],
    ['definitely-not-written', 'make-queue-eligible'],
    ['confirmed-removed', 'make-queue-eligible'],
  ] as const)(
    'plans the whole batch for %s, without reporting completion',
    (outcome, disposition) => {
      expect(planInboxNativeSettlement(expectedBatch(), resolved(outcome))).toEqual({
        status: 'planned',
        plan: {
          ...expectedBatch(),
          nativeRevision: 7,
          outcome,
          evidenceDigest: digest,
          disposition,
          next: 'persist-source-settlement',
        },
      });
    }
  );

  it.each(['pending', 'reconciling', 'unknown'])('holds a %s obligation', (state) => {
    const { outcome: _outcome, evidenceDigest: _evidenceDigest, ...observation } = resolved();
    expect(planInboxNativeSettlement(expectedBatch(), { ...observation, state })).toEqual({
      status: 'held',
      reason: 'native-unresolved',
    });
  });

  it.each([
    ['unavailable', 'native-unavailable'],
    ['empty', 'native-missing'],
  ])('%s is not evidence for requeue', (kind, reason) => {
    expect(planInboxNativeSettlement(expectedBatch(), { kind })).toEqual({
      status: 'held',
      reason,
    });
  });

  it.each(['userId', 'sbId', 'sessionId', 'nativeSessionId'] as const)(
    'refuses another %s even with identical obligation and claim IDs',
    (field) => {
      const observation = resolved();
      observation.binding = { ...observation.binding, [field]: 'other' };
      expect(planInboxNativeSettlement(expectedBatch(), observation)).toEqual({
        status: 'held',
        reason: 'binding-mismatch',
      });
    }
  );

  it.each(['obligationId', 'originatingTurnEpoch'] as const)('refuses a different %s', (field) => {
    expect(planInboxNativeSettlement(expectedBatch(), { ...resolved(), [field]: 'other' })).toEqual(
      {
        status: 'held',
        reason: 'obligation-mismatch',
      }
    );
  });

  describe.each(['expected', 'observed'] as const)('%s native key', (side) => {
    it.each([undefined, null, '', 'codex'])(
      'rejects invalid backend (%#), without a default',
      (backend) => {
        const expected = expectedBatch();
        const observation = resolved();
        expect(
          planInboxNativeSettlement(
            side === 'expected'
              ? { ...expected, binding: { ...expected.binding, backend } }
              : expected,
            side === 'observed'
              ? { ...observation, binding: { ...observation.binding, backend } }
              : observation
          )
        ).toEqual({ status: 'held', reason: 'invalid-input' });
      }
    );

    it('rejects an omitted backend, not just an explicit undefined value', () => {
      const expected = expectedBatch();
      const observation = resolved();
      const { backend: _backend, ...withoutBackend } = expected.binding;
      expect(
        planInboxNativeSettlement(
          side === 'expected' ? { ...expected, binding: withoutBackend } : expected,
          side === 'observed' ? { ...observation, binding: withoutBackend } : observation
        )
      ).toEqual({ status: 'held', reason: 'invalid-input' });
    });
  });

  it('does not grant another backend capability merely because both projections agree', () => {
    const expected = expectedBatch();
    const observation = resolved();
    const binding = { ...expected.binding, backend: 'codex' };
    expect(
      planInboxNativeSettlement({ ...expected, binding }, { ...observation, binding })
    ).toEqual({ status: 'held', reason: 'invalid-input' });
  });

  it('carries the originating epoch and observed revision, not a guessed current turn', () => {
    const observation = { ...resolved(), revision: 101 };
    expect(planInboxNativeSettlement(expectedBatch(), observation)).toMatchObject({
      status: 'planned',
      plan: { originatingTurnEpoch: 'original-epoch', nativeRevision: 101 },
    });
  });

  it.each([
    undefined,
    null,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    7,
    `${digest}\n`,
    `${digest}\r\n`,
  ])('refuses a missing or malformed resolution evidence digest (%#)', (evidenceDigest) => {
    expect(planInboxNativeSettlement(expectedBatch(), { ...resolved(), evidenceDigest })).toEqual({
      status: 'held',
      reason: 'invalid-input',
    });
  });

  it('preserves the exact observed digest without normalizing or later rereading evidence', () => {
    const observation = resolved();
    const first = planInboxNativeSettlement(expectedBatch(), observation);
    observation.evidenceDigest = 'fedcba9876543210'.repeat(4);
    const second = planInboxNativeSettlement(expectedBatch(), observation);
    expect(first).toMatchObject({ status: 'planned', plan: { evidenceDigest: digest } });
    expect(second).toMatchObject({
      status: 'planned',
      plan: { evidenceDigest: observation.evidenceDigest },
    });
    expect(first).not.toEqual(second);
  });

  it('rejects an omitted digest even though the outcome and revision match', () => {
    const { evidenceDigest: _evidenceDigest, ...observation } = resolved();
    expect(planInboxNativeSettlement(expectedBatch(), observation)).toEqual({
      status: 'held',
      reason: 'invalid-input',
    });
  });

  it.each(['claimId', 'claimRevision', 'deliveryId', 'messageId', 'threadId'] as const)(
    'refuses a mismatched claim %s, without settling the other member',
    (field) => {
      const observation = resolved();
      observation.claims = observation.claims.map((item, index) =>
        index === 0 ? { ...item, [field]: field === 'claimRevision' ? 4 : 'other' } : item
      );
      expect(planInboxNativeSettlement(expectedBatch(), observation)).toEqual({
        status: 'held',
        reason: 'batch-mismatch',
      });
    }
  );

  it.each(['partial', 'extra'])('refuses a %s batch', (kind) => {
    const observation = resolved();
    observation.claims =
      kind === 'partial'
        ? observation.claims.slice(0, 1)
        : [
            ...observation.claims,
            { claimId: 'c', deliveryId: 'd', messageId: 'm', threadId: 't', claimRevision: 0 },
          ];
    expect(planInboxNativeSettlement(expectedBatch(), observation)).toEqual({
      status: 'held',
      reason: 'batch-mismatch',
    });
  });

  it('matches complete membership independently of observation order, preserving source order', () => {
    const observation = resolved();
    observation.claims = [...observation.claims].reverse();
    expect(planInboxNativeSettlement(expectedBatch(), observation)).toMatchObject({
      status: 'planned',
      plan: { claims: expectedBatch().claims },
    });
  });

  it.each(['expected', 'observed'] as const)(
    'rejects duplicate or aliased %s claims rather than hiding them in a Map',
    (side) => {
      for (const field of ['claimId', 'deliveryId', 'messageId'] as const) {
        const expected = expectedBatch();
        const observation = resolved();
        const target = side === 'expected' ? expected : observation;
        const duplicates = target.claims.map((item) => ({
          ...item,
          [field]: target.claims[0][field],
        }));
        const decision = planInboxNativeSettlement(
          side === 'expected' ? { ...expected, claims: duplicates } : expected,
          side === 'observed' ? { ...observation, claims: duplicates } : observation
        );
        expect(decision).toEqual({ status: 'held', reason: 'invalid-input' });
      }
    }
  );

  it.each([
    [],
    Array(2),
    Array.from({ length: 129 }, (_, i) => ({
      claimId: `c-${i}`,
      deliveryId: `d-${i}`,
      messageId: `m-${i}`,
      threadId: 't',
      claimRevision: 0,
    })),
  ])('refuses empty, sparse or over-budget claims', (claims) => {
    expect(
      planInboxNativeSettlement({ ...expectedBatch(), claims }, { ...resolved(), claims })
    ).toEqual({
      status: 'held',
      reason: 'invalid-input',
    });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7'])(
    'refuses invalid native revision %s',
    (revision) => {
      expect(planInboxNativeSettlement(expectedBatch(), { ...resolved(), revision })).toEqual({
        status: 'held',
        reason: 'invalid-input',
      });
    }
  );

  it.each([
    undefined,
    null,
    {},
    { kind: 'obligation' },
    { ...resolved(), schemaVersion: 2 },
    { ...resolved(), outcome: 'callback-written' },
    { ...resolved(), state: 'unknown' },
    { ...resolved(), originatingTurnEpoch: ' ' },
    { ...resolved(), obligationId: 'x'.repeat(257) },
    { ...resolved(), prompt: 'synthetic-private-body' },
  ])('holds malformed/unsupported evidence without exposing it (%#)', (observation) => {
    const decision = planInboxNativeSettlement(expectedBatch(), observation);
    expect(decision).toEqual({ status: 'held', reason: 'invalid-input' });
    expect(JSON.stringify(decision)).not.toContain('synthetic-private-body');
  });

  it('does not reinterpret one clean PostToolBatch request as removal', () => {
    const { outcome: _outcome, evidenceDigest: _evidenceDigest, ...observation } = resolved();
    expect(
      planInboxNativeSettlement(expectedBatch(), { ...observation, state: 'unknown' })
    ).toEqual({
      status: 'held',
      reason: 'native-unresolved',
    });
    // Raw fixture assertions are not native-owner terminal outcomes.
    expect(
      planInboxNativeSettlement(expectedBatch(), {
        ...observation,
        state: 'resolved-awaiting-ack',
        outcome: 'clean-immediate-request',
      })
    ).toEqual({ status: 'held', reason: 'invalid-input' });
  });

  it('holds a throwing input accessor without publishing the error', () => {
    const input = {
      get binding() {
        throw new Error('synthetic-private-body');
      },
    };
    expect(planInboxNativeSettlement(input, resolved())).toEqual({
      status: 'held',
      reason: 'invalid-input',
    });
  });

  it('copies and freezes the plan, including each claim, against later mutation', () => {
    const expected = expectedBatch();
    const observation = resolved();
    const decision = planInboxNativeSettlement(expected, observation);
    expect(decision.status).toBe('planned');
    if (decision.status !== 'planned') throw new Error('expected synthetic plan');
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.plan)).toBe(true);
    expect(Object.isFrozen(decision.plan.binding)).toBe(true);
    expect(Object.isFrozen(decision.plan.claims)).toBe(true);
    expect(Object.isFrozen(decision.plan.claims[0])).toBe(true);
    expect(Object.isFrozen(expected.binding)).toBe(false);
    expect(Object.isFrozen(expected.claims)).toBe(false);
    expect(Object.isFrozen(expected.claims[0])).toBe(false);
    (expected.binding as { userId: string }).userId = 'changed';
    (expected.claims[0] as { claimId: string }).claimId = 'changed';
    expect(decision.plan.binding.userId).toBe('owner');
    expect(decision.plan.claims[0].claimId).toBe('claim-a');
  });

  it('is repeatable planning, not idempotency or a durable completion receipt', () => {
    const first = planInboxNativeSettlement(expectedBatch(), resolved('confirmed-removed'));
    const second = planInboxNativeSettlement(expectedBatch(), resolved('confirmed-removed'));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).not.toHaveProperty('acknowledged');
    expect(first).not.toHaveProperty('ready');
    expect(first).not.toHaveProperty('completed');
  });
});
