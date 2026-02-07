import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  // MCP OAuth redirect params (passed through from magic link)
  const mcpRedirect = searchParams.get('mcp_redirect');
  const mcpPendingId = searchParams.get('mcp_pending_id');
  const isMcpAuth = !!(mcpRedirect && mcpPendingId);

  // Check for error from Supabase (e.g., expired link)
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const errorParam = encodeURIComponent(errorDescription || error);
    // Preserve MCP params in error redirect
    const loginUrl = isMcpAuth
      ? `${origin}/login?error=${errorParam}&redirect=${encodeURIComponent(mcpRedirect!)}&pending_id=${mcpPendingId}`
      : `${origin}/login?error=${errorParam}`;
    return NextResponse.redirect(loginUrl);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (!exchangeError && data.session) {
      // If this is MCP auth, redirect to MCP callback with access token
      if (isMcpAuth) {
        const mcpCallbackUrl = new URL(mcpRedirect);
        mcpCallbackUrl.searchParams.set('pending_id', mcpPendingId!);
        mcpCallbackUrl.searchParams.set('access_token', data.session.access_token);
        mcpCallbackUrl.searchParams.set('refresh_token', data.session.refresh_token);
        return NextResponse.redirect(mcpCallbackUrl.toString());
      }

      // Normal dashboard redirect
      return NextResponse.redirect(`${origin}${next}`);
    }

    // Pass specific error message
    const errorMessage = encodeURIComponent(exchangeError?.message || 'Failed to exchange code');
    const loginUrl = isMcpAuth
      ? `${origin}/login?error=${errorMessage}&redirect=${encodeURIComponent(mcpRedirect!)}&pending_id=${mcpPendingId}`
      : `${origin}/login?error=${errorMessage}`;
    return NextResponse.redirect(loginUrl);
  }

  // No code provided
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('No authentication code provided')}`);
}
