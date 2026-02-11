import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protected routes - redirect to login if not authenticated
  // Exclude: /login, /auth, /api (proxied to backend), /kindle/[token] (public landing)
  const isProtectedRoute = !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/api') &&
    !request.nextUrl.pathname.match(/^\/kindle\/[^/]+$/);

  if (!user && isProtectedRoute) {
    console.log('[middleware] No user, redirecting to login:', request.nextUrl.pathname);
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Already logged in and trying to access login
  if (user && request.nextUrl.pathname.startsWith('/login')) {
    const mcpRedirect = request.nextUrl.searchParams.get('redirect');
    const mcpPendingId = request.nextUrl.searchParams.get('pending_id');

    console.log('[middleware] User logged in, accessing /login', {
      hasMcpParams: !!(mcpRedirect && mcpPendingId),
      path: request.nextUrl.pathname,
    });

    if (mcpRedirect && mcpPendingId) {
      // MCP OAuth flow: user is already logged in — try to redirect straight
      // to the MCP callback with tokens. No login form flash.
      const { data: { session } } = await supabase.auth.getSession();
      const hasTokens = !!(session?.access_token && session?.refresh_token);
      console.log('[middleware] MCP flow, session tokens:', {
        hasAccessToken: !!session?.access_token,
        hasRefreshToken: !!session?.refresh_token,
      });

      if (hasTokens) {
        console.log('[middleware] Redirecting to MCP callback with tokens');
        const callbackUrl = new URL(mcpRedirect);
        callbackUrl.searchParams.set('pending_id', mcpPendingId);
        callbackUrl.searchParams.set('access_token', session.access_token);
        callbackUrl.searchParams.set('refresh_token', session.refresh_token);
        return NextResponse.redirect(callbackUrl.toString());
      }
      // Can't get both tokens from middleware — let the login form handle it.
      // The client-side Supabase client may have better access to the refresh token.
      console.log('[middleware] Missing tokens, letting login form handle MCP flow');
      return supabaseResponse;
    }

    // Normal case: redirect to dashboard
    console.log('[middleware] Redirecting to dashboard');
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
