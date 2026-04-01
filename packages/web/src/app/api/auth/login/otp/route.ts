import { NextResponse } from 'next/server';
import { signInWithOtpOnServer } from '@/lib/auth/server-auth';

export async function POST(request: Request) {
  const { email, redirectTo } = (await request.json()) as {
    email: string;
    redirectTo: string;
  };

  const result = await signInWithOtpOnServer(email, redirectTo);
  return NextResponse.json(result);
}
