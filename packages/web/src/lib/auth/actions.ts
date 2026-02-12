'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

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

export async function signOut(): Promise<never> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
