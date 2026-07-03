import { describe, it, expect, vi } from 'vitest';
import { activityBus } from './activity-bus';
import type { Activity } from '../../data/repositories/activity-stream.repository';

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    userId: 'user-1',
    sessionId: 'session-1',
    agentId: 'wren',
    type: 'tool_call',
    subtype: null,
    content: 'test',
    payload: {},
    contactId: null,
    parentId: null,
    correlationId: null,
    platform: null,
    platformMessageId: null,
    platformChatId: null,
    isDm: true,
    artifactId: null,
    childSessionId: null,
    taskGroupId: null,
    createdAt: new Date(),
    completedAt: null,
    durationMs: null,
    status: 'completed',
    ...overrides,
  };
}

describe('activityBus', () => {
  it('delivers activities matching the userId filter', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe({ userId: 'user-1' }, listener);

    const activity = makeActivity();
    activityBus.publish(activity);

    expect(listener).toHaveBeenCalledWith(activity);
    unsubscribe();
  });

  it('drops activities for other users', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe({ userId: 'user-1' }, listener);

    activityBus.publish(makeActivity({ userId: 'user-2' }));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('filters by sessionId when provided', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe(
      { userId: 'user-1', sessionId: 'session-1' },
      listener
    );

    activityBus.publish(makeActivity({ sessionId: 'session-2' }));
    expect(listener).not.toHaveBeenCalled();

    const match = makeActivity({ sessionId: 'session-1' });
    activityBus.publish(match);
    expect(listener).toHaveBeenCalledWith(match);
    unsubscribe();
  });

  it('filters by taskGroupId when provided', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe(
      { userId: 'user-1', taskGroupId: 'group-1' },
      listener
    );

    activityBus.publish(makeActivity({ taskGroupId: null }));
    activityBus.publish(makeActivity({ taskGroupId: 'group-2' }));
    expect(listener).not.toHaveBeenCalled();

    const match = makeActivity({ taskGroupId: 'group-1' });
    activityBus.publish(match);
    expect(listener).toHaveBeenCalledWith(match);
    unsubscribe();
  });

  it('filters by agentId when provided', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe({ userId: 'user-1', agentId: 'myra' }, listener);

    activityBus.publish(makeActivity({ agentId: 'wren' }));
    expect(listener).not.toHaveBeenCalled();

    const match = makeActivity({ agentId: 'myra' });
    activityBus.publish(match);
    expect(listener).toHaveBeenCalledWith(match);
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = activityBus.subscribe({ userId: 'user-1' }, listener);
    unsubscribe();

    activityBus.publish(makeActivity());
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple concurrent subscribers with independent filters', () => {
    const sessionListener = vi.fn();
    const groupListener = vi.fn();
    const un1 = activityBus.subscribe(
      { userId: 'user-1', sessionId: 'session-1' },
      sessionListener
    );
    const un2 = activityBus.subscribe({ userId: 'user-1', taskGroupId: 'group-1' }, groupListener);

    const both = makeActivity({ sessionId: 'session-1', taskGroupId: 'group-1' });
    activityBus.publish(both);
    expect(sessionListener).toHaveBeenCalledWith(both);
    expect(groupListener).toHaveBeenCalledWith(both);

    const sessionOnly = makeActivity({ sessionId: 'session-1', taskGroupId: null });
    activityBus.publish(sessionOnly);
    expect(sessionListener).toHaveBeenCalledTimes(2);
    expect(groupListener).toHaveBeenCalledTimes(1);

    un1();
    un2();
  });
});
