'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { signInWithPassword, signInWithOtp } from '@/lib/auth/actions';

type AuthMode = 'magic-link' | 'password';

// Map common error messages to user-friendly text
function getErrorMessage(error: string): string {
  const errorMap: Record<string, string> = {
    auth: 'Authentication failed. Please try again.',
    'code challenge does not match previously saved code verifier':
      'Your magic link expired or was opened in a different browser. Please request a new one using the same browser.',
    'Email link is invalid or has expired':
      'This magic link has expired. Please request a new one.',
    'No authentication code provided': 'Invalid login link. Please request a new magic link.',
    'Invalid login credentials': 'Invalid email or password. Please try again.',
    'Email not confirmed': 'Please confirm your email address before signing in.',
    'rate limit': 'Too many requests. Please try signing in with password instead.',
  };

  // Check for partial matches
  for (const [key, value] of Object.entries(errorMap)) {
    if (error.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }

  return error;
}

export default function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mcpRedirecting, setMcpRedirecting] = useState(false);

  // MCP OAuth redirect params
  const mcpPendingId = searchParams.get('pending_id');
  const isMcpAuth = !!mcpPendingId;

  // Check for error in URL params on mount
  useEffect(() => {
    const error = searchParams.get('error');
    if (error) {
      const decodedError = decodeURIComponent(error);
      setMessage({ type: 'error', text: getErrorMessage(decodedError) });
      // If rate limited, switch to password mode
      if (decodedError.toLowerCase().includes('rate')) {
        setAuthMode('password');
      }
      // Clear the error from URL without reload (preserve MCP params)
      const newUrl = isMcpAuth ? `/login?pending_id=${mcpPendingId}` : '/login';
      window.history.replaceState({}, '', newUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount — searchParams causes infinite loop when URL is modified

  const handleMagicLink = async () => {
    // For MCP auth, include the pending_id in the callback URL
    const callbackUrl = isMcpAuth
      ? `${window.location.origin}/auth/callback?mcp_pending_id=${mcpPendingId}`
      : `${window.location.origin}/auth/callback`;

    const result = await signInWithOtp(email, callbackUrl);

    if ('error' in result) {
      // If rate limited, suggest password mode
      if (result.error.toLowerCase().includes('rate')) {
        setMessage({
          type: 'error',
          text: 'Rate limit reached. Please sign in with password instead.',
        });
        setAuthMode('password');
      } else {
        setMessage({ type: 'error', text: result.error });
      }
    } else {
      setMessage({
        type: 'success',
        text: 'Check your email for a magic link to sign in.',
      });
    }
  };

  const handlePassword = async () => {
    const result = await signInWithPassword(email, password, mcpPendingId);

    if ('error' in result) {
      setMessage({ type: 'error', text: getErrorMessage(result.error) });
    } else if ('mcpRedirectUrl' in result) {
      // MCP flow: redirect to callback with tokens
      setMcpRedirecting(true);
      window.location.href = result.mcpRedirectUrl;
    } else {
      // Normal dashboard redirect
      router.push('/');
      router.refresh();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(null);

    try {
      if (authMode === 'magic-link') {
        await handleMagicLink();
      } else {
        await handlePassword();
      }
    } catch {
      setMessage({ type: 'error', text: 'An unexpected error occurred.' });
    } finally {
      setIsLoading(false);
    }
  };

  // Already logged in + MCP auth → show granting access view
  if (mcpRedirecting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">PCP</CardTitle>
            <CardDescription>Granting MCP access to Claude Code...</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4 py-6">
            <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
            <p className="text-sm text-gray-500">
              Redirecting back to your terminal. You can close this tab once connected.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">PCP Admin</CardTitle>
          <CardDescription>
            {isMcpAuth
              ? 'Sign in to connect Claude Code to PCP.'
              : 'Sign in to access the admin dashboard.'}
          </CardDescription>
          {isMcpAuth && (
            <div className="mt-2 text-xs text-blue-600 bg-blue-50 rounded-md px-3 py-2">
              Authenticating for Claude Code MCP connection
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* Auth mode toggle */}
          <div className="flex mb-6 border rounded-lg p-1 bg-gray-50">
            <button
              type="button"
              onClick={() => setAuthMode('password')}
              className={`flex-1 py-2 px-4 text-sm font-medium rounded-md transition-colors ${
                authMode === 'password'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setAuthMode('magic-link')}
              className={`flex-1 py-2 px-4 text-sm font-medium rounded-md transition-colors ${
                authMode === 'magic-link'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Magic Link
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            {authMode === 'password' && (
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
            )}

            {message && (
              <div
                className={`rounded-md p-3 text-sm ${
                  message.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {message.text}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading
                ? 'Signing in...'
                : authMode === 'magic-link'
                  ? 'Send Magic Link'
                  : 'Sign In'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
