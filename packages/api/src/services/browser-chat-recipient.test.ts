import { describe, it, expect, vi } from 'vitest';
import { browserChatRecipients } from './browser-chat-recipient';

describe('ordinary browser recipient scope', () => {
  it('binds user, workspace, runtime and optional identity without treating app metadata as ordinary', async () => {
    const filters: unknown[] = [];
    const chain = {
      select: vi.fn(() => chain),
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return chain;
      },
      order: () => chain,
      limit: async () => ({
        data: [
          { id: 'ordinary', agent_id: 'fixture-companion', name: 'River', metadata: {} },
          {
            id: 'app',
            agent_id: 'fixture-app',
            name: 'Moss',
            metadata: { client: 'inkling-mobile' },
          },
        ],
        error: null,
      }),
    };
    const client = { from: vi.fn(() => chain) };
    expect(
      await browserChatRecipients(
        client as never,
        { userId: 'fixture-user', workspaceId: 'fixture-workspace' },
        'ordinary'
      )
    ).toEqual([{ id: 'ordinary', sbSlug: 'fixture-companion', displayName: 'River' }]);
    expect(filters).toEqual([
      ['user_id', 'fixture-user'],
      ['workspace_id', 'fixture-workspace'],
      ['backend', 'ink'],
      ['id', 'ordinary'],
    ]);
    expect(client.from).toHaveBeenCalledWith('agent_identities');
  });
});
