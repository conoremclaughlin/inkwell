import { describe, expect, it, vi } from 'vitest';
import { projectObserverEntry, OBSERVER_PROJECTION_TYPES } from './session-event-bus';
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('steering observer projection', () => {
  it.each(['steering_request', 'steering_input'])('projects bounded owner text for %s', (type) => {
    expect(OBSERVER_PROJECTION_TYPES.has(type)).toBe(true);
    const projected = projectObserverEntry({
      eid: 3,
      ts: 'fixture',
      type,
      messageId: 'fixture-message',
      turnEpoch: 'fixture-epoch',
      text: 'x'.repeat(600),
      boundary: 1,
      sender: { secret: 'never forward' },
      delegationToken: 'never forward',
      args: { secret: 'never forward' },
    });
    expect(projected).toEqual({
      eid: 3,
      ts: 'fixture',
      type,
      messageId: 'fixture-message',
      turnEpoch: 'fixture-epoch',
      content: `${'x'.repeat(399)}…`,
      ...(type === 'steering_input' ? { boundary: 1 } : {}),
    });
  });
  it('projects only receipt fields, without treating insertion as consumption', () => {
    expect(OBSERVER_PROJECTION_TYPES.has('steering_receipt')).toBe(true);
    expect(
      projectObserverEntry({
        eid: 5,
        ts: 'fixture',
        type: 'steering_receipt',
        messageId: 'fixture-message',
        turnEpoch: 'fixture-epoch',
        status: 'inserted',
        inputEid: 4,
        text: 'not part of receipt',
        providerAccepted: true,
        sender: 'untrusted assertion',
      })
    ).toEqual({
      eid: 5,
      ts: 'fixture',
      type: 'steering_receipt',
      messageId: 'fixture-message',
      turnEpoch: 'fixture-epoch',
      status: 'inserted',
      inputEid: 4,
    });
  });
  it('unknown future status remains unknown and malformed correlation is omitted', () => {
    expect(
      projectObserverEntry({
        eid: 5,
        ts: 'fixture',
        type: 'steering_receipt',
        messageId: 'fixture-message',
        turnEpoch: 'fixture-epoch',
        status: 'understood',
        inputEid: 'not a number',
        reason: 'x'.repeat(500),
      })
    ).toEqual({
      eid: 5,
      ts: 'fixture',
      type: 'steering_receipt',
      messageId: 'fixture-message',
      turnEpoch: 'fixture-epoch',
      status: 'unknown',
      reason: `${'x'.repeat(127)}…`,
    });
  });
});
