import { createClient } from '@/lib/supabase/server';
import { provisionPcpUserAndWorkspace } from '@/lib/auth/provision';
import type { AuthResult, OAuthResult } from '@/lib/auth/types';

export async function signInWithPasswordOnServer(
  email: string,
  password: string,
  mcpPendingId?: string | null
): Promise<AuthResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  if (data.session?.access_token) {
    await provisionPcpUserAndWorkspace(data.session.access_token);
  }

  if (mcpPendingId && data.session) {
    const apiUrl = process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;
    const callbackUrl = new URL(`${apiUrl}/mcp/auth/callback`);
    callbackUrl.searchParams.set('pending_id', mcpPendingId);
    callbackUrl.searchParams.set('access_token', data.session.access_token);
    return { mcpRedirectUrl: callbackUrl.toString() };
  }

  return { success: true };
}

export async function signInWithOtpOnServer(
  email: string,
  redirectTo: string
): Promise<{ success: true } | { error: string }> {
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}

export async function signInWithOAuthOnServer(
  provider: 'google' | 'github',
  redirectTo: string
): Promise<OAuthResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
    },
  });

  if (error) {
    return { error: error.message };
  }

  if (!data.url) {
    return { error: 'OAuth provider returned no redirect URL' };
  }

  return { url: data.url };
}

export async function signUpWithPasswordOnServer(
  email: string,
  password: string,
  redirectTo: string
): Promise<{ success: true } | { error: string }> {
  const supabase = await createClient();

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}
