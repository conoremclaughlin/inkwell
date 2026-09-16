/**
 * The routing hold's persisted keys, checked against the SQL that reads them.
 *
 * The existing boundary test asserts the exact p_hold keys, and it still did
 * not catch the agentId -> sbSlug rename: the sweep renamed the production
 * object AND the expectation in the same pass, so both sides moved together and
 * the suite stayed green while five SQL functions went on reading a key that no
 * longer existed. Routing holds would never clear, silently.
 *
 * So this test does not assert what I believe the keys are. It reads them out
 * of the migrations and requires the payload to satisfy them. Renaming either
 * side alone fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { stampRoutingHold } from './routing-hold';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS = join(__dirname, '../../../../supabase/migrations');

/** Every key any migration reads out of metadata -> 'routingHold'. */
function keysReadBySql(): string[] {
  const keys = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(/'routingHold'\s*->>\s*'([A-Za-z_]+)'/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

async function capturePayload(): Promise<Record<string, unknown>> {
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  await stampRoutingHold(
    { rpc } as never,
    {
      threadId: 't-1',
      userId: 'u-1',
      sbSlug: 'wren',
      attemptStartedAt: '2026-08-19T02:00:00.000Z',
      now: '2026-08-19T02:00:05.000Z',
      detail: { reason: 'no-route', triedCallerRepo: true, callerRepoRoot: '/repos/inkwell' },
    } as never
  );
  return rpc.mock.calls[0][1].p_hold as Record<string, unknown>;
}

describe('routingHold payload satisfies the SQL that reads it', () => {
  it('finds the keys the migrations actually read', () => {
    // Guard the guard: if this ever reads zero keys, every assertion below is
    // vacuously true and this file stops testing anything.
    const keys = keysReadBySql();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('agentId');
  });

  it('writes every key the SQL reads', async () => {
    const payload = await capturePayload();
    for (const key of keysReadBySql()) {
      expect(Object.keys(payload)).toContain(key);
    }
  });

  it('carries the slug under the key the SQL matches on', async () => {
    const payload = await capturePayload();

    // The clear is `metadata -> 'routingHold' ->> 'agentId' = p_agent_id`, so
    // this key holds the slug regardless of what the TypeScript variable is
    // called. Renaming it in code alone makes holds unclearable.
    expect(payload.agentId).toBe('wren');
    expect(payload).not.toHaveProperty('sbSlug');
  });
});
