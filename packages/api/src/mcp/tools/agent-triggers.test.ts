import { describe, expect, it, vi } from 'vitest';
import { handleTriggerAgent } from './agent-triggers';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const dispatchTrigger = vi.fn().mockReturnValue({
  success: true,
  triggerId: 'trigger-1',
  processed: false,
  accepted: true,
});

vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn().mockReturnValue({
    hasHandler: vi.fn().mockReturnValue(true),
    dispatchTrigger: (...args: unknown[]) => dispatchTrigger(...args),
  }),
}));

const resolveUserMock = vi.fn();
vi.mock('../../services/user-resolver', () => ({
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

describe('handleTriggerAgent — authenticated-user stamping (PR #487)', () => {
  it('stamps recipientUserId from the authenticated user so bare threadKey failures are routable', async () => {
    resolveUserMock.mockResolvedValue({ user: { id: 'user-123' }, resolvedBy: 'token' });
    await handleTriggerAgent(
      {
        toSlug: 'aster',
        fromSlug: 'wren',
        triggerType: 'message',
        threadKey: 'spec:artifact-graph-lifecycle',
        priority: 'normal',
      } as never,
      {} as never
    );
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toSlug: 'aster',
        threadKey: 'spec:artifact-graph-lifecycle',
        recipientUserId: 'user-123',
      })
    );
  });

  it('still dispatches (without the stamp) when user resolution fails', async () => {
    dispatchTrigger.mockClear();
    resolveUserMock.mockRejectedValue(new Error('no token'));
    await handleTriggerAgent(
      {
        toSlug: 'aster',
        fromSlug: 'wren',
        triggerType: 'message',
        priority: 'normal',
      } as never,
      {} as never
    );
    expect(dispatchTrigger).toHaveBeenCalledTimes(1);
    expect(dispatchTrigger.mock.calls[0][0]).not.toHaveProperty('recipientUserId');
  });
});

describe('handleTriggerAgent — anchor provenance (PR #681 round 3)', () => {
  // A recipientSessionId / studio the CALLER passes here is addressing, the
  // same way it is on send_to_inbox. Without the flag the trigger handler
  // reads it as an inferred continuity hint and, on a project-pinned thread,
  // drops a genuinely explicit session that sits outside the project repo.
  it('marks a caller-passed recipientSessionId as an explicit target', async () => {
    dispatchTrigger.mockClear();
    resolveUserMock.mockResolvedValue({ user: { id: 'user-123' }, resolvedBy: 'token' });
    await handleTriggerAgent(
      {
        toSlug: 'aster',
        fromSlug: 'wren',
        triggerType: 'message',
        threadKey: 'inktrade:pr:1',
        priority: 'normal',
        recipientSessionId: '00000000-0000-4000-8000-000000000681',
      } as never,
      {} as never
    );
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: '00000000-0000-4000-8000-000000000681',
        explicitRecipientTarget: true,
      })
    );
  });

  it('marks a caller-passed studio as an explicit target, and a bare trigger as none', async () => {
    dispatchTrigger.mockClear();
    resolveUserMock.mockResolvedValue({ user: { id: 'user-123' }, resolvedBy: 'token' });
    await handleTriggerAgent(
      {
        toSlug: 'aster',
        fromSlug: 'wren',
        triggerType: 'message',
        priority: 'normal',
        studioHint: 'aster-main',
      } as never,
      {} as never
    );
    expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({ explicitRecipientTarget: true });

    dispatchTrigger.mockClear();
    await handleTriggerAgent(
      { toSlug: 'aster', fromSlug: 'wren', triggerType: 'message', priority: 'normal' } as never,
      {} as never
    );
    expect(dispatchTrigger.mock.calls[0][0]).not.toHaveProperty('explicitRecipientTarget');
  });
});
