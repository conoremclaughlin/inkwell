/**
 * An inkling's approval requests, paged against a real database
 * (ink://designs/inkling-approvals-extension §A, Myra's first pass 76c16daa).
 *
 * The unit suite pages over a fake that compares timestamps as strings. This
 * one checks the claim that matters on Postgres itself: created_at keeps
 * microseconds, the cursor carries them through PostgREST unchanged, and
 * paging one row at a time never skips or repeats a request, with equal
 * timestamps and timestamps a few microseconds apart within one millisecond.
 *
 * Run via: yarn test:integration:db:local src/services/inklings/inkling-approvals.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  type EchoIntegrationFixture,
} from '../../test/integration-fixtures';
import { readApprovalsPage } from './inkling-service';

describe('approval requests paged on Postgres', () => {
  let dc: DataComposer;
  let fixture: EchoIntegrationFixture;
  let sbId: string;
  let peerId: string;
  const created: string[] = [];

  const STAMPS = [
    '2026-10-07 08:00:00.637558+00',
    '2026-10-07 08:00:00.637558+00', // equal
    '2026-10-07 08:00:00.637561+00', // 3 µs later, the same millisecond
    '2026-10-07 08:00:00.637999+00',
    '2026-10-07 07:59:59.000001+00',
  ];

  beforeAll(async () => {
    dc = await getDataComposer();
    fixture = await ensureEchoIntegrationFixture(dc);
    sbId = await ensureSuiteIdentity(dc, fixture, 'approvals-paging');
    peerId = await ensureSuiteIdentity(dc, fixture, 'approvals-paging-peer');
    const rows = [
      ...STAMPS.map((created_at) => ({ created_at, sb_id: sbId })),
      // A peer's request in the same millisecond: never on this page.
      { created_at: '2026-10-07 08:00:00.637560+00', sb_id: peerId },
    ];
    for (const row of rows) {
      const { data, error } = await dc
        .getClient()
        .from('approval_requests')
        .insert({
          user_id: fixture.userId,
          workspace_id: fixture.workspaceId,
          requesting_agent_id: 'approvals-paging',
          tool: 'Bash',
          args: 'never shown',
          reason: 'Tool requires explicit per-call confirmation by policy.',
          status: 'pending',
          timeout_seconds: 300,
          expires_at: '2099-01-01T00:00:00Z',
          ...row,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`seed failed: ${error?.message}`);
      created.push(data.id);
    }
  });

  afterAll(async () => {
    if (dc && created.length > 0) {
      await dc.getClient().from('approval_requests').delete().in('id', created);
    }
  });

  it('pages one at a time without skipping or repeating, newest first', async () => {
    const filter = { userId: fixture.userId, workspaceId: fixture.workspaceId, sbId };
    const seen: Array<{ id: string; createdAt: string }> = [];
    let before: string | undefined;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await readApprovalsPage(dc.getClient(), filter, { limit: 1, before }, Date.now);
      seen.push(...page.approvals.map((a) => ({ id: a.id, createdAt: a.createdAt })));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }

    const mine = created.slice(0, STAMPS.length);
    expect(seen).toHaveLength(mine.length);
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(mine));
    // PostgREST returns the microseconds, so the cursor has them to carry.
    expect(seen.map((s) => s.createdAt)).toContain('2026-10-07T08:00:00.637561+00:00');
    // Newest first: each row is no newer than the one before it.
    for (let i = 1; i < seen.length; i += 1) {
      expect(Date.parse(seen[i].createdAt)).toBeLessThanOrEqual(Date.parse(seen[i - 1].createdAt));
    }
  });
});
