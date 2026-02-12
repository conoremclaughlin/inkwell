'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

type AuthResult = { success: true } | { error: string } | { mcpRedirectUrl: string };

export async function signInWithPassword(
  email: string,
  password: string,
  mcpRedirect?: string | null,
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
  if (mcpRedirect && mcpPendingId && data.session) {
    const callbackUrl = new URL(mcpRedirect);
    callbackUrl.searchParams.set('pending_id', mcpPendingId);
    callbackUrl.searchParams.set('access_token', data.session.access_token);
    callbackUrl.searchParams.set('refresh_token', data.session.refresh_token);
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
