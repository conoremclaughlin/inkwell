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
        toAgentId: 'aster',
        fromAgentId: 'wren',
        triggerType: 'message',
        threadKey: 'spec:artifact-graph-lifecycle',
        priority: 'normal',
      } as never,
      {} as never
    );
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'aster',
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
        toAgentId: 'aster',
        fromAgentId: 'wren',
        triggerType: 'message',
        priority: 'normal',
      } as never,
      {} as never
    );
    expect(dispatchTrigger).toHaveBeenCalledTimes(1);
    expect(dispatchTrigger.mock.calls[0][0]).not.toHaveProperty('recipientUserId');
  });
});
