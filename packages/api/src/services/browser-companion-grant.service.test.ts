/**
 * The storage boundary.
 *
 * `POST /token` mints a 30-day `mcp_access` JWT from any row in `mcp_tokens`
 * whose `client_id` equals the one the caller supplied — the check at
 * ink-tokens.ts compares the stored row against a request-body string, so it
 * namespaces nothing, and the minted token's type is fixed by the endpoint
 * rather than read from the row. A browser grant stored there as
 * `client_id: 'browser-companion'` would therefore have been convertible into
 * the general MCP credential in one request, defeating the companion route
 * allowlist entirely.
 *
 * That is not a hypothetical shape: the obvious place to put a pairing grant
 * is exactly there, beside the mobile pairing codes that live there today.
 * So the property is asserted rather than remembered — every table this
 * service touches is recorded, and `mcp_tokens` is not allowed to be one of
 * them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BrowserCompanionGrantService } from './browser-companion-grant.service';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID = 'installation-abc';
const INSTALLATION_SECRET = 'installation-secret-not-sent-anywhere';
const INSTALLATION_COMMITMENT = crypto
  .createHash('sha256')
  .update(INSTALLATION_SECRET)
  .digest('hex');

const tablesTouched: string[] = [];
const insertPayloads: Array<{ table: string; payload: Record<string, unknown> }> = [];
const updatePayloads: Array<{ table: string; payload: Record<string, unknown> }> = [];
/**
 * Predicates are recorded, not swallowed.
 *
 * The claim's whole binding lives in its WHERE clause — the commitment match
 * is a `.eq()`, not an `if` above the statement — so a fake whose `.eq()` is
 * an identity function cannot see it, and a test written against that fake
 * would pass just as happily with the binding deleted.
 */
const predicates: Array<{ table: string; op: string; column: string; value: unknown }> = [];

function makeRecordingClient() {
  return {
    rpc: (_fn: string, _args: unknown) => ({
      maybeSingle: async () => ({
        data: {
          outcome: 'allowed',
          reason_code: null,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          revoked_at: null,
        },
        error: null,
      }),
    }),
    from(table: string) {
      tablesTouched.push(table);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const record = (op: string) => (column: string, value?: unknown) => {
        predicates.push({ table, op, column, value });
        return builder;
      };
      builder.select = chain;
      builder.eq = record('eq');
      builder.gt = record('gt');
      builder.is = record('is');
      builder.insert = (payload: Record<string, unknown>) => {
        insertPayloads.push({ table, payload });
        return builder;
      };
      builder.update = (payload: Record<string, unknown>) => {
        updatePayloads.push({ table, payload });
        return builder;
      };
      builder.maybeSingle = async () => ({
        data: {
          id: GRANT_ID,
          user_id: USER_ID,
          workspace_id: WORKSPACE_ID,
          expires_at: new Date().toISOString(),
        },
        error: null,
      });
      builder.single = builder.maybeSingle;
      // The insert path awaits the builder directly when it does not .select().
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ error: null });
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
}

