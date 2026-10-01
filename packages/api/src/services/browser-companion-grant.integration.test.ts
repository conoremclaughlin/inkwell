/**
 * Browser companion grants against a real database.
 *
 * The unit suites hand-port `browser_companion_consume_grant` and record the
 * claim's predicates, which proves the router and service react correctly to
 * each outcome. They cannot show that the SQL produces those outcomes, and
 * they cannot see the retire trigger or the CHECK at all. This suite runs all
 * of it: the function's refusal ordering, the claim UPDATE's own predicate,
 * the trigger that retires a revoked secret, and the constraint behind it.
 *
 * Every refusal has a positive control through the same fixture, so a refusal
 * is never an artifact of a grant that could not have been allowed anyway.
 *
 * Run through the isolated stack only:
 *   yarn test:integration:db:local
 * Running this config directly loads .env.local (src/test/setup.ts), which
 * points at the shared local database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import express from 'express';
import type { Server } from 'http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDataComposer } from '../data/composer';
import { ensureEchoIntegrationFixture } from '../test/integration-fixtures';
import { BrowserCompanionGrantService } from './browser-companion-grant.service';
import { createBrowserCompanionRouter } from '../routes/browser-companion';
import {
  signBrowserClientToken,
  type BrowserClientTokenPayload,
} from '../auth/browser-client-tokens';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface PairedGrant {
  grantId: string;
  installationId: string;
  installationSecret: string;
  pairingCode: string;
  pairingSecret: string;
}

interface GrantRow {
  pairing_code_hash: string | null;
  pairing_secret_hash: string | null;
  revoked_secret_hash: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

describe('browser companion grants (real SQL)', () => {
  // The generated Database type does not carry these tables until types are
  // regenerated after the migration lands, so direct fixture access is
  // untyped here, as it is in the service.
  let db: SupabaseClient;
  let grants: BrowserCompanionGrantService;
  let userId: string;
  let workspaceId: string;
  const createdGrantIds: string[] = [];

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    db = dataComposer.getClient() as unknown as SupabaseClient;
    grants = new BrowserCompanionGrantService(dataComposer.getClient());
  });

  afterAll(async () => {
    if (createdGrantIds.length > 0) {
      // Events go with their grant (ON DELETE CASCADE).
      await db.from('browser_companion_grants').delete().in('id', createdGrantIds);
    }
  });

  async function mint(): Promise<Omit<PairedGrant, 'pairingSecret'>> {
    const installationId = `it-installation-${randomUUID()}`;
    const installationSecret = crypto.randomBytes(32).toString('hex');
    const { grantId, pairingCode } = await grants.createPairingCode({
      userId,
      workspaceId,
      installationId,
      installationCommitment: sha256(installationSecret),
    });
    createdGrantIds.push(grantId);
    return { grantId, installationId, installationSecret, pairingCode };
  }

  async function pair(): Promise<PairedGrant> {
    const minted = await mint();
    const claim = await grants.claimPairingCode({
      pairingCode: minted.pairingCode,
      installationId: minted.installationId,
      installationSecret: minted.installationSecret,
    });
    if (!claim.ok) throw new Error(`fixture claim refused: ${claim.reason}`);
    return { ...minted, pairingSecret: claim.pairingSecret };
  }

  function claimsFor(
    grant: Pick<PairedGrant, 'grantId' | 'installationId'>,
    overrides: Partial<BrowserClientTokenPayload> = {}
  ): BrowserClientTokenPayload {
    return {
      type: 'browser_client',
      sub: userId,
      workspaceId,
      installationId: grant.installationId,
      grantId: grant.grantId,
      ...overrides,
    };
  }

  async function readRow(grantId: string): Promise<GrantRow> {
    const { data, error } = await db
      .from('browser_companion_grants')
      .select(
        'pairing_code_hash, pairing_secret_hash, revoked_secret_hash, revoked_at, last_used_at'
      )
      .eq('id', grantId)
      .single();
    if (error) throw new Error(`grant read failed: ${error.message}`);
    return data as GrantRow;
  }

  async function events(
    grantId: string
  ): Promise<Array<{ event: string; reason_code: string | null }>> {
    const { data, error } = await db
      .from('browser_companion_grant_events')
      .select('event, reason_code, at')
      .eq('grant_id', grantId)
      .order('at', { ascending: true });
    if (error) throw new Error(`event read failed: ${error.message}`);
    return (data ?? []).map((row) => ({ event: row.event, reason_code: row.reason_code }));
  }

  async function setPast(grantId: string, column: 'expires_at' | 'pairing_code_expires_at') {
    const { error } = await db
      .from('browser_companion_grants')
      .update({ [column]: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', grantId);
    if (error) throw new Error(`fixture update of ${column} failed: ${error.message}`);
  }

  // -------------------------------------------------------------------------
  describe('browser_companion_consume_grant', () => {
    it('CONTROL: a claimed, live grant with every binding matching is allowed', async () => {
      const grant = await pair();
      expect((await readRow(grant.grantId)).last_used_at).toBeNull();

      const check = await grants.checkGrant(claimsFor(grant), { requireLive: true });

      expect(check).toMatchObject({ ok: true, revokedAt: null });
      expect((await readRow(grant.grantId)).last_used_at).not.toBeNull();
    });

    it('refuses a grant id that does not exist, without an event row to hang it on', async () => {
      const check = await grants.checkGrant(
        claimsFor({ grantId: randomUUID(), installationId: 'it-nobody' }),
        { requireLive: true }
      );
      expect(check).toMatchObject({ ok: false, reason: 'grant_not_found' });
    });

    it('refuses a grant that was never claimed', async () => {
      const minted = await mint();
      const check = await grants.checkGrant(claimsFor(minted), { requireLive: true });
      expect(check).toMatchObject({ ok: false, reason: 'grant_unclaimed' });
    });

    it.each([
      ['user_mismatch', () => ({ sub: randomUUID() })],
      ['workspace_mismatch', () => ({ workspaceId: randomUUID() })],
      ['installation_mismatch', () => ({ installationId: `it-other-${randomUUID()}` })],
    ] as const)('refuses %s and records it as fields', async (reason, override) => {
      const grant = await pair();

      const check = await grants.checkGrant(claimsFor(grant, override()), { requireLive: true });

      expect(check).toMatchObject({ ok: false, reason });
      expect(await events(grant.grantId)).toContainEqual({ event: 'refused', reason_code: reason });
    });

    it('refuses a revoked grant when liveness is required, and allows it on the revocation path', async () => {
      const grant = await pair();
      await grants.revokeGrant(grant.grantId);

      await expect(
        grants.checkGrant(claimsFor(grant), { requireLive: true })
      ).resolves.toMatchObject({ ok: false, reason: 'grant_revoked' });
      await expect(
        grants.checkGrant(claimsFor(grant), { requireLive: false })
      ).resolves.toMatchObject({ ok: true });
    });

    it('refuses an expired grant with no sweep, and allows it on the revocation path', async () => {
      const grant = await pair();
      await setPast(grant.grantId, 'expires_at');

      await expect(
        grants.checkGrant(claimsFor(grant), { requireLive: true })
      ).resolves.toMatchObject({ ok: false, reason: 'grant_expired' });
      await expect(
        grants.checkGrant(claimsFor(grant), { requireLive: false })
      ).resolves.toMatchObject({ ok: true });
    });

    it('the revocation path never skips identity, even on a revoked and expired grant', async () => {
      const grant = await pair();
      await grants.revokeGrant(grant.grantId);
      await setPast(grant.grantId, 'expires_at');
      const foreign = claimsFor(grant, { installationId: `it-other-${randomUUID()}` });

      for (const requireLive of [true, false]) {
        await expect(grants.checkGrant(foreign, { requireLive })).resolves.toMatchObject({
          ok: false,
          reason: 'installation_mismatch',
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the claim UPDATE', () => {
    it('refuses the right code with the wrong installation secret, and does not burn the code', async () => {
      const minted = await mint();

      const wrong = await grants.claimPairingCode({
        pairingCode: minted.pairingCode,
        installationId: minted.installationId,
        installationSecret: crypto.randomBytes(32).toString('hex'),
      });
      expect(wrong).toEqual({ ok: false, reason: 'invalid_or_expired_code' });

      // CONTROL: the same code, with the preimage, still claims.
      const right = await grants.claimPairingCode({
        pairingCode: minted.pairingCode,
        installationId: minted.installationId,
        installationSecret: minted.installationSecret,
      });
      expect(right).toMatchObject({ ok: true, grantId: minted.grantId });
    });

    it('refuses the right secret from a different installation id', async () => {
      const minted = await mint();
      const claim = await grants.claimPairingCode({
        pairingCode: minted.pairingCode,
        installationId: `it-other-${randomUUID()}`,
        installationSecret: minted.installationSecret,
      });
      expect(claim).toEqual({ ok: false, reason: 'invalid_or_expired_code' });
    });

    it('is single-use', async () => {
      const grant = await pair();
      const again = await grants.claimPairingCode({
        pairingCode: grant.pairingCode,
        installationId: grant.installationId,
        installationSecret: grant.installationSecret,
      });
      expect(again).toEqual({ ok: false, reason: 'invalid_or_expired_code' });
    });

    it('refuses an expired code', async () => {
      const minted = await mint();
      await setPast(minted.grantId, 'pairing_code_expires_at');
      const claim = await grants.claimPairingCode({
        pairingCode: minted.pairingCode,
        installationId: minted.installationId,
        installationSecret: minted.installationSecret,
      });
      expect(claim).toEqual({ ok: false, reason: 'invalid_or_expired_code' });
    });
  });

  // -------------------------------------------------------------------------
  describe('revocation retires the secret', () => {
    it('moves the secret hash to the tombstone and clears the live one', async () => {
      const grant = await pair();
      const before = await readRow(grant.grantId);
      expect(before.pairing_secret_hash).toBe(sha256(grant.pairingSecret));
      expect(before.revoked_secret_hash).toBeNull();

      await grants.revokeGrant(grant.grantId);

      const after = await readRow(grant.grantId);
      expect(after).toMatchObject({
        pairing_secret_hash: null,
        pairing_code_hash: null,
        revoked_secret_hash: sha256(grant.pairingSecret),
      });
      expect(after.revoked_at).not.toBeNull();
    });

    it('a retired secret resolves for revocation and for nothing else', async () => {
      const grant = await pair();
      const lookup = { pairingSecret: grant.pairingSecret, installationId: grant.installationId };

      // CONTROL: both lookups find the live secret.
      await expect(grants.resolveGrantForSecret(lookup)).resolves.toMatchObject({ ok: true });
      await expect(grants.resolveGrantForRevocation(lookup)).resolves.toMatchObject({ ok: true });

      await grants.revokeGrant(grant.grantId);

      await expect(grants.resolveGrantForSecret(lookup)).resolves.toEqual({
        ok: false,
        reason: 'invalid_secret',
      });
      await expect(grants.resolveGrantForRevocation(lookup)).resolves.toMatchObject({
        ok: true,
        grantId: grant.grantId,
      });
    });

    it('a repeated revoke changes nothing and logs one revocation', async () => {
      const grant = await pair();

      await expect(grants.revokeGrant(grant.grantId)).resolves.toBe('revoked');
      const first = await readRow(grant.grantId);
      await expect(grants.revokeGrant(grant.grantId)).resolves.toBe('already_revoked');
      const second = await readRow(grant.grantId);

      expect(second.revoked_at).toBe(first.revoked_at);
      expect(second.revoked_secret_hash).toBe(first.revoked_secret_hash);
      const revocations = (await events(grant.grantId)).filter((e) => e.event === 'revoked');
      expect(revocations).toEqual([{ event: 'revoked', reason_code: 'user_revoked' }]);
    });

    it('the CHECK refuses a write that would bring a revoked secret back', async () => {
      const grant = await pair();
      await grants.revokeGrant(grant.grantId);

      const { error } = await db
        .from('browser_companion_grants')
        .update({ pairing_secret_hash: sha256('a-resurrected-secret') })
        .eq('id', grant.grantId);

      expect(error?.code).toBe('23514');
      expect((await readRow(grant.grantId)).pairing_secret_hash).toBeNull();
    });

    it('CONTROL: the same write is accepted on a grant that is not revoked', async () => {
      const grant = await pair();
      const { error } = await db
        .from('browser_companion_grants')
        .update({ pairing_secret_hash: sha256('a-rotated-secret') })
        .eq('id', grant.grantId);
      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the router, on the real database', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const dataComposer = await getDataComposer();
      const app = express();
      app.use(express.json());
      app.use('/api/browser-companion', createBrowserCompanionRouter(dataComposer.getClient()));
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      baseUrl = `http://127.0.0.1:${address.port}/api/browser-companion`;
    });

    afterAll(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
    });

    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      });

    const getSession = (token: string) =>
      fetch(`${baseUrl}/session`, { headers: { authorization: `Bearer ${token}` } });

    const tokenFor = (grant: PairedGrant, installationId = grant.installationId) =>
      signBrowserClientToken({ userId, workspaceId, installationId, grantId: grant.grantId });

    const secretBody = (grant: PairedGrant) => ({
      pairingSecret: grant.pairingSecret,
      installationId: grant.installationId,
    });

    it('CONTROL: before revocation the secret mints and the token reads the session', async () => {
      const grant = await pair();
      expect((await post('/auth/token', secretBody(grant))).status).toBe(200);
      expect((await getSession(tokenFor(grant))).status).toBe(200);
    });

    it('a repeated revoke with the pairing secret answers exactly as the first did', async () => {
      const grant = await pair();

      const first = await post('/auth/revoke', secretBody(grant));
      const second = await post('/auth/revoke', secretBody(grant));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
    });

    it('a repeated revoke with the JWT answers exactly as the first did', async () => {
      const grant = await pair();
      const token = tokenFor(grant);

      const first = await post('/auth/revoke', {}, token);
      const second = await post('/auth/revoke', {}, token);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
    });

    it('a revoke by JWT whose acknowledgement was lost can be confirmed with the secret', async () => {
      // The case the tombstone exists for: the 300 s token has lapsed by the
      // time the extension retries, so the retry carries the secret.
      const grant = await pair();
      expect((await post('/auth/revoke', {}, tokenFor(grant))).status).toBe(200);

      const retry = await post('/auth/revoke', secretBody(grant));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ revoked: true, grantId: grant.grantId });

      const revocations = (await events(grant.grantId)).filter((e) => e.event === 'revoked');
      expect(revocations).toHaveLength(1);
    });

    it('a revoked grant mints nothing and reads nothing, whichever credential is presented', async () => {
      const grant = await pair();
      const token = tokenFor(grant);
      await post('/auth/revoke', secretBody(grant));

      const mint = await post('/auth/token', secretBody(grant));
      expect(mint.status).toBe(401);
      expect(await mint.json()).toEqual({ error: 'invalid_secret' });

      const session = await getSession(token);
      expect(session.status).toBe(403);
      expect(await session.json()).toEqual({ error: 'grant_not_live', reason: 'grant_revoked' });
    });

    it('revokes an expired grant with the secret, where the token path refuses it', async () => {
      const grant = await pair();
      await setPast(grant.grantId, 'expires_at');

      const mint = await post('/auth/token', secretBody(grant));
      expect(mint.status).toBe(403);
      expect(await mint.json()).toEqual({ error: 'grant_not_live', reason: 'grant_expired' });

      expect((await post('/auth/revoke', secretBody(grant))).status).toBe(200);
      expect((await readRow(grant.grantId)).revoked_at).not.toBeNull();
    });

    it('refuses to revoke from a token bound to a different installation, and leaves the grant live', async () => {
      const grant = await pair();
      const foreign = tokenFor(grant, `it-other-${randomUUID()}`);

      const res = await post('/auth/revoke', {}, foreign);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'grant_not_owned',
        reason: 'installation_mismatch',
      });
      expect((await readRow(grant.grantId)).revoked_at).toBeNull();
    });

    it("refuses a secret presented with another installation's id", async () => {
      const grant = await pair();
      const res = await post('/auth/revoke', {
        pairingSecret: grant.pairingSecret,
        installationId: `it-other-${randomUUID()}`,
      });
      expect(res.status).toBe(401);
      expect((await readRow(grant.grantId)).revoked_at).toBeNull();
    });
  });
});
