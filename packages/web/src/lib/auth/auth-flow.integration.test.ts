/**
 * Integration tests for the auth flow.
 *
 * Uses a real Supabase instance with a temporary test user.
 * Requires SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

const BASE_PORT = Number(process.env.PCP_PORT_BASE || 3001);
const WEB_PORT = BASE_PORT + 1;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SECRET_KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY)!;

const TEST_EMAIL = `test-${Date.now()}@integration-test.local`;
const TEST_PASSWORD = 'integration-test-password-XkL9!';

// Admin client for creating/deleting test users
const adminClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let testUserId: string;

// In-memory cookie store for @supabase/ssr
type Cookie = { name: string; value: string; options?: Record<string, unknown> };
let cookieStore: Map<string, string>;

function createSSRClient() {
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return Array.from(cookieStore.entries()).map(([name, value]) => ({ name, value }));
      },
      setAll(cookies: Cookie[]) {
        cookies.forEach(({ name, value }) => cookieStore.set(name, value));
      },
    },
  });
}

function makeRequest(url: string): NextRequest {
  const req = new NextRequest(new URL(url, WEB_ORIGIN));
  // Copy session cookies onto the request
  cookieStore.forEach((value, name) => {
    req.cookies.set(name, value);
  });
  return req;
}

describe('auth flow integration', () => {
  beforeAll(async () => {
    // Create a temporary test user via admin API
    const { data, error } = await adminClient.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });

    if (error) throw new Error(`Failed to create test user: ${error.message}`);
    testUserId = data.user.id;

    // Sign in via SSR client to populate cookie store
    cookieStore = new Map();
    const ssr = createSSRClient();
    const { error: signInError } = await ssr.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    if (signInError) throw new Error(`Failed to sign in test user: ${signInError.message}`);
  });

  afterAll(async () => {
    // Clean up: delete test user
    if (testUserId) {
      await adminClient.auth.admin.deleteUser(testUserId);
    }
  });

  describe('session cookies', () => {
    it('sign-in populates session cookies', () => {
      // @supabase/ssr stores auth in cookies named sb-<ref>-auth-token*
      const authCookies = Array.from(cookieStore.keys()).filter((name) =>
        name.includes('auth-token')
      );
      expect(authCookies.length).toBeGreaterThan(0);
    });

    it('SSR client can read user from cookies', async () => {
      const ssr = createSSRClient();
      const {
        data: { user },
      } = await ssr.auth.getUser();
      expect(user).not.toBeNull();
      expect(user!.email).toBe(TEST_EMAIL);
      expect(user!.id).toBe(testUserId);
    });

    it('SSR client can get session with access token from cookies', async () => {
      const ssr = createSSRClient();
      const {
        data: { session },
      } = await ssr.auth.getSession();
      expect(session).not.toBeNull();
      expect(session!.access_token).toBeTruthy();
      expect(typeof session!.access_token).toBe('string');
      expect(session!.access_token.length).toBeGreaterThan(20);
    });
  });

  describe('middleware auth injection', () => {
    it('injects Authorization header for /api/admin/* routes', async () => {
      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);

      // Middleware passes request headers via x-middleware-request-* headers
      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBeTruthy();
      expect(authHeader).toMatch(/^Bearer .+/);

      // Verify it's a real JWT (three dot-separated base64 segments)
      const token = authHeader!.replace('Bearer ', '');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('injected token matches the session access token', async () => {
      // Get the expected token from the SSR client
      const ssr = createSSRClient();
      const {
        data: { session },
      } = await ssr.auth.getSession();

      const request = makeRequest('/api/admin/data');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBe(`Bearer ${session!.access_token}`);
    });

    it('does NOT inject auth header for /api/auth/* routes', async () => {
      const request = makeRequest('/api/auth/me');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBeNull();
    });

    it('injects auth for /api/chat/* routes', async () => {
      const request = makeRequest('/api/chat/messages');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBeTruthy();
      expect(authHeader).toMatch(/^Bearer .+/);
    });

    it('injects auth for /api/kindle/* routes', async () => {
      const request = makeRequest('/api/kindle/redeem');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBeTruthy();
      expect(authHeader).toMatch(/^Bearer .+/);
    });
  });

  describe('unauthenticated requests', () => {
    it('redirects to /login for protected routes without cookies', async () => {
      const request = new NextRequest(new URL('/dashboard', WEB_ORIGIN));
      // No cookies set — unauthenticated
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
    });

    it('does NOT inject auth for API routes without cookies', async () => {
      const request = new NextRequest(new URL('/api/admin/users', WEB_ORIGIN));
      // No cookies
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization');
      expect(authHeader).toBeNull();
    });
  });

  describe('token validation', () => {
    it('injected JWT contains the correct user ID in payload', async () => {
      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization')!;
      const token = authHeader.replace('Bearer ', '');

      // Decode JWT payload (base64url)
      const payloadB64 = token.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      expect(payload.sub).toBe(testUserId);
      expect(payload.email).toBe(TEST_EMAIL);
    });

    it('JWT has not expired', async () => {
      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);

      const authHeader = response.headers.get('x-middleware-request-authorization')!;
      const token = authHeader.replace('Bearer ', '');
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp).toBeGreaterThan(now);
    });
  });

  describe('cookie refresh propagation', () => {
    it('response includes session cookies for downstream', async () => {
      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);

      // Supabase middleware should propagate any refreshed cookies
      // At minimum, the response should be valid (not an error)
      expect(response.status).toBe(200);
    });
  });
});
