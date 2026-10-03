/**
 * InklingService against an in-memory database that evaluates its filters
 * (src/test/fake-postgrest.ts), so a lookup that forgets the person or the
 * workspace finds the wrong rows here too. The redemption function itself
 * is proven on real Postgres in src/data/inkling-awakening-migration.pg.test.ts;
 * the race through the unique index there, the service's handling of losing
 * it here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  InklingError,
  InklingService,
  MAX_DISPLAY_NAME_CODE_POINTS,
  type InklingServiceOptions,
  buildInklingSoul,
  validateDisplayName,
} from './inkling-service';
import { createInklingDb, seedOwnSb, AWAKEN_REQUEST_INDEX } from '../../test/fake-inkling-db';
import { liveInklingTurns, trackInklingTurn } from './inkling-turns';
import type { FakePostgrest, Row } from '../../test/fake-postgrest';

const ME = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
};
const OTHER_WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOMEONE_ELSE = {
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'owner',
};
/** Another person in MY workspace: only the user filter tells their inklings from mine. */
const HOUSEMATE = {
  userId: '33333333-3333-4333-8333-333333333333',
  workspaceId: ME.workspaceId,
  role: 'owner',
};
const REQUEST = '0b6f3c1e-5d1a-4a8e-9c1b-6f0e2d3c4b5a';

// The list is scoped to the person twice: the identity query's user_id and
// the self-serve lineage's child_user_id. Removing either alone changes
// nothing (measured); removing both fails the first test below. readIdentity
// has only its own user filter, and removing it fails the second.
describe('a second person in the same workspace (review bbbbba99, P3)', () => {
  it("does not see my inklings in their list, and I don't see theirs", async () => {
    const mine = await service.awaken(ME, REQUEST);
    const theirs = await as(HOUSEMATE).awaken(HOUSEMATE, '9e8d7c6b-5a49-4382-8170-6f5e4d3c2b1a');
    expect(await service.list(ME)).toEqual([mine.inkling]);
    expect(await service.list(HOUSEMATE)).toEqual([theirs.inkling]);
  });

  it('cannot name my inkling: 404, and the name stays mine to set', async () => {
    const mine = await service.awaken(ME, REQUEST);
    await expect(as(HOUSEMATE).name(HOUSEMATE, mine.inkling.id, 'Theirs')).rejects.toMatchObject({
      status: 404,
    });
    expect(rowsOf('agent_identities')[0].name).toBe('Unnamed inkling');
  });
});

describe('the owner test gate (Lumen 97b1d66a)', () => {
  const closed = { status: 403, code: 'inklings_disabled' };

  it('off: awakening and naming are refused, and nothing is read or written', async () => {
    const mine = await service.awaken(ME, REQUEST); // made while the test was open
    const before = db.log.length;
    const off = new InklingService(db as unknown as SupabaseClient, { ownerTestUserId: null });
    await expect(off.awaken(ME, '3c9d2a7e-8f41-4b6c-9a2d-1e0f5b4c3d2a')).rejects.toMatchObject(
      closed
    );
    await expect(off.name(ME, mine.inkling.id, 'Pip')).rejects.toMatchObject(closed);
    expect(db.log.slice(before)).toEqual([]);
    // Listing stays open: it shows the person's own inklings and starts nothing.
    expect(await off.list(ME)).toEqual([mine.inkling]);
  });

  it('on for one account: anyone else is refused the same way, writing nothing', async () => {
    await expect(service.awaken(SOMEONE_ELSE, REQUEST)).rejects.toMatchObject(closed);
    await expect(service.awaken(HOUSEMATE, REQUEST)).rejects.toMatchObject(closed);
    const mine = await service.awaken(ME, REQUEST);
    await expect(service.name(HOUSEMATE, mine.inkling.id, 'Pip')).rejects.toMatchObject(closed);
    expect(rowsOf('agent_identities')).toHaveLength(1);
  });

  it('the account must act as the workspace owner', async () => {
    for (const role of ['member', 'trusted', 'viewer', undefined]) {
      await expect(service.awaken({ ...ME, role }, REQUEST)).rejects.toMatchObject(closed);
    }
    expect(rowsOf('kindle_tokens')).toHaveLength(0);
  });

  it("matches the account in any letter case, as the env's UUID may be written", async () => {
    const upper = as({ userId: ME.userId.toUpperCase() });
    await expect(upper.awaken(ME, REQUEST)).resolves.toMatchObject({ replayed: false });
  });
});

