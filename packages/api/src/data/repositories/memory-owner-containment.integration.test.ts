/**
 * Every memory has exactly one owner, against a real database
 * (ink://specs/remove-shared-memories, slice 1).
 *
 * The unit suites prove what the server sends. These prove what the database
 * does with it, which is where two of the properties live:
 *
 *   - the recall RPCs apply the canonical owner BEFORE ranking and cutting
 *     their page, so a same-slug peer with more, higher-scoring rows cannot
 *     crowd the caller's own match out of the results (Lumen, spec v2
 *     re-review), and an ownerless row never comes back;
 *   - the archive triggers record the owner, so a memory deleted between
 *     slices keeps it, and restore puts it back with its contact scope.
 *
 * And the defect 3 acceptance case, through the real handlers: an SB's
 * bootstrap and recall show nothing of another SB's memories or of a shared
 * one, whatever the call names, and a summary cached before the cutover
 * cannot carry shared text back in.
 *
 * Run via: yarn test:integration:db:local src/data/repositories/memory-owner-containment.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDataComposer, type DataComposer } from '../composer';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  type EchoIntegrationFixture,
} from '../../test/integration-fixtures';
import { runWithRequestContext } from '../../utils/request-context';
import { handleBootstrap, handleRecall } from '../../mcp/tools/memory-handlers';

const DIMENSIONS = 1024;

/** A constant vector: identical to the query, similarity 1. */
const exact = `[${Array.from({ length: DIMENSIONS }, () => 1).join(',')}]`;
/** One dimension off: a strong match, but below every exact one. */
const near = `[${Array.from({ length: DIMENSIONS }, (_, i) => (i === DIMENSIONS - 1 ? 0 : 1)).join(',')}]`;

