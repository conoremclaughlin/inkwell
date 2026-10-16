import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { Database } from './types';

let supabaseClient: SupabaseClient<Database> | null = null;

/** What every client this server makes needs (AGENTS.md, Security rule 3). */
const SERVER_CLIENT_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
};

/**
 * A new Supabase client for one caller, with token refresh and session
 * persistence off. This is the only place in packages/api that calls
 * createClient; client.guard.test.ts holds it to that.
 *
 * With the library's defaults every client starts a refresh interval, and the
 * timer keeps it reachable for the life of the process. 100 clients made that
 * way were all alive after 20 forced collections, and none with refresh off
 * (Lumen, 2026-10-16, thread inkwell:debug:api-memory-growth).
 * `persistSession: false` alone still starts the timer.
 *
 * Each call returns its own client, so signing in or signing up on it changes
 * no other caller's client. Plain data access can share getSupabaseClient().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- createClient's own default
export function createServerSupabaseClient<Db = any>(key: 'secret' | 'publishable' = 'secret') {
  return createClient<Db>(
    env.SUPABASE_URL,
    key === 'secret' ? env.SUPABASE_SECRET_KEY : env.SUPABASE_PUBLISHABLE_KEY,
    SERVER_CLIENT_OPTIONS
  );
}

/**
 * Singleton Supabase client for PostgREST data queries using the service role key.
 *
 * ⚠️  DO NOT call session-mutating auth methods on this client:
 *     auth.refreshSession(), auth.signIn*(), auth.signUp(), auth.setSession()
 *
 * These methods overwrite the Authorization header from service_role to a user JWT,
 * silently subjecting all subsequent PostgREST queries to RLS. persistSession:false
 * does NOT prevent this — it only skips disk storage, the in-memory session is still set.
 *
 * Safe: .from('table').*, auth.getUser(jwt), auth.admin.*
 * Ref: https://github.com/orgs/supabase/discussions/30146
 */
export function createSupabaseClient(): SupabaseClient<Database> {
  if (supabaseClient) {
    return supabaseClient;
  }

  try {
    supabaseClient = createServerSupabaseClient<Database>();

    logger.info('Supabase client created successfully', {
      url: env.SUPABASE_URL,
      keyType: 'secret',
    });
    return supabaseClient;
  } catch (error) {
    logger.error('Failed to create Supabase client:', error);
    throw new Error('Failed to initialize database connection');
  }
}

export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabaseClient) {
    return createSupabaseClient();
  }
  return supabaseClient;
}
