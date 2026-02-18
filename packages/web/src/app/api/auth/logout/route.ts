import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const response = NextResponse.json({ success: true });
  response.cookies.delete({ name: 'pcp-admin-token', path: '/api/admin' });
  response.cookies.delete({ name: 'pcp-admin-refresh', path: '/api/admin' });
  return response;
}
