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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

    beforeAll(async () => {
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

    it('should update last_used_at on successful exchange', async () => {
      const supabase = dataComposer.getClient();

      const before = new Date();

      await exchangeRefreshToken(
        supabase,
        validRefreshToken,
        'integration-test',
        'mcp_access',
        3600
      );

      const { data: dbToken } = await supabase
        .from('mcp_tokens')
        .select('last_used_at')
        .eq('refresh_token', validRefreshToken)
        .single();

      expect(dbToken).not.toBeNull();
      expect(dbToken!.last_used_at).not.toBeNull();
      expect(new Date(dbToken!.last_used_at!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000
      );
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
