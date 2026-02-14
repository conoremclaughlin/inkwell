import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
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

  const path = request.nextUrl.pathname;
  const isProxiedApiRoute = path.startsWith('/api/') && !path.startsWith('/api/auth/');

  // Fast-path for proxied API routes: inject bearer token only.
  // Skip getUser() to avoid duplicate Supabase round-trips on every API request.
  if (isProxiedApiRoute) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('Authorization', `Bearer ${session.access_token}`);

      const response = NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      });

      // Copy session-refresh cookies from supabaseResponse
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        response.cookies.set(cookie.name, cookie.value, cookie);
      });

      return response;
    }

    return supabaseResponse;
  }

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protected routes - redirect to login if not authenticated
  // Exclude: /login, /auth, /api (proxied to backend), /kindle/[token] (public landing)
  const isProtectedRoute =
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/signup') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/api') &&
    !request.nextUrl.pathname.match(/^\/kindle\/[^/]+$/);

  if (!user && isProtectedRoute) {
    console.log('[middleware] No user, redirecting to login:', request.nextUrl.pathname);
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Already logged in and trying to access login or signup
  const isAuthPage =
    request.nextUrl.pathname.startsWith('/login') || request.nextUrl.pathname.startsWith('/signup');
  if (user && isAuthPage) {
    const mcpPendingId = request.nextUrl.searchParams.get('pending_id');

    console.log('[middleware] User logged in, accessing auth page', {
      hasMcpPendingId: !!mcpPendingId,
      path: request.nextUrl.pathname,
    });

    if (mcpPendingId) {
      // MCP OAuth flow: user is already logged in — try to redirect straight
      // to the MCP callback with tokens. No login form flash.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      console.log('[middleware] MCP flow, session:', {
        hasAccessToken: !!session?.access_token,
      });

      if (session?.access_token) {
        console.log('[middleware] Redirecting to MCP callback with access token');
        const apiUrl =
          process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;
        const callbackUrl = new URL(`${apiUrl}/mcp/auth/callback`);
        callbackUrl.searchParams.set('pending_id', mcpPendingId);
        callbackUrl.searchParams.set('access_token', session.access_token);
        return NextResponse.redirect(callbackUrl.toString());
      }
      // Can't get access token from middleware — let the login form handle it.
      console.log('[middleware] Missing access token, letting login form handle MCP flow');
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
