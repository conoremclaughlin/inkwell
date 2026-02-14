'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { provisionPcpUserAndWorkspace } from '@/lib/auth/provision';

type AuthResult = { success: true } | { error: string } | { mcpRedirectUrl: string };

export async function signInWithPassword(
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

  // MCP OAuth flow: build callback URL with tokens
  if (mcpPendingId && data.session) {
    const apiUrl = process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;
    const callbackUrl = new URL(`${apiUrl}/mcp/auth/callback`);
    callbackUrl.searchParams.set('pending_id', mcpPendingId);
    callbackUrl.searchParams.set('access_token', data.session.access_token);
    return { mcpRedirectUrl: callbackUrl.toString() };
  }

  return { success: true };
}

export async function signInWithOtp(
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

export async function signInWithOAuth(
  provider: 'google' | 'github',
  redirectTo: string
): Promise<{ url: string } | { error: string }> {
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

export async function signUpWithPassword(
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

export async function signOut(): Promise<never> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
