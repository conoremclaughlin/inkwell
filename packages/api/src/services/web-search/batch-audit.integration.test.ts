/** Real JSONB/required-write evidence; no provider calls or production targets. */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';
import { shouldRunOnIsolatedIntegrationDb } from '../../test/isolated-integration-target';
import { recordSearchBatch } from './batch-audit';
import { SearchCoordinator } from './coordinator';
import { SearchObservations, type SearchObservationSnapshot } from './observations';
import { WebSearchError } from './errors';

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('Provider launch forbidden in DB evidence tests');
  },
}));

describe.runIf(shouldRunOnIsolatedIntegrationDb())(
  'search batch audit in isolated PostgreSQL',
  () => {
    let client: SupabaseClient<Database>;
    const batchIds: string[] = [];
    beforeAll(() => {
      client = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    });
    afterAll(async () => {
      if (!client || !batchIds.length) return;
      const { error } = await client
        .from('audit_log')
        .delete()
        .eq('user_id', INTEGRATION_TEST_USER_ID)
        .in('metadata->>batchId', batchIds);
      expect(error).toBeNull();
    });

    it('round-trips encoded NUL and lone surrogates through the real required recorder and JSONB', async () => {
      const batchId = randomUUID();
      batchIds.push(batchId);
      const raw = 'inert-' + String.fromCharCode(0, 34, 92, 0xd800) + '-end';
      // Negative control: the actual JSONB writer must refuse the unsafe raw
      // string; a green encoded roundtrip cannot be a permissive fake store.
      const rawBatchId = randomUUID();
      batchIds.push(rawBatchId);
      await expect(
        recordSearchBatch({
          accountId: INTEGRATION_TEST_USER_ID,
          batchId: rawBatchId,
          contentRecording: true,
          searchMayHaveRun: true,
          observations: {
            kind: 'unvalidated-stream-observations',
            queryCount: 1,
            hitCount: 0,
            truncated: false,
            malformedLines: 0,
            queries: [{ query: raw, truncated: false }],
          },
        })
      ).rejects.toThrow('Required audit persistence unavailable');
      const observations = new SearchObservations(true);
      observations.observe(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: raw } }] },
        })
      );
      observations.observe(
        JSON.stringify({
          type: 'user',
          tool_use_result: { results: [{ content: [{ title: raw, url: raw }] }] },
        })
      );
      await recordSearchBatch({
        accountId: INTEGRATION_TEST_USER_ID,
        batchId,
        contentRecording: true,
        searchMayHaveRun: true,
        reason: 'invalid_output',
        observations: observations.snapshot(),
      });
      const { data, error } = await client
        .from('audit_log')
        .select('id,user_id,metadata,response_status')
        .eq('metadata->>batchId', batchId)
        .single();
      expect(error).toBeNull();
      expect(data!.user_id).toBe(INTEGRATION_TEST_USER_ID);
      expect(data!.response_status).toBe('error');
      const stored = (data!.metadata as unknown as { observations: SearchObservationSnapshot })
        .observations;
      expect(stored.textEncoding).toBe('json-string-content');
      expect(stored.queryCount).toBe(1);
      expect(stored.hitCount).toBe(1);
      for (const value of [stored.queries![0].query, stored.hits![0].title, stored.hits![0].url]) {
        expect(value).not.toContain(String.fromCharCode(0));
        expect(value).not.toContain(String.fromCharCode(0xd800));
        expect(JSON.parse('"' + value + '"')).toBe(raw);
      }
    });

    it('a real FK refusal remains required and withholds the inert successful result without retry', async () => {
      const missingUser = randomUUID();
      const { data: user, error: lookupError } = await client
        .from('users')
        .select('id')
        .eq('id', missingUser)
        .maybeSingle();
      expect(lookupError).toBeNull();
      expect(user).toBeNull();
      const run = vi.fn(async () => ({
        provider: 'claude' as const,
        model: 'inert',
        searchQueries: ['q'],
        modelToolCallCount: 1,
        items: [{ query: 'q', success: true as const, results: [] }],
      }));
      const coordinator = new SearchCoordinator(run, recordSearchBatch);
      let refusal: (WebSearchError & { batchId?: string }) | undefined;
      try {
        await coordinator.submit({
          accountId: missingUser,
          queries: ['q'],
          maxResults: 1,
          contentRecording: false,
        });
      } catch (error) {
        if (error instanceof WebSearchError) refusal = error;
        else throw error;
      }
      expect(refusal).toMatchObject({ reason: 'audit_unavailable', launched: true });
      expect(refusal!.batchId).toBeTruthy();
      expect(run).toHaveBeenCalledOnce();
      const { data: rows, error } = await client
        .from('audit_log')
        .select('id')
        .eq('metadata->>batchId', refusal!.batchId!);
      expect(error).toBeNull();
      expect(rows).toHaveLength(0);
    });
  }
);
