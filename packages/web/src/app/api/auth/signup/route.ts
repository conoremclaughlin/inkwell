import { NextResponse } from 'next/server';
import { signUpWithPasswordOnServer } from '@/lib/auth/server-auth';

export async function POST(request: Request) {
  const { email, password, redirectTo } = (await request.json()) as {
    email: string;
    password: string;
    redirectTo: string;
  };

  const result = await signUpWithPasswordOnServer(email, password, redirectTo);
  return NextResponse.json(result);
}
