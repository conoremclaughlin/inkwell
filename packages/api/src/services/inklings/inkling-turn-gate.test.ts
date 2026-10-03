import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';
import { claimInklingTurn } from './inkling-turn-gate';

const OWNER = '11111111-1111-4111-8111-111111111111';
let db: FakePostgrest;
let inkling: Row;
const client = () => db as unknown as SupabaseClient;
const turnsUsed = () => (inkling.metadata as Row).ownerTestTurns;

beforeEach(() => {
  db = new FakePostgrest();
  inkling = db.seed('agent_identities', {
    user_id: OWNER,
    metadata: { client: 'inkling-mobile', ownerTest: true, runtimeConfig: { model: 'x' } },
  });
});

/** Another writer changes the row between this claim's read and its write, `times` times. */
function interveneOnUpdate(times: number): void {
  const from = db.from.bind(db);
  let left = times;
  db.from = ((table: string) => {
    const query = from(table);
    const update = query.update.bind(query);
    query.update = ((patch: Row) => {
      if (left-- > 0) {
        inkling.metadata = {
          ...(inkling.metadata as Row),
          ownerTestTurns: Number((inkling.metadata as Row).ownerTestTurns ?? 0) + 1,
        };
        inkling.updated_at = db.now();
      }
      return update(patch);
    }) as never;
    return query;
  }) as never;
}

describe('claimInklingTurn: the per-inkling turn cap', () => {
  it('counts each turn and refuses the one past the cap, keeping other metadata', async () => {
    expect(await claimInklingTurn(client(), String(inkling.id), OWNER, 2)).toEqual({
      allowed: true,
      used: 1,
    });
    expect(await claimInklingTurn(client(), String(inkling.id), OWNER, 2)).toEqual({
      allowed: true,
      used: 2,
    });
    expect(await claimInklingTurn(client(), String(inkling.id), OWNER, 2)).toEqual({
      allowed: false,
      used: 2,
    });
    expect(turnsUsed()).toBe(2);
    expect((inkling.metadata as Row).runtimeConfig).toEqual({ model: 'x' });
  });

  it('a claim that loses a race to another turn re-reads: neither count is lost', async () => {
    interveneOnUpdate(1);
    const claim = await claimInklingTurn(client(), String(inkling.id), OWNER, 5);
    expect(claim).toEqual({ allowed: true, used: 2 });
    expect(turnsUsed()).toBe(2);
  });

  it('the last turn cannot be taken twice: losing the race for it is a refusal', async () => {
    inkling.metadata = { ...(inkling.metadata as Row), ownerTestTurns: 1 };
    interveneOnUpdate(1); // the other turn takes the last slot first
    expect(await claimInklingTurn(client(), String(inkling.id), OWNER, 2)).toEqual({
      allowed: false,
      used: 2,
    });
    expect(turnsUsed()).toBe(2);
  });

  it('an unreadable identity, another account, or endless contention is refused, never run', async () => {
    expect((await claimInklingTurn(client(), 'missing', OWNER, 5)).allowed).toBe(false);
    expect(
      (
        await claimInklingTurn(
          client(),
          String(inkling.id),
          '22222222-2222-4222-8222-222222222222',
          5
        )
      ).allowed
    ).toBe(false);
    interveneOnUpdate(100);
    expect((await claimInklingTurn(client(), String(inkling.id), OWNER, 1000)).allowed).toBe(false);
  });
});
