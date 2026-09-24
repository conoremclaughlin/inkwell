import { describe, it, expect } from 'vitest';
import { makeFakeSupabase } from './sessions/fake-supabase';
import { carrierScopeFilter, workspaceSbIds } from './carrier-scope';

describe('carrier scope (spec inkmail-thread-scope §1, §3)', () => {
  it("lists the workspace's identities, not the viewer's", async () => {
    const db = makeFakeSupabase({
      agent_identities: [
        { id: 'sb-a', workspace_id: 'ws-1', user_id: 'user-1' },
        { id: 'sb-b', workspace_id: 'ws-1', user_id: 'user-2' },
        { id: 'sb-c', workspace_id: 'ws-2', user_id: 'user-1' },
      ],
    });
    expect(await workspaceSbIds(db, 'ws-1')).toEqual(['sb-a', 'sb-b']);
  });

  it('selects rows attributed to those identities, or unattributed rows of the viewer', () => {
    expect(carrierScopeFilter(['sb-a', 'sb-b'], 'user-1')).toBe(
      'sb_id.in.(sb-a,sb-b),and(sb_id.is.null,user_id.eq.user-1)'
    );
    // No identities yet: only the viewer's own unattributed rows.
    expect(carrierScopeFilter([], 'user-1')).toBe('and(sb_id.is.null,user_id.eq.user-1)');
  });
});
