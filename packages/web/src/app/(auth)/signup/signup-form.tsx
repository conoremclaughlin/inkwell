'use client';

import { useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SocialButtons } from '@/components/auth/social-buttons';
import { AuthDivider } from '@/components/auth/auth-divider';
import { signUpWithPassword } from '@/lib/auth/actions';
import { getErrorMessage } from '@/lib/auth-utils';
import { Loader2, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PasswordRequirement {
  label: string;
  test: (pw: string) => boolean;
}

const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { label: 'At least 8 characters', test: (pw) => pw.length >= 8 },
  { label: 'Contains a number', test: (pw) => /\d/.test(pw) },
  { label: 'Contains a letter', test: (pw) => /[a-zA-Z]/.test(pw) },
];

export default function SignupForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const mcpPendingId = searchParams.get('pending_id');
  const isMcpAuth = !!mcpPendingId;

  const passwordChecks = useMemo(
    () => PASSWORD_REQUIREMENTS.map((req) => ({ ...req, met: req.test(password) })),
    [password]
  );

  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;
  const allRequirementsMet = passwordChecks.every((c) => c.met);
  const canSubmit = email && allRequirementsMet && passwordsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsLoading(true);
    setMessage(null);

    try {
      const callbackUrl = new URL(`${window.location.origin}/auth/callback`);
      if (mcpPendingId) {
        callbackUrl.searchParams.set('mcp_pending_id', mcpPendingId);
      }

      const result = await signUpWithPassword(email, password, callbackUrl.toString());

      if ('error' in result) {
        setMessage({ type: 'error', text: getErrorMessage(result.error) });
      } else {
        setMessage({
          type: 'success',
          text: 'Check your email for a confirmation link to complete your signup.',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'An unexpected error occurred.' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">Create your account</h2>
        <p className="mt-2 text-sm text-gray-500">Get started with Inkstand.</p>
      </div>

      <SocialButtons
        mode="signup"
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
          <label htmlFor="signup-email" className="text-sm font-medium text-gray-700">
            Email address
          </label>
          <Input
            id="signup-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="h-12 rounded-xl px-4 text-base"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="signup-password" className="text-sm font-medium text-gray-700">
            Password
          </label>
          <Input
            id="signup-password"
            type="password"
            placeholder="Create a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="h-12 rounded-xl px-4 text-base"
          />

          {password.length > 0 && (
            <ul className="mt-2 space-y-1">
              {passwordChecks.map((check) => (
                <li
                  key={check.label}
                  className={cn(
                    'flex items-center gap-2 text-xs transition-colors',
                    check.met ? 'text-emerald-600' : 'text-gray-400'
                  )}
                >
                  {check.met ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {check.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="signup-confirm" className="text-sm font-medium text-gray-700">
            Confirm password
          </label>
          <Input
            id="signup-confirm"
            type="password"
            placeholder="Confirm your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            className={cn(
              'h-12 rounded-xl px-4 text-base',
              confirmPassword.length > 0 &&
                !passwordsMatch &&
                'border-red-300 focus-visible:ring-red-500'
            )}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
          )}
        </div>

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
          disabled={isLoading || !canSubmit}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account...
            </span>
          ) : (
            'Create Account'
          )}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-gray-500">
        Already have an account?{' '}
        <Link
          href={isMcpAuth ? `/login?pending_id=${mcpPendingId}` : '/login'}
          className="font-medium text-indigo-600 hover:text-indigo-500 transition-colors"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