describe('browser companion grant storage', () => {
  let service: BrowserCompanionGrantService;

  beforeEach(() => {
    tablesTouched.length = 0;
    insertPayloads.length = 0;
    updatePayloads.length = 0;
    predicates.length = 0;
    service = new BrowserCompanionGrantService(makeRecordingClient());
  });

  async function runFullLifecycle() {
    await service.createPairingCode({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      installationId: INSTALLATION_ID,
      installationCommitment: INSTALLATION_COMMITMENT,
    });
    await service.claimPairingCode({
      pairingCode: 'ABCDEFGHJKLM',
      installationId: INSTALLATION_ID,
      installationSecret: INSTALLATION_SECRET,
    });
    await service.resolveGrantForSecret({
      pairingSecret: 'ink-bc-whatever',
      installationId: INSTALLATION_ID,
    });
    await service.checkGrant(
      {
        type: 'browser_client',
        sub: USER_ID,
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
        grantId: GRANT_ID,
      },
      { requireLive: true }
    );
    await service.revokeGrant(GRANT_ID);
  }

  it('never writes to mcp_tokens', async () => {
    await runFullLifecycle();
    expect(tablesTouched).not.toContain('mcp_tokens');
  });

  it('CONTROL: the recorder does observe the tables it uses', async () => {
    // Without this, "never touches mcp_tokens" would also pass against a
    // recorder that observes nothing at all.
    await runFullLifecycle();
    expect(new Set(tablesTouched)).toEqual(
      new Set(['browser_companion_grants', 'browser_companion_grant_events'])
    );
  });

  describe('secrets are stored hashed, never in plaintext', () => {
    it('stores only a hash of the pairing code', async () => {
      const { pairingCode } = await service.createPairingCode({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
        installationCommitment: INSTALLATION_COMMITMENT,
      });

      const insert = insertPayloads.find((p) => p.table === 'browser_companion_grants');
      expect(insert).toBeDefined();
      const serialized = JSON.stringify(insert!.payload);
      expect(serialized).not.toContain(pairingCode);
      expect(insert!.payload.pairing_code_hash).toBe(
        crypto.createHash('sha256').update(pairingCode).digest('hex')
      );
    });

    it('stores only a hash of the pairing secret', async () => {
      const claim = await service.claimPairingCode({
        pairingCode: 'ABCDEFGHJKLM',
        installationId: INSTALLATION_ID,
        installationSecret: INSTALLATION_SECRET,
      });
      expect(claim.ok).toBe(true);
      const secret = (claim as { pairingSecret: string }).pairingSecret;

      const update = updatePayloads.find((p) => p.table === 'browser_companion_grants');
      expect(update).toBeDefined();
      expect(JSON.stringify(update!.payload)).not.toContain(secret);
      expect(update!.payload.pairing_secret_hash).toBe(
        crypto.createHash('sha256').update(secret).digest('hex')
      );
    });

    it('clears both secrets on revoke', async () => {
      await service.revokeGrant(GRANT_ID, 'user_revoked');
      const update = updatePayloads.find((p) => p.table === 'browser_companion_grants');
      expect(update!.payload).toMatchObject({
        pairing_secret_hash: null,
        pairing_code_hash: null,
        revoked_reason: 'user_revoked',
      });
    });
  });

  describe('the claim is bound to the installation that started the pairing', () => {
    it('matches the installation commitment in the claim statement itself', async () => {
      await service.claimPairingCode({
        pairingCode: 'ABCDEFGHJKLM',
        installationId: INSTALLATION_ID,
        installationSecret: INSTALLATION_SECRET,
      });

      const grantPredicates = predicates.filter((p) => p.table === 'browser_companion_grants');
      expect(grantPredicates).toContainEqual({
        table: 'browser_companion_grants',
        op: 'eq',
        column: 'installation_commitment',
        value: INSTALLATION_COMMITMENT,
      });
    });

    it('sends the digest of the secret, never the secret', async () => {
      await service.claimPairingCode({
        pairingCode: 'ABCDEFGHJKLM',
        installationId: INSTALLATION_ID,
        installationSecret: INSTALLATION_SECRET,
      });

      const values = JSON.stringify(predicates.concat(updatePayloads as never[]));
      expect(values).not.toContain(INSTALLATION_SECRET);
    });

    it('CONTROL: a different secret produces a predicate that cannot match the stored row', async () => {
      // The refusal is the database's, so what is measurable here is the value
      // that goes into the predicate. If it were derived from something the
      // claimer does not have to know, this would be equal, not different.
      await service.claimPairingCode({
        pairingCode: 'ABCDEFGHJKLM',
        installationId: INSTALLATION_ID,
        installationSecret: 'some-other-installations-secret',
      });

      const commitment = predicates.find((p) => p.column === 'installation_commitment');
      expect(commitment?.value).toBeDefined();
      expect(commitment!.value).not.toBe(INSTALLATION_COMMITMENT);
    });

    it('refuses to mint a grant whose commitment is not a digest', async () => {
      // An empty or non-hex commitment would make the column unmatchable and
      // the binding silently dead. It is also the shape a caller sending the
      // raw secret here would produce.
      await expect(
        service.createPairingCode({
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
          installationId: INSTALLATION_ID,
          installationCommitment: '',
        })
      ).rejects.toThrow('installation_commitment_invalid');

      await expect(
        service.createPairingCode({
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
          installationId: INSTALLATION_ID,
          installationCommitment: INSTALLATION_SECRET,
        })
      ).rejects.toThrow('installation_commitment_invalid');

      expect(insertPayloads).toHaveLength(0);
    });
  });

  describe('this grant carries no action budget', () => {
    it('does not write an action counter when the grant is minted', async () => {
      // The counter was dropped deliberately: nothing in this PR admits a page
      // action, so the only traffic it could have counted is the extension's
      // own polling — it would have measured elapsed time and called it
      // actions. Page-session budgets live on a separate authorization.
      await service.createPairingCode({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
        installationCommitment: INSTALLATION_COMMITMENT,
      });

      const insert = insertPayloads.find((p) => p.table === 'browser_companion_grants');
      expect(Object.keys(insert!.payload)).not.toContain('max_actions');
      expect(Object.keys(insert!.payload)).not.toContain('action_count');
    });

    it('CONTROL: the same insert does carry the bindings and the wall-clock ceiling', async () => {
      await service.createPairingCode({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        installationId: INSTALLATION_ID,
        installationCommitment: INSTALLATION_COMMITMENT,
      });

      const insert = insertPayloads.find((p) => p.table === 'browser_companion_grants');
      expect(Object.keys(insert!.payload)).toEqual(
        expect.arrayContaining([
          'user_id',
          'workspace_id',
          'installation_id',
          'installation_commitment',
          'expires_at',
        ])
      );
    });
  });

  describe('grant events are fields, not prose', () => {
    it('records a reason code rather than a sentence', async () => {
      await service.revokeGrant(GRANT_ID, 'user_revoked');
      const event = insertPayloads.find((p) => p.table === 'browser_companion_grant_events');
      expect(event!.payload).toEqual({
        grant_id: GRANT_ID,
        event: 'revoked',
        reason_code: 'user_revoked',
      });
      // No free-text column to stitch a claim into. `studio_lease_events` has
      // already asserted a cause nobody measured by composing one.
      expect(Object.keys(event!.payload)).not.toContain('message');
      expect(Object.keys(event!.payload)).not.toContain('description');
    });
  });
});