describe('memory owner containment', () => {
  let dc: DataComposer;
  let fixture: EchoIntegrationFixture;
  let alphaId: string;
  let betaId: string;
  const run = randomUUID().slice(0, 8);
  const probe = `containment-probe-${run}`;
  const created: string[] = [];

  async function seed(row: {
    content: string;
    agentId: string | null;
    sbId: string | null;
    embedding: string;
    salience?: string;
    contactId?: string | null;
  }): Promise<string> {
    const client = dc.getClient();
    const { data, error } = await client
      .from('memories')
      .insert({
        user_id: fixture.userId,
        content: row.content,
        source: 'observation',
        salience: row.salience ?? 'critical',
        topics: [probe],
        metadata: { suite: 'memory-owner-containment' },
        agent_id: row.agentId,
        sb_id: row.sbId,
        contact_id: row.contactId ?? null,
        embedding: row.embedding,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seed failed: ${error?.message}`);
    created.push(data.id);
    const { error: chunkError } = await client.from('memory_embedding_chunks').insert({
      memory_id: data.id,
      user_id: fixture.userId,
      chunk_index: 0,
      chunk_type: 'content',
      chunk_text: row.content,
      embedding: row.embedding,
      metadata: {},
    });
    if (chunkError) throw new Error(`chunk seed failed: ${chunkError.message}`);
    return data.id;
  }

  let ownId: string;

  beforeAll(async () => {
    dc = await getDataComposer();
    fixture = await ensureEchoIntegrationFixture(dc);
    alphaId = await ensureSuiteIdentity(dc, fixture, 'mo-alpha');
    betaId = await ensureSuiteIdentity(dc, fixture, 'mo-beta');

    // Alpha's own memory: a strong match, but not the strongest.
    ownId = await seed({
      content: `${probe} alpha-own`,
      agentId: 'mo-alpha',
      sbId: alphaId,
      embedding: near,
    });
    // Five exact matches that carry alpha's slug but another identity: the
    // same-slug peer the RPC's page used to fill up with.
    for (let i = 0; i < 5; i += 1) {
      await seed({
        content: `${probe} same-slug-peer-${i}`,
        agentId: 'mo-alpha',
        sbId: betaId,
        embedding: exact,
      });
    }
    // Beta's own memory, and a shared one with no owner at all.
    await seed({
      content: `${probe} beta-own`,
      agentId: 'mo-beta',
      sbId: betaId,
      embedding: exact,
    });
    await seed({
      content: `${probe} shared-sentinel`,
      agentId: null,
      sbId: null,
      embedding: exact,
    });
  });

  afterAll(async () => {
    if (!dc) return;
    const client = dc.getClient();
    if (created.length > 0) {
      await client.from('memory_embedding_chunks').delete().in('memory_id', created);
      await client.from('memories').delete().in('id', created);
      await client.from('memory_history').delete().in('memory_id', created);
    }
    await client
      .from('memory_summary_cache')
      .delete()
      .eq('user_id', fixture.userId)
      .eq('agent_id', 'mo-alpha');
  });

  const rpcArgs = (extra: Record<string, unknown>) => ({
    query_embedding: exact,
    match_threshold: 0.2,
    match_count: 3,
    p_user_id: fixture.userId,
    p_topics: [probe],
    ...extra,
  });

  describe('the recall RPCs', () => {
    for (const fn of ['match_memories', 'match_memory_embedding_chunks'] as const) {
      it(`${fn}: the owner is matched before the page is cut`, async () => {
        const client = dc.getClient() as unknown as {
          rpc: (
            name: string,
            args: Record<string, unknown>
          ) => Promise<{
            data: Array<{ id: string; sb_id: string | null }> | null;
            error: unknown;
          }>;
        };

        // The control: matching on the slug, a page of 3 is all peer rows,
        // and alpha's own match never reaches the server.
        const bySlug = await client.rpc(
          fn,
          rpcArgs({ p_agent_id: 'mo-alpha', p_include_shared: false })
        );
        expect(bySlug.error).toBeNull();
        expect(bySlug.data!.map((r) => r.id)).not.toContain(ownId);

        // With the canonical owner, alpha's match is the page.
        const byId = await client.rpc(fn, rpcArgs({ p_agent_id: 'mo-alpha', p_sb_id: alphaId }));
        expect(byId.error).toBeNull();
        expect(byId.data!.map((r) => r.id)).toEqual([ownId]);

        // p_include_shared is not consulted once the owner is named: no
        // ownerless row comes back even when an old caller asks for them.
        const oldFlag = await client.rpc(
          fn,
          rpcArgs({ p_agent_id: 'mo-alpha', p_include_shared: true, p_sb_id: alphaId })
        );
        expect(oldFlag.data!.every((r) => r.sb_id === alphaId)).toBe(true);
      });

      it(`${fn}: a caller still on the old arguments is served as before`, async () => {
        const client = dc.getClient() as unknown as {
          rpc: (
            name: string,
            args: Record<string, unknown>
          ) => Promise<{ data: Array<{ id: string }> | null; error: unknown }>;
        };
        // The server being replaced calls without p_sb_id; the function must
        // still accept that call during the deploy window.
        const legacy = await client.rpc(
          fn,
          rpcArgs({ p_agent_id: 'mo-alpha', p_include_shared: false, match_count: 20 })
        );
        expect(legacy.error).toBeNull();
        expect(legacy.data!.length).toBeGreaterThan(0);
      });
    }
  });

  describe('through the repository and the handlers', () => {
    const asAlpha = <T>(fn: () => Promise<T>) =>
      runWithRequestContext(
        {
          userId: fixture.userId,
          agentTokenBound: true,
          tokenSlug: 'mo-alpha',
          tokenSbId: alphaId,
        },
        fn
      );

    it('text recall returns the owner’s row and nothing else', async () => {
      const results = await dc.repositories.memory.recall(fixture.userId, probe, {
        sbSlug: 'mo-alpha',
        sbId: alphaId,
        recallMode: 'text',
        topics: [probe],
        limit: 50,
      });
      expect(results.map((m) => m.id)).toEqual([ownId]);
    });

    it('recall with no slug reads as the caller, and naming a peer is refused', async () => {
      const own = await asAlpha(() =>
        handleRecall({ userId: fixture.userId, query: probe, recallMode: 'text', limit: 50 }, dc)
      );
      const ownIds = JSON.parse(own.content[0].text).memories.map((m: { id: string }) => m.id);
      expect(ownIds).toEqual([ownId]);

      const peer = await asAlpha(() =>
        handleRecall({ userId: fixture.userId, query: probe, sbSlug: 'mo-beta' }, dc)
      );
      expect(JSON.parse(peer.content[0].text).success).toBe(false);
    });

    it('bootstrap shows only the caller’s memories, and no summary cached before the cutover', async () => {
      // A summary cached before shared memories were removed: it quotes the
      // shared sentinel. Fresh, by the old freshness rule.
      await dc
        .getClient()
        .from('memory_summary_cache')
        .upsert(
          {
            user_id: fixture.userId,
            agent_id: 'mo-alpha',
            summary_text: `CACHED ${probe} shared-sentinel`,
            memory_count: 1,
            computed_at: new Date(Date.now() + 60_000).toISOString(),
          },
          { onConflict: 'user_id,agent_id' }
        );

      for (const args of [{}, { sbSlug: 'mo-alpha' }, { postCompact: true }]) {
        const result = await asAlpha(() =>
          handleBootstrap({ userId: fixture.userId, ...args }, dc)
        );
        const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
        expect(text).toContain('alpha-own');
        expect(text).not.toContain('shared-sentinel');
        expect(text).not.toContain('same-slug-peer');
        expect(text).not.toContain('beta-own');
      }
    });

    it('bootstrap with no identity at all shows no memories', async () => {
      const result = await runWithRequestContext({ userId: fixture.userId }, () =>
        handleBootstrap({ userId: fixture.userId }, dc)
      );
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).not.toContain(probe);
    });
  });

  describe('history keeps the owner', () => {
    it('an archived edit and a delete both record the owner, and restore puts it back', async () => {
      // contact_id travels the same way; its mapping is pinned in
      // memory-repository.owner.test.ts.
      const id = await seed({
        content: `${probe} restorable`,
        agentId: 'mo-alpha',
        sbId: alphaId,
        embedding: near,
        salience: 'medium',
      });
      const client = dc.getClient();

      await client
        .from('memories')
        .update({ content: `${probe} restorable v2` })
        .eq('id', id);
      await client.from('memories').delete().eq('id', id);

      const { data: history } = await client
        .from('memory_history')
        .select('id, change_type, agent_id, sb_id')
        .eq('memory_id', id)
        .order('archived_at', { ascending: true });
      expect(history!.map((h) => h.change_type)).toEqual(['update', 'delete']);
      for (const row of history!) {
        expect(row).toMatchObject({ agent_id: 'mo-alpha', sb_id: alphaId });
      }

      // An SB sees its own history, and a peer sees none of it.
      const alphaHistory = await dc.repositories.memory.getMemoryHistory(
        id,
        fixture.userId,
        alphaId
      );
      expect(alphaHistory).toHaveLength(2);
      const betaHistory = await dc.repositories.memory.getMemoryHistory(id, fixture.userId, betaId);
      expect(betaHistory).toHaveLength(0);

      const deleteRow = history!.find((h) => h.change_type === 'delete')!;
      const restored = await dc.repositories.memory.restoreMemory(deleteRow.id, fixture.userId);
      expect(restored).toMatchObject({ sbSlug: 'mo-alpha', sbId: alphaId });
      created.push(restored!.id);
    });
  });
});
