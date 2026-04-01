import { NextResponse } from 'next/server';
import { signInWithOAuthOnServer } from '@/lib/auth/server-auth';

export async function POST(request: Request) {
  const { provider, redirectTo } = (await request.json()) as {
    provider: 'google' | 'github';
    redirectTo: string;
  };

  const result = await signInWithOAuthOnServer(provider, redirectTo);
  return NextResponse.json(result);
}
