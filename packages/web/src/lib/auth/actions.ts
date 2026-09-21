'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { provisionInkUserAndWorkspace } from '@/lib/auth/provision';

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
    await provisionInkUserAndWorkspace(data.session.access_token);
  }

  // MCP OAuth flow: build callback URL with tokens
  if (mcpPendingId && data.session) {
    const apiUrl = process.env.API_URL || `http://localhost:${process.env.INK_PORT_BASE || 3001}`;
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
  // Revoke Inkwell admin tokens (self-issued JWTs independent of Supabase session)
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('pcp-admin-refresh')?.value;

  if (refreshToken) {
    const apiUrl = process.env.API_URL || `http://localhost:${process.env.INK_PORT_BASE || 3001}`;
    try {
      await fetch(`${apiUrl}/api/admin/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Best-effort revocation — cookies are cleared below regardless
    }
  }

  // Clear Inkwell admin cookies from browser
  cookieStore.delete({ name: 'pcp-admin-token', path: '/api/admin' });
  cookieStore.delete({ name: 'pcp-admin-refresh', path: '/api/admin' });

  // Clear Supabase session
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
