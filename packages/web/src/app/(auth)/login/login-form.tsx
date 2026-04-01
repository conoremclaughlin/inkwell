'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SocialButtons } from '@/components/auth/social-buttons';
import { AuthDivider } from '@/components/auth/auth-divider';
import { signInWithPassword, signInWithOtp } from '@/lib/auth/actions';
import { getErrorMessage } from '@/lib/auth-utils';
import { Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuthMode = 'magic-link' | 'password';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mcpRedirecting, setMcpRedirecting] = useState(false);

  const mcpPendingId = searchParams.get('pending_id');
  const isMcpAuth = !!mcpPendingId;

  useEffect(() => {
    const error = searchParams.get('error');
    if (error) {
      const decodedError = decodeURIComponent(error);
      setMessage({ type: 'error', text: getErrorMessage(decodedError) });
      if (decodedError.toLowerCase().includes('rate')) {
        setAuthMode('password');
      }
      const newUrl = isMcpAuth ? `/login?pending_id=${mcpPendingId}` : '/login';
      window.history.replaceState({}, '', newUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMagicLink = async () => {
    const callbackUrl = isMcpAuth
      ? `${window.location.origin}/auth/callback?mcp_pending_id=${mcpPendingId}`
      : `${window.location.origin}/auth/callback`;

    const result = await signInWithOtp(email, callbackUrl);

    if ('error' in result) {
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
      setMcpRedirecting(true);
      window.location.href = result.mcpRedirectUrl;
    } else {
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

  if (mcpRedirecting) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">Inkstand</h2>
        <p className="mt-2 text-sm text-gray-500">Granting MCP access to Claude Code...</p>
        <div className="mt-8 flex justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
        <p className="mt-4 text-sm text-gray-400">
          Redirecting back to your terminal. You can close this tab once connected.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">Welcome back</h2>
        <p className="mt-2 text-sm text-gray-500">
          {isMcpAuth
            ? 'Sign in to connect Claude Code to Inkstand.'
            : 'Sign in to your Inkstand account.'}
        </p>
        {isMcpAuth && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            <Zap className="h-3.5 w-3.5" />
            Authenticating for Claude Code MCP connection
          </div>
        )}
      </div>

      <SocialButtons
        mode="login"
        isLoading={isLoading}
        onOAuthStart={() => setIsLoading(true)}
        onOAuthError={(error) => {
          setIsLoading(false);
          setMessage({ type: 'error', text: error });
        }}
        mcpPendingId={mcpPendingId}
      />

      <AuthDivider />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium text-gray-700">
            Email address
          </label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="h-12 rounded-xl px-4 text-base"
          />
        </div>

        {authMode === 'password' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="text-sm font-medium text-gray-700">
                Password
              </label>
              <button
                type="button"
                onClick={() => setAuthMode('magic-link')}
                className="text-xs text-indigo-600 hover:text-indigo-500 transition-colors"
              >
                Use magic link instead
              </button>
            </div>
            <Input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="h-12 rounded-xl px-4 text-base"
            />
          </div>
        )}

        {authMode === 'magic-link' && (
          <button
            type="button"
            onClick={() => setAuthMode('password')}
            className="text-xs text-indigo-600 hover:text-indigo-500 transition-colors"
          >
            Use password instead
          </button>
        )}

        {message && (
          <div
            className={cn(
              'rounded-lg px-4 py-3 text-sm',
              message.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            )}
          >
            {message.text}
          </div>
        )}

        <Button
          type="submit"
          className="w-full h-12 rounded-xl text-base font-semibold"
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {authMode === 'magic-link' ? 'Sending...' : 'Signing in...'}
            </span>
          ) : authMode === 'magic-link' ? (
            'Send Magic Link'
          ) : (
            'Sign In'
          )}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-gray-500">
        Don&apos;t have an account?{' '}
        <Link
          href={isMcpAuth ? `/signup?pending_id=${mcpPendingId}` : '/signup'}
          className="font-medium text-indigo-600 hover:text-indigo-500 transition-colors"
        >
          Sign up
        </Link>
      </p>
    </>
  );
}