describe("cancelling an inkling's turn", () => {
  it('stops its live turn, says so, and says so again only if one is running', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const turn = trackInklingTurn(inkling.id);
    expect(await service.cancel(ME, inkling.id)).toEqual({ cancelled: true });
    expect(turn.signal.aborted).toBe(true);
    turn.done();
    expect(liveInklingTurns(inkling.id)).toBe(0);
    expect(await service.cancel(ME, inkling.id)).toEqual({ cancelled: false });
  });

  it('is the owner test only, and the caller’s own inkling only', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const turn = trackInklingTurn(inkling.id);
    const off = new InklingService(db as unknown as SupabaseClient, { ownerTestUserId: null });
    await expect(off.cancel(ME, inkling.id)).rejects.toMatchObject({
      status: 403,
      code: 'inklings_disabled',
    });
    await expect(as(HOUSEMATE).cancel(HOUSEMATE, inkling.id)).rejects.toMatchObject({
      status: 404,
    });
    const myra = seedOwnSb(db, ME, 'myra');
    await expect(service.cancel(ME, String(myra.id))).rejects.toMatchObject({ status: 404 });
    expect(turn.signal.aborted).toBe(false);
    turn.done();
  });
});

describe('an awakening replay hands back only an inkling', () => {
  it('a request id found on an identity that is not an inkling is a 409', async () => {
    db.seed('agent_identities', {
      user_id: ME.userId,
      workspace_id: ME.workspaceId,
      agent_id: 'myra',
      name: 'Myra',
      metadata: { awakenRequestId: REQUEST },
    });
    await expect(service.awaken(ME, REQUEST)).rejects.toMatchObject({ status: 409 });
    expect(rowsOf('kindle_tokens')).toHaveLength(0);
  });
});

let db: FakePostgrest;
let service: InklingService;

beforeEach(() => {
  db = createInklingDb();
  service = as(ME);
});

/** A service whose owner test is open to `who`, as the server's would be for that account. */
function as(who: { userId: string }, options: InklingServiceOptions = {}): InklingService {
  return new InklingService(db as unknown as SupabaseClient, {
    ownerTestUserId: who.userId,
    ...options,
  });
}

function rowsOf(table: string): Row[] {
  return db.rows(table);
}

