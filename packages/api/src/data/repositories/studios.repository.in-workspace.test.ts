import { describe, it, expect } from 'vitest';
import { makeFakeSupabase } from '../../services/sessions/fake-supabase';
import { StudiosRepository, type Studio } from './studios.repository';

const studio = (over: Partial<Studio>): Studio =>
  ({ id: 'st', userId: 'user-1', sbId: null, ephemeral: true, ...over }) as Studio;

describe('StudiosRepository.inWorkspace (spec inkmail-thread-scope §1)', () => {
  const repo = new StudiosRepository(
    makeFakeSupabase({
      agent_identities: [
        { id: 'sb-u1-ws1', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'sb-u1-ws2', agent_id: 'wren', user_id: 'user-1', workspace_id: 'ws-2' },
        { id: 'sb-u2-ws1', agent_id: 'lumen', user_id: 'user-2', workspace_id: 'ws-1' },
      ],
    }) as never
  );

  it("keeps every owner's studio in the workspace and drops a same-owner studio elsewhere", async () => {
    const kept = await repo.inWorkspace(
      [
        studio({ id: 'mine-here', sbId: 'sb-u1-ws1' }),
        studio({ id: 'mine-elsewhere', sbId: 'sb-u1-ws2' }),
        studio({ id: 'theirs-here', userId: 'user-2', sbId: 'sb-u2-ws1' }),
      ],
      'ws-1',
      'user-1'
    );
    expect(kept.map((s) => s.id)).toEqual(['mine-here', 'theirs-here']);
  });

  it('a legacy studio with no identity belongs only to the given owner, and to nobody without one', async () => {
    const legacy = [
      studio({ id: 'legacy-mine' }),
      studio({ id: 'legacy-theirs', userId: 'user-2' }),
    ];
    expect((await repo.inWorkspace(legacy, 'ws-1', 'user-1')).map((s) => s.id)).toEqual([
      'legacy-mine',
    ]);
    expect(await repo.inWorkspace(legacy, 'ws-1')).toEqual([]);
  });
});
