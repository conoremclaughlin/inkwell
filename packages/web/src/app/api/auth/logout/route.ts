import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('pcp-admin-refresh')?.value;

  if (refreshToken) {
    const apiUrl = process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;
    try {
      await fetch(`${apiUrl}/api/admin/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Best-effort revocation — cookies are cleared below regardless.
    }
  }

  const supabase = await createClient();
  await supabase.auth.signOut();

  const response = NextResponse.json({ success: true });
  response.cookies.delete({ name: 'pcp-admin-token', path: '/api/admin' });
  response.cookies.delete({ name: 'pcp-admin-refresh', path: '/api/admin' });
  return response;
}
