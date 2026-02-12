import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  // MCP OAuth redirect params (passed through from magic link)
  const mcpPendingId = searchParams.get('mcp_pending_id');
  const isMcpAuth = !!mcpPendingId;

  // Check for error from Supabase (e.g., expired link)
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const errorParam = encodeURIComponent(errorDescription || error);
    // Preserve MCP pending_id in error redirect
    const loginUrl = isMcpAuth
      ? `${origin}/login?error=${errorParam}&pending_id=${mcpPendingId}`
      : `${origin}/login?error=${errorParam}`;
    return NextResponse.redirect(loginUrl);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (!exchangeError && data.session) {
      // If this is MCP auth, redirect to MCP callback with tokens
      if (isMcpAuth) {
        const apiUrl =
          process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;
        const mcpCallbackUrl = new URL(`${apiUrl}/mcp/auth/callback`);
        mcpCallbackUrl.searchParams.set('pending_id', mcpPendingId!);
        mcpCallbackUrl.searchParams.set('access_token', data.session.access_token);
        return NextResponse.redirect(mcpCallbackUrl.toString());
      }

      // Normal dashboard redirect
      return NextResponse.redirect(`${origin}${next}`);
    }

    // Pass specific error message
    const errorMessage = encodeURIComponent(exchangeError?.message || 'Failed to exchange code');
    const loginUrl = isMcpAuth
      ? `${origin}/login?error=${errorMessage}&pending_id=${mcpPendingId}`
      : `${origin}/login?error=${errorMessage}`;
    return NextResponse.redirect(loginUrl);
  }

  // No code provided
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent('No authentication code provided')}`
  );
}
