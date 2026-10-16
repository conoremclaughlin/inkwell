import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { Database } from './types';

let supabaseClient: SupabaseClient<Database> | null = null;

/**
 * Fresh server client, with no persisted session or background refresh timer.
 * On Node, default auth options start an interval even without a login; the
 * interval retains the discarded client. persistSession:false alone does not
 * disable it. Fresh instances also keep request-local auth state isolated.
 * Use the publishable key only for dedicated user sign-in/sign-up clients.
 */
export function createServerSupabaseClient(keyType?: 'secret' | 'publishable'): SupabaseClient;
export function createServerSupabaseClient<Schema>(
  keyType?: 'secret' | 'publishable'
): SupabaseClient<Schema>;
export function createServerSupabaseClient(
  keyType: 'secret' | 'publishable' = 'secret'
): SupabaseClient {
  return createClient(
    env.SUPABASE_URL,
    keyType === 'publishable' ? env.SUPABASE_PUBLISHABLE_KEY : env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
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
