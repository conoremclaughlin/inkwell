/**
 * An inkling's approval requests, read-only (ink://designs/inkling-approvals-
 * extension §A, Myra's first pass 76c16daa).
 *
 * The same reader as the profile; only requests whose requester was recorded
 * from a signed token; an allowlist of fields; every stored status mapped,
 * with a pending request past its deadline shown as expired; a keyset cursor
 * that keeps Postgres's microseconds.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  APPROVALS_PAGE_MAX,
  APPROVAL_PURPOSE_MAX,
  InklingService,
  approvalPurpose,
  approvalStatus,
  decodeApprovalCursor,
  encodeApprovalCursor,
} from './inkling-service';
import { createInklingDb, seedOwnSb } from '../../test/fake-inkling-db';
import type { FakePostgrest, Row } from '../../test/fake-postgrest';

const ME = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
};
const HOUSEMATE = {
  userId: '33333333-3333-4333-8333-333333333333',
  workspaceId: ME.workspaceId,
  role: 'owner',
};
const REQUEST = '0b6f3c1e-5d1a-4a8e-9c1b-6f0e2d3c4b5a';
const NOW = Date.parse('2026-10-07T09:00:00.000Z');

let db: FakePostgrest;
let service: InklingService;

beforeEach(() => {
  db = createInklingDb();
  service = new InklingService(db as unknown as SupabaseClient, {
    ownerTestUserIds: new Set([ME.userId, HOUSEMATE.userId]),
  });
});

function request(over: Row): Row {
  return db.seed('approval_requests', {
    user_id: ME.userId,
    workspace_id: ME.workspaceId,
    requesting_agent_id: 'ignored-header-slug',
    tool: 'Bash',
    args: '{"command":"cat ~/.secret"}',
    reason: 'Tool requires explicit per-call confirmation by policy.',
    status: 'pending',
    granted_tools: ['Bash'],
    granted_by: 'telegram:someone',
    metadata: { origin: { origin: 'clone' } },
    session_id: '44444444-4444-4444-8444-444444444444',
    studio_id: '55555555-5555-4555-8555-555555555555',
    timeout_seconds: 300,
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
    resolved_at: null,
    ...over,
  });
}

const call = (id: string, opts: { limit?: number; before?: string } = {}) =>
  service.approvals(ME, id, opts, () => NOW);

describe('which requests are listed', () => {
  it("lists only this inkling's requests recorded with a signed requester, newest first", async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const peer = await service.awaken(ME, '9e8d7c6b-5a49-4382-8170-6f5e4d3c2b1a');
    const older = request({ sb_id: inkling.id, created_at: '2026-10-07T08:00:00.000001+00:00' });
    const newer = request({ sb_id: inkling.id, created_at: '2026-10-07T08:30:00.000001+00:00' });
    request({ sb_id: peer.inkling.id }); // another of my inklings
    request({ sb_id: null, requesting_agent_id: 'kindle-mine' }); // legacy: header slug only
    request({ sb_id: inkling.id, user_id: HOUSEMATE.userId }); // not my row
    request({ sb_id: inkling.id, workspace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });

    const page = await call(inkling.id);
    expect(page.approvals.map((a) => a.id)).toEqual([newer.id, older.id]);
    expect(page.nextBefore).toBeNull();
  });

  it('returns exactly the allowlisted fields: never the input, the grant or who decided', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    request({ sb_id: inkling.id });
    const [approval] = (await call(inkling.id)).approvals;
    expect(Object.keys(approval).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'purpose',
      'resolvedAt',
      'status',
      'tool',
    ]);
    expect(JSON.stringify(approval)).not.toMatch(/secret|telegram|clone|4444|5555/);
  });

  it("is the same 404 as the profile for anything that isn't one of my inklings", async () => {
    const theirs = await service.awaken(HOUSEMATE, '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d');
    const agent = seedOwnSb(db, ME, 'myra');
    for (const id of ['not-a-uuid', theirs.inkling.id, agent.id as string]) {
      await expect(call(id)).rejects.toMatchObject({
        status: 404,
        message: 'No inkling with that id',
      });
    }
  });
});

describe('status', () => {
  it('maps every stored value, and shows pending past its deadline as expired', () => {
    const later = new Date(NOW + 1).toISOString();
    expect(approvalStatus({ status: 'pending', expires_at: later }, NOW)).toBe('pending');
    // Inclusive, on the Node clock, as the interceptor reads it.
    expect(
      approvalStatus({ status: 'pending', expires_at: new Date(NOW).toISOString() }, NOW)
    ).toBe('expired');
    for (const stored of ['granted', 'denied', 'expired', 'cancelled'] as const) {
      expect(approvalStatus({ status: stored, expires_at: later }, NOW)).toBe(stored);
    }
    expect(approvalStatus({ status: 'approved', expires_at: later }, NOW)).toBe('unknown');
    expect(approvalStatus({ status: '<script>', expires_at: later }, NOW)).toBe('unknown');
  });
});

describe('purpose', () => {
  it('is the reason, null when blank, and cut by code points so a pair is never split', () => {
    expect(approvalPurpose(null)).toBeNull();
    expect(approvalPurpose('   ')).toBeNull();
    expect(approvalPurpose('Tool requires confirmation.')).toBe('Tool requires confirmation.');
    const long = 'a'.repeat(APPROVAL_PURPOSE_MAX - 2) + '😀😀😀';
    const cut = approvalPurpose(long)!;
    expect(Array.from(cut)).toHaveLength(APPROVAL_PURPOSE_MAX);
    expect(cut.endsWith('😀…')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('paging', () => {
  it('never skips or repeats a row: equal timestamps, and microseconds within one millisecond', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const stamps = [
      '2026-10-07T08:00:00.637558+00:00',
      '2026-10-07T08:00:00.637558+00:00', // equal
      '2026-10-07T08:00:00.637561+00:00', // 3 µs later, same millisecond
      '2026-10-07T08:00:00.637999+00:00',
      '2026-10-07T07:59:59.000001+00:00',
    ];
    const seeded = stamps.map((created_at) => request({ sb_id: inkling.id, created_at }));

    const seen: string[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await call(inkling.id, { limit: 1, before });
      seen.push(...page.approvals.map((a) => a.id));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(seen).toHaveLength(seeded.length);
    expect(new Set(seen).size).toBe(seeded.length);
    // Newest first by (created_at, id).
    const expected = [...seeded]
      .sort((a, b) =>
        String(b.created_at) === String(a.created_at)
          ? String(b.id).localeCompare(String(a.id))
          : String(b.created_at).localeCompare(String(a.created_at))
      )
      .map((r) => r.id);
    expect(seen).toEqual(expected);
  });

  it('carries the timestamp exactly as Postgres returned it, microseconds included', () => {
    const cursor = encodeApprovalCursor({
      created_at: '2026-10-07T08:00:00.637558+00:00',
      id: '66666666-6666-4666-8666-666666666666',
    });
    expect(decodeApprovalCursor(cursor)).toEqual({
      createdAt: '2026-10-07T08:00:00.637558+00:00',
      id: '66666666-6666-4666-8666-666666666666',
    });
  });

  it('refuses a cursor it did not make', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    for (const before of ['nope', Buffer.from('{"c":1}').toString('base64url'), '']) {
      await expect(call(inkling.id, { before })).rejects.toMatchObject({ status: 400 });
    }
  });

  it('clamps the page size', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    for (let i = 0; i < APPROVALS_PAGE_MAX + 3; i += 1) request({ sb_id: inkling.id });
    expect((await call(inkling.id, { limit: 1000 })).approvals).toHaveLength(APPROVALS_PAGE_MAX);
    expect((await call(inkling.id, { limit: 0 })).approvals).toHaveLength(1);
    expect((await call(inkling.id, { limit: Number.NaN })).approvals).toHaveLength(20);
  });
});
