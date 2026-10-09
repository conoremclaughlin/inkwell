/**
 * A deleted SB takes its refresh records with it (task 3f7f6a8f, PR #795).
 *
 * The thing under test is a foreign key: mcp_tokens_sb_id_fkey is ON DELETE
 * CASCADE (20261008202507_mcp_tokens_sb_cascade.sql), so it runs against a
 * real database. Deleting the identity row is what deleting its space does
 * (agent_identities_workspace_id_fkey ON DELETE CASCADE).
 *
 * The case that shows it: an SB is deleted, then its owner makes a new SB
 * under the same slug. Under ON DELETE SET NULL the old record survived with
 * its slug, the new SB satisfied the exchange's slug check, and the deleted
 * SB's refresh minted again. With CASCADE the record is gone.
 */

import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataComposer, type DataComposer } from '../data/composer';
import {
  ensureEchoIntegrationFixture,
  type EchoIntegrationFixture,
} from '../test/integration-fixtures';
import { createRefreshToken, exchangeRefreshToken } from './ink-tokens';

const CLIENT = 'integration-test-deleted-sb';

describe('a deleted SB takes its refresh records with it', () => {
  let dataComposer: DataComposer;
  let fixture: EchoIntegrationFixture;
  const slug = `itest-deleted-sb-${randomUUID().slice(0, 8)}`;
  const identityIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    fixture = await ensureEchoIntegrationFixture(dataComposer);
  });

  afterAll(async () => {
    if (!dataComposer) return;
    const supabase = dataComposer.getClient();
    await supabase.from('mcp_tokens').delete().eq('client_id', CLIENT);
    if (identityIds.length > 0) {
      await supabase.from('agent_identities').delete().in('id', identityIds);
    }
  });

  async function insertIdentity(): Promise<string> {
    const { data, error } = await dataComposer
      .getClient()
      .from('agent_identities')
      .insert({
        user_id: fixture.userId,
        workspace_id: fixture.workspaceId,
        agent_id: slug,
        name: 'Deleted-SB fixture',
        role: 'Integration fixture',
      })
      .select('id')
      .single();
    if (error) throw new Error(`could not create the fixture identity: ${error.message}`);
    identityIds.push(data.id);
    return data.id as string;
  }

  it('deletes the record, so a later SB of the same slug cannot make its refresh mint', async () => {
    const supabase = dataComposer.getClient();
    const doomed = await insertIdentity();
    const { refreshToken } = await createRefreshToken(
      supabase,
      fixture.userId,
      CLIENT,
      ['mcp:tools'],
      1,
      slug,
      doomed
    );

    const { error } = await supabase.from('agent_identities').delete().eq('id', doomed);
    expect(error).toBeNull();

    // The owner makes a new SB under the same slug.
    await insertIdentity();

    // Under SET NULL this row survived, with sb_id null and the slug kept.
    const { data: left } = await supabase
      .from('mcp_tokens')
      .select('id')
      .eq('refresh_token', refreshToken);
    expect(left).toEqual([]);
    // Under SET NULL the new SB satisfied the slug check and this minted.
    await expect(
      exchangeRefreshToken(supabase, refreshToken, CLIENT, 'mcp_access', 3600)
    ).resolves.toBeNull();
  });
});
