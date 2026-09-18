/**
 * PCP Tokens Integration Tests
 *
 * Tests the full token lifecycle against a real Supabase database:
 * 1. Create refresh token (writes to mcp_tokens)
 * 2. Exchange refresh token for new access JWT
 * 3. Verify access JWT locally
 * 4. Token expiration handling
 * 5. Client ID isolation
 *
 * Run via: yarn workspace @inklabs/api test:integration
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { getDataComposer, type DataComposer } from '../data/composer';
import {
  signPcpAccessToken,
  verifyPcpAccessToken,
  createRefreshToken,
  exchangeRefreshToken,
} from './pcp-tokens';
import { env } from '../config/env';
import { ensureEchoIntegrationFixture } from '../test/integration-fixtures';

describe('PCP Tokens Integration', () => {
  let dataComposer: DataComposer;
  let testUserId: string;
  let testUserEmail: string;
  const createdTokenIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;
    testUserEmail = fixture.email;
  });

  afterAll(async () => {
    if (!dataComposer) return;

    // Clean up all tokens created during tests
    if (createdTokenIds.length > 0) {
      const supabase = dataComposer.getClient();
      await supabase.from('mcp_tokens').delete().in('id', createdTokenIds);
    }

    // Also clean up by client_id in case IDs weren't tracked
    const supabase = dataComposer.getClient();
    await supabase
      .from('mcp_tokens')
      .delete()
      .eq('user_id', testUserId)
      .in('client_id', ['integration-test', 'integration-test-admin', 'integration-test-isolated']);
  });

  // =========================================================================
  // signPcpAccessToken + verifyPcpAccessToken round-trip
  // =========================================================================

  describe('sign + verify (no DB)', () => {
    it('should sign and verify an mcp_access token', () => {
      const token = signPcpAccessToken(
        { type: 'mcp_access', sub: testUserId, email: testUserEmail, scope: 'mcp:tools' },
        3600
      );

      const result = verifyPcpAccessToken(token, 'mcp_access');
      expect(result).not.toBeNull();
      expect(result!.sub).toBe(testUserId);
      expect(result!.email).toBe(testUserEmail);
      expect(result!.type).toBe('mcp_access');
    });

    it('should sign and verify a pcp_admin token', () => {
      const token = signPcpAccessToken(
        { type: 'pcp_admin', sub: testUserId, email: testUserEmail, scope: 'admin' },
        3600
      );

      const result = verifyPcpAccessToken(token, 'pcp_admin');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('pcp_admin');
      expect(result!.scope).toBe('admin');
    });

    it('should enforce type isolation', () => {
      const mcpToken = signPcpAccessToken(
        { type: 'mcp_access', sub: testUserId, email: testUserEmail, scope: 'mcp:tools' },
        3600
      );
      const adminToken = signPcpAccessToken(
        { type: 'pcp_admin', sub: testUserId, email: testUserEmail, scope: 'admin' },
        3600
      );

      // Cross-type verification must fail
      expect(verifyPcpAccessToken(mcpToken, 'pcp_admin')).toBeNull();
      expect(verifyPcpAccessToken(adminToken, 'mcp_access')).toBeNull();

      // Same-type verification must succeed
      expect(verifyPcpAccessToken(mcpToken, 'mcp_access')).not.toBeNull();
      expect(verifyPcpAccessToken(adminToken, 'pcp_admin')).not.toBeNull();
    });

    it('should reject expired tokens', () => {
      const token = signPcpAccessToken(
        { type: 'pcp_admin', sub: testUserId, email: testUserEmail, scope: 'admin' },
        0 // expires immediately
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should reject tokens signed with wrong secret', () => {
      const token = jwt.sign(
        { type: 'pcp_admin', sub: testUserId, email: testUserEmail, scope: 'admin' },
        'totally-wrong-secret-that-is-at-least-32-chars',
        { expiresIn: 3600 }
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });
  });

  // =========================================================================
  // createRefreshToken (writes to DB)
  // =========================================================================

  describe('createRefreshToken (DB write)', () => {
    it('should create a refresh token in the mcp_tokens table', async () => {
      const supabase = dataComposer.getClient();

      const result = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test',
        ['mcp:tools'],
        90
      );

      expect(result.refreshToken).toMatch(/^pcp-rt-/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify it was actually written to the database
      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('*')
        .eq('refresh_token', result.refreshToken)
        .single();

      expect(dbToken).not.toBeNull();
      expect(dbToken!.user_id).toBe(testUserId);
      expect(dbToken!.client_id).toBe('integration-test');
      expect(dbToken!.scopes).toEqual(['mcp:tools']);
      expect(dbToken!.supabase_refresh_token).toBeNull();

      createdTokenIds.push(dbToken!.id);
    });

    it('should create tokens with admin scopes for dashboard client', async () => {
      const supabase = dataComposer.getClient();

      const result = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test-admin',
        ['admin'],
        90
      );

      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('*')
        .eq('refresh_token', result.refreshToken)
        .single();

      expect(dbToken).not.toBeNull();
      expect(dbToken!.client_id).toBe('integration-test-admin');
      expect(dbToken!.scopes).toEqual(['admin']);

      createdTokenIds.push(dbToken!.id);
    });
  });

  // =========================================================================
  // exchangeRefreshToken (DB read + JWT sign)
  // =========================================================================

  describe('exchangeRefreshToken (DB read)', () => {
    let validRefreshToken: string;
    /** The grant's row id. After an exchange the token VALUE has rotated, so
     *  this is the only stable handle on the row. */
    let validTokenRowId: string | undefined;

    // beforeEach, not beforeAll: a grant is now SINGLE USE. One shared fixture
    // would be consumed by the first exchange, leaving every later test to
    // present a dead token — and the ones that assert null would pass for the
    // wrong reason.
    beforeEach(async () => {
      // Create a fresh refresh token to use for exchange tests
      const supabase = dataComposer.getClient();
      const result = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test',
        ['mcp:tools'],
        90
      );
      validRefreshToken = result.refreshToken;

      // Track for cleanup
      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('refresh_token', validRefreshToken)
        .single();
      if (dbToken) createdTokenIds.push(dbToken.id);
      validTokenRowId = dbToken?.id;
    });

    it('should exchange a valid refresh token for a new access JWT', async () => {
      const supabase = dataComposer.getClient();

      const result = await exchangeRefreshToken(
        supabase,
        validRefreshToken,
        'integration-test',
        'mcp_access',
        3600
      );

      expect(result).not.toBeNull();
      expect(result!.userId).toBe(testUserId);
      expect(result!.email).toBe(testUserEmail);

      // The returned access token should be a valid JWT
      const decoded = verifyPcpAccessToken(result!.accessToken, 'mcp_access');
      expect(decoded).not.toBeNull();
      expect(decoded!.sub).toBe(testUserId);
      expect(decoded!.type).toBe('mcp_access');
    });

    it('should exchange for pcp_admin token type', async () => {
      const supabase = dataComposer.getClient();

      // Create admin refresh token
      const { refreshToken: adminRefresh } = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test-admin',
        ['admin'],
        90
      );

      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('refresh_token', adminRefresh)
        .single();
      if (dbToken) createdTokenIds.push(dbToken.id);

      const result = await exchangeRefreshToken(
        supabase,
        adminRefresh,
        'integration-test-admin',
        'pcp_admin',
        3600
      );

      expect(result).not.toBeNull();
      const decoded = verifyPcpAccessToken(result!.accessToken, 'pcp_admin');
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('pcp_admin');
      expect(decoded!.scope).toBe('admin');
    });

    it('should rotate the secret and stamp last_used_at, leaving the deadline alone', async () => {
      const supabase = dataComposer.getClient();

      const before = new Date();

      // The deadline as the database actually holds it, read before the
      // exchange so the comparison below is against a real stored value rather
      // than against what the policy is assumed to compute.
      const { data: preRow } = await supabase
        .from('mcp_tokens')
        .select('expires_at, created_at')
        .eq('id', validTokenRowId!)
        .single();
      expect(preRow).not.toBeNull();

      const result = await exchangeRefreshToken(
        supabase,
        validRefreshToken,
        'integration-test',
        'mcp_access',
        3600
      );

      expect(result).not.toBeNull();
      expect(result!.refreshToken).not.toBe(validRefreshToken);

      // Look the row up by ID: the token VALUE it was created with no longer
      // exists, which is the rotation working.
      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('refresh_token, last_used_at, expires_at, created_at')
        .eq('id', validTokenRowId!)
        .single();

      expect(dbToken).not.toBeNull();
      expect(dbToken!.refresh_token).toBe(result!.refreshToken);
      expect(dbToken!.last_used_at).not.toBeNull();
      expect(new Date(dbToken!.last_used_at!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000
      );

      // Rotation moved the secret and nothing else. Both deadline columns are
      // byte-identical to what the row held before the exchange — the check
      // that would catch a re-stamped expires_at against a real database,
      // including any trigger that might rewrite it behind the query.
      expect(dbToken!.expires_at).toBe(preRow!.expires_at);
      expect(dbToken!.created_at).toBe(preRow!.created_at);

      // And the caller was handed that same stored deadline, not a fresh one.
      expect(result!.refreshTokenExpiresAt.toISOString()).toBe(
        new Date(preRow!.expires_at).toISOString()
      );

      // The presented secret is dead — a real end-to-end replay check. The
      // overlap is switched off for it, because with the overlap on, a replay
      // one millisecond later is exactly the retry the overlap exists to
      // answer; this assertion is about ROTATION, and zero is the setting under
      // which rotation alone decides.
      const replay = await exchangeRefreshToken(
        supabase,
        validRefreshToken,
        'integration-test',
        'mcp_access',
        3600,
        { retryOverlapSeconds: 0 }
      );
      expect(replay).toBeNull();
    });

    it('should return null for nonexistent refresh token', async () => {
      const supabase = dataComposer.getClient();

      const result = await exchangeRefreshToken(
        supabase,
        'pcp-rt-does-not-exist',
        'integration-test',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();
    });

    it('should return null for client_id mismatch', async () => {
      const supabase = dataComposer.getClient();

      const result = await exchangeRefreshToken(
        supabase,
        validRefreshToken,
        'wrong-client-id',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();
    });

    it('should return null and delete expired refresh token', async () => {
      const supabase = dataComposer.getClient();

      // Create an already-expired token directly in the DB
      const { data: expiredToken } = await supabase
        .from('mcp_tokens')
        .insert({
          user_id: testUserId,
          client_id: 'integration-test',
          refresh_token: `pcp-rt-expired-${Date.now()}`,
          supabase_refresh_token: null,
          scopes: ['mcp:tools'],
          expires_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
        })
        .select('id, refresh_token')
        .single();

      expect(expiredToken).not.toBeNull();

      const result = await exchangeRefreshToken(
        supabase,
        expiredToken!.refresh_token,
        'integration-test',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();

      // Token should have been deleted from DB
      const { data: deleted } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('id', expiredToken!.id)
        .single();

      expect(deleted).toBeNull();
    });

    it('should enforce client_id isolation between MCP and dashboard tokens', async () => {
      const supabase = dataComposer.getClient();

      // Create tokens with different client IDs
      const { refreshToken: mcpRefresh } = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test-isolated',
        ['mcp:tools'],
        90
      );

      // Track for cleanup
      const { data: t1 } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('refresh_token', mcpRefresh)
        .single();
      if (t1) createdTokenIds.push(t1.id);

      // MCP refresh token should NOT work with dashboard client_id
      const crossResult = await exchangeRefreshToken(
        supabase,
        mcpRefresh,
        'dashboard',
        'pcp_admin',
        3600
      );
      expect(crossResult).toBeNull();

      // Should still work with its own client_id
      const sameResult = await exchangeRefreshToken(
        supabase,
        mcpRefresh,
        'integration-test-isolated',
        'mcp_access',
        3600
      );
      expect(sameResult).not.toBeNull();
    });
  });

  // =========================================================================
  // The retry overlap, against a real database.
  //
  // The unit suite models the conditional update; here Postgres enforces it.
  // That matters for the case this was built for: two consumers issuing their
  // exchanges at once, where the row, its UNIQUE index and the UPDATE's own
  // WHERE clause decide the winner rather than a test double.
  // =========================================================================

  describe('retry overlap (real concurrency)', () => {
    let grantToken: string;
    let grantRowId: string;

    beforeEach(async () => {
      const supabase = dataComposer.getClient();
      const { refreshToken } = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test',
        ['mcp:tools'],
        90
      );
      grantToken = refreshToken;

      const { data: row } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('refresh_token', refreshToken)
        .single();
      expect(row).not.toBeNull();
      grantRowId = row!.id;
      createdTokenIds.push(grantRowId);
    });

    it('serves both of two genuinely concurrent exchanges, and leaves one live secret', async () => {
      // Two processes sharing one grant, issued together — not sequenced, not
      // scripted. Exactly one UPDATE can match `refresh_token`; the loser is
      // answered from the row the winner just wrote.
      const supabase = dataComposer.getClient();

      const [first, second] = await Promise.all([
        exchangeRefreshToken(supabase, grantToken, 'integration-test', 'mcp_access', 3600),
        exchangeRefreshToken(supabase, grantToken, 'integration-test', 'mcp_access', 3600),
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.refreshToken).toBe(second!.refreshToken);
      expect(first!.refreshToken).not.toBe(grantToken);

      // Each caller got its own usable access token.
      expect(verifyPcpAccessToken(first!.accessToken, 'mcp_access')).not.toBeNull();
      expect(verifyPcpAccessToken(second!.accessToken, 'mcp_access')).not.toBeNull();

      // And the database holds ONE live secret, with the presented value
      // recorded as its predecessor exactly once.
      const { data: after } = await supabase
        .from('mcp_tokens')
        .select('refresh_token, previous_refresh_token, rotated_at')
        .eq('id', grantRowId)
        .single();
      expect(after!.refresh_token).toBe(first!.refreshToken);
      expect(after!.previous_refresh_token).toBe(grantToken);
      expect(after!.rotated_at).not.toBeNull();

      const { data: rows } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('user_id', testUserId)
        .eq('previous_refresh_token', grantToken);
      expect(rows).toHaveLength(1);
    });

    it('answers a sequential retry of the same secret with the committed successor', async () => {
      const supabase = dataComposer.getClient();

      const first = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );
      const retry = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );

      expect(retry).not.toBeNull();
      expect(retry!.refreshToken).toBe(first!.refreshToken);

      // No second rotation: the row is untouched by the retry.
      const { data: after } = await supabase
        .from('mcp_tokens')
        .select('refresh_token, previous_refresh_token')
        .eq('id', grantRowId)
        .single();
      expect(after!.refresh_token).toBe(first!.refreshToken);
      expect(after!.previous_refresh_token).toBe(grantToken);
    });

    it('refuses the previous secret once the window has closed', async () => {
      const supabase = dataComposer.getClient();
      await exchangeRefreshToken(supabase, grantToken, 'integration-test', 'mcp_access', 3600);

      // Age the rotation in the database rather than sleeping through it.
      await supabase
        .from('mcp_tokens')
        .update({ rotated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
        .eq('id', grantRowId);

      const late = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );
      expect(late).toBeNull();
    });

    it('does not move either deadline column when answering a retry', async () => {
      const supabase = dataComposer.getClient();
      const { data: before } = await supabase
        .from('mcp_tokens')
        .select('expires_at, created_at')
        .eq('id', grantRowId)
        .single();

      await exchangeRefreshToken(supabase, grantToken, 'integration-test', 'mcp_access', 3600);
      const retry = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );

      const { data: after } = await supabase
        .from('mcp_tokens')
        .select('expires_at, created_at')
        .eq('id', grantRowId)
        .single();

      expect(after!.expires_at).toBe(before!.expires_at);
      expect(after!.created_at).toBe(before!.created_at);
      expect(retry!.refreshTokenExpiresAt.toISOString()).toBe(
        new Date(before!.expires_at).toISOString()
      );
    });

    it('keeps only one generation — the secret before last stays dead', async () => {
      const supabase = dataComposer.getClient();
      const first = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );
      await exchangeRefreshToken(
        supabase,
        first!.refreshToken,
        'integration-test',
        'mcp_access',
        3600
      );

      // The original is now two generations back: no row names it.
      const twoBack = await exchangeRefreshToken(
        supabase,
        grantToken,
        'integration-test',
        'mcp_access',
        3600
      );
      expect(twoBack).toBeNull();
    });

    it('refuses a retry from a different client_id', async () => {
      const supabase = dataComposer.getClient();
      await exchangeRefreshToken(supabase, grantToken, 'integration-test', 'mcp_access', 3600);

      const crossClient = await exchangeRefreshToken(
        supabase,
        grantToken,
        'dashboard',
        'pcp_admin',
        3600
      );
      expect(crossClient).toBeNull();
    });
  });

  // =========================================================================
  // Full lifecycle: create → exchange → verify → type check
  // =========================================================================

  describe('full token lifecycle', () => {
    it('should complete the admin auth token lifecycle end-to-end', async () => {
      const supabase = dataComposer.getClient();

      // Step 1: Create refresh token (happens on first Supabase login via Tier 3)
      const { refreshToken } = await createRefreshToken(
        supabase,
        testUserId,
        'integration-test-admin',
        ['admin'],
        90
      );

      // Track for cleanup
      const { data: t } = await supabase
        .from('mcp_tokens')
        .select('id')
        .eq('refresh_token', refreshToken)
        .single();
      if (t) createdTokenIds.push(t.id);

      // Step 2: Sign initial access token (happens in Tier 3 cookie issuance)
      const initialAccessToken = signPcpAccessToken(
        { type: 'pcp_admin', sub: testUserId, email: testUserEmail, scope: 'admin' },
        3600
      );

      // Step 3: Verify the access token (Tier 1 on next request)
      const tier1Result = verifyPcpAccessToken(initialAccessToken, 'pcp_admin');
      expect(tier1Result).not.toBeNull();
      expect(tier1Result!.sub).toBe(testUserId);
      expect(tier1Result!.type).toBe('pcp_admin');

      // Step 4: Exchange refresh token (Tier 2 when access token expires)
      const tier2Result = await exchangeRefreshToken(
        supabase,
        refreshToken,
        'integration-test-admin',
        'pcp_admin',
        3600
      );
      expect(tier2Result).not.toBeNull();

      // Step 5: Verify the refreshed access token (next Tier 1)
      const refreshedVerify = verifyPcpAccessToken(tier2Result!.accessToken, 'pcp_admin');
      expect(refreshedVerify).not.toBeNull();
      expect(refreshedVerify!.sub).toBe(testUserId);
      expect(refreshedVerify!.type).toBe('pcp_admin');

      // Step 6: Ensure the token is NOT accepted as mcp_access
      expect(verifyPcpAccessToken(tier2Result!.accessToken, 'mcp_access')).toBeNull();
    });
  });
});
