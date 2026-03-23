'use client';

import type { AuthResult, OAuthResult } from '@/lib/auth/types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  return (await response.json()) as T;
}

export async function signInWithPassword(
  email: string,
  password: string,
  mcpPendingId?: string | null
): Promise<AuthResult> {
  return postJson<AuthResult>('/api/auth/login', { email, password, mcpPendingId });
}

export async function signInWithOtp(
  email: string,
  redirectTo: string
): Promise<{ success: true } | { error: string }> {
  return postJson<{ success: true } | { error: string }>('/api/auth/login/otp', {
    email,
    redirectTo,
  });
}

export async function signInWithOAuth(
  provider: 'google' | 'github',
  redirectTo: string
): Promise<OAuthResult> {
  return postJson<OAuthResult>('/api/auth/oauth', { provider, redirectTo });
}

export async function signUpWithPassword(
  email: string,
  password: string,
  redirectTo: string
): Promise<{ success: true } | { error: string }> {
  return postJson<{ success: true } | { error: string }>('/api/auth/signup', {
    email,
    password,
    redirectTo,
  });
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
  window.location.assign('/login');
}
