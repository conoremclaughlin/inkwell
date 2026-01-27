'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';

type AuthMode = 'magic-link' | 'password';

// Map common error messages to user-friendly text
function getErrorMessage(error: string): string {
  const errorMap: Record<string, string> = {
    'auth': 'Authentication failed. Please try again.',
    'code challenge does not match previously saved code verifier':
      'Your magic link expired or was opened in a different browser. Please request a new one using the same browser.',
    'Email link is invalid or has expired':
      'This magic link has expired. Please request a new one.',
    'No authentication code provided':
      'Invalid login link. Please request a new magic link.',
    'Invalid login credentials':
      'Invalid email or password. Please try again.',
    'Email not confirmed':
      'Please confirm your email address before signing in.',
    'rate limit':
      'Too many requests. Please try signing in with password instead.',
  };

  // Check for partial matches
  for (const [key, value] of Object.entries(errorMap)) {
    if (error.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }

  return error;
}

export default function LoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
      // Clear the error from URL without reload
      window.history.replaceState({}, '', '/login');
    }
  }, [searchParams]);

  const handleMagicLink = async () => {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      // If rate limited, suggest password mode
      if (error.message.toLowerCase().includes('rate')) {
        setMessage({
          type: 'error',
          text: 'Rate limit reached. Please sign in with password instead.'
        });
        setAuthMode('password');
      } else {
        setMessage({ type: 'error', text: error.message });
      }
    } else {
      setMessage({
        type: 'success',
        text: 'Check your email for a magic link to sign in.',
      });
    }
  };

  const handlePassword = async () => {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setMessage({ type: 'error', text: getErrorMessage(error.message) });
    } else {
      // Successful login - redirect to dashboard
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">PCP Admin</CardTitle>
          <CardDescription>
            Sign in to access the admin dashboard.
          </CardDescription>
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