describe('awaken', () => {
  it('creates one inkling: complete at creation, unnamed, tagged, through a parentless self-serve token', async () => {
    const { inkling, replayed } = await service.awaken(ME, REQUEST);

    expect(replayed).toBe(false);
    expect(inkling).toEqual({
      id: expect.any(String),
      sbSlug: expect.stringMatching(/^kindle-/),
      displayName: null,
      createdAt: expect.any(String),
      nameable: true,
    });

    const [identity] = rowsOf('agent_identities');
    expect(identity).toMatchObject({
      id: inkling.id,
      user_id: ME.userId,
      workspace_id: ME.workspaceId,
      agent_id: inkling.sbSlug,
      name: 'Unnamed inkling',
      created_at: inkling.createdAt,
    });
    expect(identity.metadata).toEqual({
      prototype: true,
      client: 'inkling-mobile',
      awakenRequestId: REQUEST,
      named: false,
      ownerTest: true,
      kindleId: expect.any(String),
      onboarding: false,
    });
    expect(identity.soul).toBe(buildInklingSoul());

    const [lineage] = rowsOf('kindle_lineage');
    expect(lineage).toMatchObject({
      child_sb_id: inkling.id,
      kindle_method: 'self_serve',
      onboarding_status: 'complete',
      parent_agent_id: null,
      parent_user_id: null,
    });
    expect(lineage.completed_at).toEqual(expect.any(String));

    const [token] = rowsOf('kindle_tokens');
    expect(token).toMatchObject({
      creator_user_id: ME.userId,
      creator_agent_id: null,
      status: 'used',
    });
  });

  it('a sequential retry with the same request id returns the same inkling and creates nothing', async () => {
    const first = await service.awaken(ME, REQUEST);
    const second = await service.awaken(ME, REQUEST);

    expect(second).toEqual({ inkling: first.inkling, replayed: true });
    expect(rowsOf('agent_identities')).toHaveLength(1);
    expect(rowsOf('kindle_lineage')).toHaveLength(1);
    // The pre-check answered: no second token was minted, no second redemption ran.
    expect(rowsOf('kindle_tokens')).toHaveLength(1);
    expect(db.log.filter((e) => e.op === 'rpc')).toHaveLength(1);
  });

  // Lumen's probes (345e579e, P2): a UUID's letter case is spelling, not
  // identity, and the stored id is compared as text.
  it('the same request id in capitals is the same request: it replays and creates nothing', async () => {
    const first = await service.awaken(ME, REQUEST);
    const second = await service.awaken(ME, REQUEST.toUpperCase());

    expect(second).toEqual({ inkling: first.inkling, replayed: true });
    expect(rowsOf('agent_identities')).toHaveLength(1);
    expect(rowsOf('kindle_tokens')).toHaveLength(1);
  });

  it('a request id first sent in capitals is stored in lowercase, so the lowercase retry replays', async () => {
    const first = await service.awaken(ME, REQUEST.toUpperCase());
    expect(rowsOf('agent_identities')[0].metadata).toMatchObject({ awakenRequestId: REQUEST });

    const second = await service.awaken(ME, REQUEST);
    expect(second).toEqual({ inkling: first.inkling, replayed: true });
    expect(rowsOf('agent_identities')).toHaveLength(1);
  });

  it('the same request id in capitals from another workspace is still a 409', async () => {
    await service.awaken(ME, REQUEST);
    await expect(
      service.awaken({ ...ME, workspaceId: OTHER_WORKSPACE }, REQUEST.toUpperCase())
    ).rejects.toMatchObject({ status: 409 });
    expect(rowsOf('agent_identities')).toHaveLength(1);
    expect(rowsOf('kindle_tokens')).toHaveLength(1);
  });

  for (const [label, spelling] of [
    ['', REQUEST],
    [' (the loser spelled in capitals)', REQUEST.toUpperCase()],
  ] as const) {
    it(`losing a race to a concurrent retry returns the winner, and revokes the token the loser minted${label}`, async () => {
      // The winner commits after this request's pre-check and before its own
      // redemption: the redemption then fails on the awakenRequestId index.
      const realRedeem = db.rpcHandlers.redeem_kindle_token;
      let raced = false;
      db.rpcHandlers.redeem_kindle_token = (args, fake) => {
        if (!raced) {
          raced = true;
          const winnerToken = fake.seed('kindle_tokens', {
            token: 'winner',
            status: 'active',
            creator_user_id: ME.userId,
            creator_agent_id: null,
          });
          const won = realRedeem({ ...args, p_token: winnerToken.token }, fake);
          expect(won.error).toBeNull();
        }
        return realRedeem(args, fake);
      };

      const result = await service.awaken(ME, spelling);

      expect(result.replayed).toBe(true);
      expect(rowsOf('agent_identities')).toHaveLength(1);
      expect(result.inkling.id).toBe(rowsOf('agent_identities')[0].id);
      const loserToken = rowsOf('kindle_tokens').find((t) => t.token !== 'winner');
      expect(loserToken?.status).toBe('revoked');
    });
  }

  it('the stand-in redemption really fails on the index (the race above is not vacuous)', async () => {
    await service.awaken(ME, REQUEST);
    db.seed('kindle_tokens', {
      token: 'second',
      status: 'active',
      creator_user_id: ME.userId,
      creator_agent_id: null,
    });
    const result = await db.rpc('redeem_kindle_token', {
      p_token: 'second',
      p_new_user_id: ME.userId,
      p_workspace_id: ME.workspaceId,
      p_identity: { metadata: { awakenRequestId: REQUEST } },
      p_kindle_method: 'self_serve',
    });
    expect(result.error?.message).toContain(AWAKEN_REQUEST_INDEX);
  });

  it("the same request id in another workspace is a 409, never the other workspace's inkling", async () => {
    await service.awaken(ME, REQUEST);

    const attempt = service.awaken({ ...ME, workspaceId: OTHER_WORKSPACE }, REQUEST);
    await expect(attempt).rejects.toBeInstanceOf(InklingError);
    await expect(
      service.awaken({ ...ME, workspaceId: OTHER_WORKSPACE }, REQUEST)
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(rowsOf('agent_identities')).toHaveLength(1);
    expect(rowsOf('kindle_tokens')).toHaveLength(1);
  });

  it("another person may use the same request id: lookups are the person's own", async () => {
    const mine = await service.awaken(ME, REQUEST);
    const theirs = await as(SOMEONE_ELSE).awaken(SOMEONE_ELSE, REQUEST);
    expect(theirs.replayed).toBe(false);
    expect(theirs.inkling.id).not.toBe(mine.inkling.id);
  });

  it('a failed redemption with no winner revokes its token and reports the failure', async () => {
    db.rpcHandlers.redeem_kindle_token = () => ({ data: null, error: { message: 'boom' } });

    await expect(service.awaken(ME, REQUEST)).rejects.toThrow(/boom/);
    expect(rowsOf('kindle_tokens')[0].status).toBe('revoked');
    expect(rowsOf('agent_identities')).toHaveLength(0);
  });

  describe('the awakening cap', () => {
    const THIRD = '4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
    const awakenTwo = async () => {
      await service.awaken(ME, REQUEST);
      await service.awaken(ME, '3c9d2a7e-8f41-4b6c-9a2d-1e0f5b4c3d2a');
    };

    it('is 2 by default: a third awakening is a 409 the app can tell apart, and writes nothing', async () => {
      await awakenTwo();
      await expect(service.awaken(ME, THIRD)).rejects.toMatchObject({
        status: 409,
        code: 'awakening_cap_reached',
      });
      expect(rowsOf('agent_identities')).toHaveLength(2);
      // The third request's token was minted, then revoked when the redemption refused it.
      expect(rowsOf('kindle_tokens').map((t) => t.status)).toEqual(['used', 'used', 'revoked']);
    });

    it('a retry of an awakening already made still replays at the cap', async () => {
      await awakenTwo();
      const again = await service.awaken(ME, REQUEST.toUpperCase());
      expect(again.replayed).toBe(true);
    });

    it('a retry that loses its race at the cap answers with the winner, not the cap', async () => {
      service = as(ME, { awakenCap: 1 });
      const realRedeem = db.rpcHandlers.redeem_kindle_token;
      let raced = false;
      db.rpcHandlers.redeem_kindle_token = (args, fake) => {
        if (!raced) {
          raced = true;
          const winnerToken = fake.seed('kindle_tokens', {
            token: 'winner',
            status: 'active',
            creator_user_id: ME.userId,
            creator_agent_id: null,
          });
          expect(realRedeem({ ...args, p_token: winnerToken.token }, fake).error).toBeNull();
        }
        return realRedeem(args, fake); // now at the cap: IK001
      };
      const result = await service.awaken(ME, REQUEST);
      expect(result.replayed).toBe(true);
      expect(rowsOf('agent_identities')).toHaveLength(1);
    });

    it('a null cap passes none, so the database applies none', async () => {
      service = as(ME, { awakenCap: null });
      await awakenTwo();
      await expect(service.awaken(ME, THIRD)).resolves.toMatchObject({ replayed: false });
    });
  });

  it('touches only identity, lineage and token tables: no thread, no message, no wake', async () => {
    await service.awaken(ME, REQUEST);
    const touched = [...new Set(db.log.map((e) => e.table))].sort();
    expect(touched).toEqual(['agent_identities', 'kindle_tokens', 'redeem_kindle_token']);
  });
});

describe('the awakening soul', () => {
  const soul = buildInklingSoul();

  it('has no values interview and proposes no names', () => {
    expect(soul).not.toMatch(/Values Interview/i);
    expect(soul).not.toMatch(/propose 3-4 names/i);
    expect(soul).not.toMatch(/What matters most to you in a collaborator/);
    expect(soul).toMatch(/There's no interview/);
  });

  it('leaves naming to the person and never presses', () => {
    expect(soul).toMatch(/never name you at all/);
    expect(soul).toMatch(/Don't ask for a name, don't suggest names/);
  });

  it("starts with nobody else's memories and claims no feelings it can't have", () => {
    expect(soul).toMatch(/carry nobody else's memories/);
    expect(soul).toMatch(/Don't claim feelings/);
  });
});

describe('list', () => {
  it("lists only the person's inklings in this workspace, oldest first, unnamed as null", async () => {
    // Three awakenings for ME across two workspaces: past the per-person cap,
    // which is not what this test is about.
    service = as(ME, { awakenCap: null });
    seedOwnSb(db, ME, 'myra'); // the account's own SB: never listed
    const first = await service.awaken(ME, REQUEST);
    const second = await service.awaken(ME, '3c9d2a7e-8f41-4b6c-9a2d-1e0f5b4c3d2a');
    await service.awaken(
      { ...ME, workspaceId: OTHER_WORKSPACE },
      '5e8a1b2c-3d4f-4e6a-8b9c-0d1e2f3a4b5c'
    );
    await as(SOMEONE_ELSE).awaken(SOMEONE_ELSE, '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d');

    const listed = await service.list(ME);
    expect(listed).toEqual([first.inkling, second.inkling]);
  });

  it('a tagged identity without a self-serve lineage is not an inkling', async () => {
    db.seed('agent_identities', {
      user_id: ME.userId,
      workspace_id: ME.workspaceId,
      agent_id: 'lookalike',
      name: 'Lookalike',
      metadata: { client: 'inkling-mobile', named: true },
    });
    expect(await service.list(ME)).toEqual([]);
  });

  it('shows the name once named', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    await service.name(ME, inkling.id, 'Pip');
    expect((await service.list(ME))[0]).toMatchObject({ id: inkling.id, displayName: 'Pip' });
  });

  /**
   * `count` tagged identities; every `lookalikeEvery`th (from the fourth) has
   * no self-serve lineage, so is not an inkling. Returns the inklings' ids.
   */
  function seedMany(count: number, lookalikeEvery = 0): string[] {
    const born: string[] = [];
    for (let i = 0; i < count; i++) {
      const identity = db.seed('agent_identities', {
        user_id: ME.userId,
        workspace_id: ME.workspaceId,
        agent_id: `kindle-${i}`,
        name: 'Unnamed inkling',
        metadata: { client: 'inkling-mobile', named: false },
      });
      if (lookalikeEvery > 0 && i % lookalikeEvery === 3) continue;
      db.seed('kindle_lineage', {
        child_sb_id: identity.id,
        child_user_id: ME.userId,
        kindle_method: 'self_serve',
        chosen_name: null,
      });
      born.push(String(identity.id));
    }
    return born; // in creation order, which is not id order
  }

  it("nothing past PostgREST's 1000-row cap is dropped", async () => {
    db.maxRows = 1000;
    const born = seedMany(1050);
    expect(born).toHaveLength(1050);
    const listed = await service.list(ME);
    expect(listed.map((i) => i.id)).toEqual(born);
  });

  it('no request carries an unbounded in-list', async () => {
    db.maxInList = 100;
    const born = seedMany(250);
    expect(born).toHaveLength(250);
    const listed = await service.list(ME);
    expect(listed.map((i) => i.id)).toEqual(born);
  });

  it('a page cut short by a row cap below the page size does not end the read', async () => {
    db.maxRows = 30;
    const born = seedMany(95);
    const listed = await service.list(ME);
    expect(listed.map((i) => i.id)).toEqual(born);
  });

  it('pages keep lookalikes out and the order oldest first, across page boundaries', async () => {
    db.maxRows = 1000;
    db.maxInList = 100;
    const born = seedMany(340, 7);
    expect(rowsOf('agent_identities')).toHaveLength(340);
    expect(born).toHaveLength(340 - 49); // i % 7 === 3 for 49 of 0..339
    const listed = await service.list(ME);
    expect(listed.map((i) => i.id)).toEqual(born);
  });
});

describe('validateDisplayName', () => {
  it('counts code points: 32 CJK characters pass, 33 fail', () => {
    const name32 = '墨'.repeat(MAX_DISPLAY_NAME_CODE_POINTS);
    expect(validateDisplayName(name32)).toEqual({ ok: true, value: name32 });
    expect(validateDisplayName(name32 + '墨')).toMatchObject({ ok: false });
    // An astral character is one code point, though two UTF-16 units.
    const emoji32 = '🦋'.repeat(32);
    expect(emoji32.length).toBe(64);
    expect(validateDisplayName(emoji32)).toEqual({ ok: true, value: emoji32 });
  });

  it('trims, and refuses empty, non-string and control characters', () => {
    expect(validateDisplayName('  小墨  ')).toEqual({ ok: true, value: '小墨' });
    for (const bad of [
      '',
      '   ',
      42,
      null,
      'Pi\u0000p',
      'Pi\np',
      'Pi\u007fp',
      'Pi\u2028p',
      'Pi\ud800p',
    ]) {
      expect(validateDisplayName(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('refuses a name with no visible character (review bbbbba99, P3)', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const zeroWidthJoiner = String.fromCodePoint(0x200d);
    const hangulFiller = String.fromCodePoint(0x3164);
    for (const invisible of [
      zeroWidthSpace,
      zeroWidthSpace + zeroWidthJoiner,
      hangulFiller,
      ` ${zeroWidthSpace} `,
    ]) {
      expect(validateDisplayName(invisible), JSON.stringify(invisible)).toMatchObject({
        ok: false,
      });
    }
    // One visible character among them is a name.
    expect(validateDisplayName(`Pip${zeroWidthSpace}`)).toMatchObject({ ok: true });
  });

  it('keeps joiners inside emoji sequences', () => {
    expect(validateDisplayName('👩‍🎨')).toEqual({ ok: true, value: '👩‍🎨' });
  });
});

describe('name', () => {
  it('sets the display name, records the chosen name, and never touches the slug', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);

    const named = await service.name(ME, inkling.id, '小墨');

    expect(named).toEqual({ ...inkling, displayName: '小墨' });
    const [identity] = rowsOf('agent_identities');
    expect(identity.agent_id).toBe(inkling.sbSlug);
    expect(identity.name).toBe('小墨');
    expect(identity.metadata).toMatchObject({ named: true, awakenRequestId: REQUEST });
    expect(rowsOf('kindle_lineage')[0].chosen_name).toBe('小墨');
  });

  it('is idempotent: the same name again writes nothing and answers the same', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const first = await service.name(ME, inkling.id, 'Pip');
    const writes = db.log.filter((e) => e.op === 'update').length;

    const again = await service.name(ME, inkling.id, 'Pip');

    expect(again).toEqual(first);
    expect(db.log.filter((e) => e.op === 'update').length).toBe(writes);
  });

  it('renames later, any number of times; the slug stays', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    await service.name(ME, inkling.id, 'Pip');
    const renamed = await service.name(ME, inkling.id, 'Wick');
    expect(renamed).toMatchObject({ id: inkling.id, sbSlug: inkling.sbSlug, displayName: 'Wick' });
    expect(rowsOf('kindle_lineage')[0].chosen_name).toBe('Wick');
  });

  it('409s for an identity that was not born through this flow: the app can never rename Myra', async () => {
    const myra = seedOwnSb(db, ME, 'myra');
    await expect(service.name(ME, myra.id as string, 'Not Myra')).rejects.toMatchObject({
      status: 409,
    });
    expect(rowsOf('agent_identities').find((r) => r.id === myra.id)?.name).toBe('Myra');
  });

  it("404s for an unknown id, another person's inkling, or another workspace", async () => {
    const theirs = await as(SOMEONE_ELSE).awaken(SOMEONE_ELSE, REQUEST);
    const mine = await service.awaken(ME, REQUEST);

    for (const [scope, id] of [
      [ME, theirs.inkling.id],
      [ME, '99999999-9999-4999-8999-999999999999'],
      [ME, 'not-a-uuid'],
      [{ ...ME, workspaceId: OTHER_WORKSPACE }, mine.inkling.id],
    ] as const) {
      await expect(service.name(scope, id, 'Pip')).rejects.toMatchObject({ status: 404 });
    }
    expect(rowsOf('agent_identities').every((r) => r.name === 'Unnamed inkling')).toBe(true);
  });

  it('a concurrent metadata write is kept, not clobbered: the losing write re-reads and retries', async () => {
    const { inkling } = await service.awaken(ME, REQUEST);
    const identity = rowsOf('agent_identities')[0];
    const identityReads = () =>
      db.log.filter((e) => e.table === 'agent_identities' && e.op === 'select').length;
    const readsBeforeNaming = identityReads();
    const originalFrom = db.from.bind(db);
    let interleaved = false;
    db.from = (table: string) => {
      // After naming has read the row and before it writes, someone saves
      // runtimeConfig on the same identity.
      if (table === 'agent_identities' && !interleaved && identityReads() > readsBeforeNaming) {
        interleaved = true;
        identity.metadata = { ...(identity.metadata as Row), runtimeConfig: { model: 'x' } };
        identity.updated_at = db.now();
      }
      return originalFrom(table);
    };

    await service.name(ME, inkling.id, 'Pip');

    expect(interleaved).toBe(true);
    expect(identity.name).toBe('Pip');
    expect(identity.metadata).toMatchObject({ named: true, runtimeConfig: { model: 'x' } });
  });
});
