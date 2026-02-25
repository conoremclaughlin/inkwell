import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveRouteAgentId } from './resolve-route';

// Mock Supabase client
function createMockSupabase(
  routes: Array<{
    id: string;
    platform_account_id: string | null;
    chat_id: string | null;
    identity_id: string;
    agent_identities: { agent_id: string };
  }>
) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(function (this: any) {
          // Chain .eq calls — return self each time, with final data on last
          return {
            eq: vi.fn().mockImplementation(function () {
              return {
                eq: vi.fn().mockResolvedValue({ data: routes, error: null }),
              };
            }),
          };
        }),
      }),
    }),
  } as any;
}

// Helper: mock that chains .from().select().eq().eq().eq() properly
function mockClient(routes: any[], error: any = null) {
  const eqChain = {
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: routes, error }),
      }),
    }),
  };
  const selectChain = { select: vi.fn().mockReturnValue(eqChain) };
  return {
    from: vi.fn().mockReturnValue(selectChain),
  } as any;
}

describe('resolveRouteAgentId', () => {
  it('returns null when no routes exist', async () => {
    const client = mockClient([]);
    const result = await resolveRouteAgentId(client, 'user-1', 'telegram');
    expect(result).toBeNull();
  });

  it('matches a platform-level default (no account, no chat)', async () => {
    const routes = [
      {
        id: 'route-1',
        platform_account_id: null,
        chat_id: null,
        identity_id: 'id-1',
        agent_identities: { agent_id: 'myra' },
      },
    ];
    const client = mockClient(routes);
    const result = await resolveRouteAgentId(client, 'user-1', 'telegram');

    expect(result).toEqual({
      agentId: 'myra',
      identityId: 'id-1',
      routeId: 'route-1',
      studioId: null,
    });
  });

  it('prefers account match over platform default', async () => {
    const routes = [
      {
        id: 'route-platform',
        platform_account_id: null,
        chat_id: null,
        identity_id: 'id-myra',
        agent_identities: { agent_id: 'myra' },
      },
      {
        id: 'route-account',
        platform_account_id: 'myra_help_bot',
        chat_id: null,
        identity_id: 'id-benson',
        agent_identities: { agent_id: 'benson' },
      },
    ];
    const client = mockClient(routes);

    const result = await resolveRouteAgentId(client, 'user-1', 'telegram', 'myra_help_bot');
    expect(result?.agentId).toBe('benson');
    expect(result?.routeId).toBe('route-account');
  });

  it('prefers exact chat match over account default', async () => {
    const routes = [
      {
        id: 'route-account',
        platform_account_id: 'myra_help_bot',
        chat_id: null,
        identity_id: 'id-myra',
        agent_identities: { agent_id: 'myra' },
      },
      {
        id: 'route-chat',
        platform_account_id: 'myra_help_bot',
        chat_id: 'chat-123',
        identity_id: 'id-wren',
        agent_identities: { agent_id: 'wren' },
      },
    ];
    const client = mockClient(routes);

    const result = await resolveRouteAgentId(
      client,
      'user-1',
      'telegram',
      'myra_help_bot',
      'chat-123'
    );
    expect(result?.agentId).toBe('wren');
    expect(result?.routeId).toBe('route-chat');
  });

  it('skips routes where account is specified but does not match', async () => {
    const routes = [
      {
        id: 'route-other-bot',
        platform_account_id: 'other_bot',
        chat_id: null,
        identity_id: 'id-benson',
        agent_identities: { agent_id: 'benson' },
      },
      {
        id: 'route-platform',
        platform_account_id: null,
        chat_id: null,
        identity_id: 'id-myra',
        agent_identities: { agent_id: 'myra' },
      },
    ];
    const client = mockClient(routes);

    // Incoming from myra_help_bot — should skip the other_bot route, match platform default
    const result = await resolveRouteAgentId(client, 'user-1', 'telegram', 'myra_help_bot');
    expect(result?.agentId).toBe('myra');
    expect(result?.routeId).toBe('route-platform');
  });

  it('skips routes where chat is specified but does not match', async () => {
    const routes = [
      {
        id: 'route-chat-specific',
        platform_account_id: null,
        chat_id: 'chat-999',
        identity_id: 'id-wren',
        agent_identities: { agent_id: 'wren' },
      },
      {
        id: 'route-platform',
        platform_account_id: null,
        chat_id: null,
        identity_id: 'id-myra',
        agent_identities: { agent_id: 'myra' },
      },
    ];
    const client = mockClient(routes);

    const result = await resolveRouteAgentId(client, 'user-1', 'telegram', undefined, 'chat-123');
    expect(result?.agentId).toBe('myra');
  });

  it('returns null on database error', async () => {
    const client = mockClient(null, { message: 'DB error' });
    const result = await resolveRouteAgentId(client, 'user-1', 'telegram');
    expect(result).toBeNull();
  });
});
