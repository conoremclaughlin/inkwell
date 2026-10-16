/**
 * inbox_threads.conversation_mode against the real schema
 * (ink://specs/inkling-multi-person-groups, D8; conversation-mode.ts).
 *
 * The CHECK allows only NULL, 'public' and 'private', and the insert that
 * creates a thread (findOrCreateThread) writes the mode it is given, through
 * PostgREST, while a thread created without one stores NULL.
 *
 * Run via: yarn test:integration:db:local src/services/threads/conversation-mode.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { findOrCreateThread } from '../../mcp/tools/inbox-handlers';

describe('inbox_threads.conversation_mode', () => {
  let dataComposer: DataComposer;
  let workspaceId: string;
  let echoSbId: string;
  const run = randomUUID().slice(0, 8);
  const threadIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    workspaceId = fixture.workspaceId;
    echoSbId = fixture.echoSbId;
  });

  afterAll(async () => {
    if (threadIds.length > 0) {
      await dataComposer.getClient().from('inbox_threads').delete().in('id', threadIds);
    }
  });

  async function insert(label: string, mode: unknown) {
    const result = await dataComposer
      .getClient()
      .from('inbox_threads')
      .insert({
        thread_key: `test:mode-${label}-${run}`,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: echoSbId,
        conversation_mode: mode as string | null,
      })
      .select('id, conversation_mode')
      .single();
    if (result.data?.id) threadIds.push(result.data.id);
    return result;
  }

  it.each([['public'], ['private'], [null]])('stores %j', async (mode) => {
    const { data, error } = await insert(String(mode), mode);
    expect(error).toBeNull();
    expect(data!.conversation_mode).toBe(mode);
  });

  it.each([['shared'], ['Public'], ['']])('refuses %j at insert', async (mode) => {
    const { error } = await insert(`bad-${mode || 'empty'}`, mode);
    expect(error?.code).toBe('23514');
  });

  it('is written by the insert that creates a thread, and left NULL without one', async () => {
    const creator = {
      kind: 'sb' as const,
      sbId: echoSbId,
      sbSlug: 'echo',
      userId: (await ensureEchoIntegrationFixture(dataComposer)).userId,
      workspaceId,
    };
    const supabase = dataComposer.getClient();
    const withMode = await findOrCreateThread(supabase, {
      workspaceId,
      threadKey: `test:mode-created-${run}`,
      creator,
      title: null,
      participants: [],
      conversationMode: 'private',
    });
    const without = await findOrCreateThread(supabase, {
      workspaceId,
      threadKey: `test:mode-created-none-${run}`,
      creator,
      title: null,
      participants: [],
    });
    threadIds.push(withMode.id, without.id);
    const { data, error } = await supabase
      .from('inbox_threads')
      .select('id, conversation_mode')
      .in('id', [withMode.id, without.id]);
    expect(error).toBeNull();
    const modeById = Object.fromEntries((data ?? []).map((r) => [r.id, r.conversation_mode]));
    expect(modeById).toEqual({ [withMode.id]: 'private', [without.id]: null });
  });
});
