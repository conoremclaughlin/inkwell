/**
 * The two PostgREST embeds the thread readers depend on (Lumen, #618 round 1).
 *
 * Since the cutover there are two relationships between inbox_threads and
 * inbox_thread_participants — thread_id, and (thread_id, workspace_id) — so
 * an unqualified embed answers PGRST201 ("more than one relationship"). Both
 * production selects name the FK; only PostgREST can show the name resolves.
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect } from 'vitest';
import { getDataComposer } from '../../data/composer';

describe('thread ↔ participant embeds resolve by FK name (integration)', () => {
  it('the get_inbox recency embed resolves', async () => {
    const client = (await getDataComposer()).getClient();
    const result = await client
      .from('inbox_threads')
      .select('id, inbox_thread_participants!inbox_thread_participants_thread_id_fkey!inner(sb_id)')
      .limit(1);
    expect(result.error).toBeNull();
  });

  it('the admin thread-list participant embed resolves', async () => {
    const client = (await getDataComposer()).getClient();
    const result = await client
      .from('inbox_thread_participants')
      .select(
        'thread_id, sb_id, user_id, inbox_threads!inbox_thread_participants_thread_id_fkey!inner(workspace_id)'
      )
      .limit(1);
    expect(result.error).toBeNull();
  });

  it('the unqualified embed is ambiguous — the reason the FK is named', async () => {
    const client = (await getDataComposer()).getClient();
    const result = await client
      .from('inbox_threads')
      .select('id, inbox_thread_participants!inner(sb_id)')
      .limit(1);
    expect(result.error?.code).toBe('PGRST201');
  });
});
