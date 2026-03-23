import { NextResponse } from 'next/server';
import { signInWithPasswordOnServer } from '@/lib/auth/server-auth';

export async function POST(request: Request) {
  const { email, password, mcpPendingId } = (await request.json()) as {
    email: string;
    password: string;
    mcpPendingId?: string | null;
  };

  const result = await signInWithPasswordOnServer(email, password, mcpPendingId);
  return NextResponse.json(result);
}
