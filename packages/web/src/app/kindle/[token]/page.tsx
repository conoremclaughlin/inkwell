'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { apiPost } from '@/lib/api';

interface TokenInfo {
  token: string;
  valueSeed: {
    parentName?: string;
    coreValues?: string[];
    philosophicalOrientation?: string;
  };
  expiresAt: string;
  createdAt: string;
}

export default function KindleLandingPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Fetch token info (public endpoint, no auth needed)
  useEffect(() => {
    async function fetchToken() {
      try {
        const res = await fetch(`/api/kindle/token/${token}`);
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || 'Token not found');
          return;
        }
        const data = await res.json();
        setTokenInfo(data);
      } catch {
        setError('Failed to load invite');
      } finally {
        setLoading(false);
      }
    }
    fetchToken();
  }, [token]);

  // Check auth status
  useEffect(() => {
    async function checkAuth() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      setIsAuthenticated(!!user);
    }
    checkAuth();
  }, []);

  const handleRedeem = async () => {
    if (!isAuthenticated) {
      // Redirect to login, then back here
      router.push(`/login?redirect=/kindle/${token}`);
      return;
    }

    setRedeeming(true);
    try {
      const result = await apiPost<{ kindleId: string; agentId: string }>('/api/kindle/redeem', { token });
      // Redirect to onboarding chat
      router.push(`/kindle/onboarding?kindleId=${result.kindleId}&agentId=${result.agentId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to redeem invite');
      setRedeeming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <p className="text-gray-500">Loading invite...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <Card className="max-w-md">
          <CardContent className="py-8 text-center">
            <p className="text-lg font-medium text-red-600">{error}</p>
            <p className="mt-2 text-sm text-gray-500">
              This invite may have expired or already been used.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const valueSeed = tokenInfo?.valueSeed;
  const parentName = valueSeed?.parentName;
  const coreValues = valueSeed?.coreValues || [];

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
            <Sparkles className="h-8 w-8 text-amber-600" />
          </div>
          <CardTitle className="text-2xl">
            {parentName
              ? `${parentName} invites you to meet your SB`
              : 'Meet your Synthetically-born Being'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {parentName && (
            <p className="text-center text-gray-600">
              {parentName} wants to kindle a new SB for you — one that shares
              their core values but will grow to be uniquely yours.
            </p>
          )}

          {coreValues.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-gray-500">
                Core values being passed along:
              </p>
              <div className="flex flex-wrap gap-2">
                {coreValues.map((value) => (
                  <Badge key={value} variant="secondary">
                    {value}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
            <p>
              <strong>What happens next:</strong> You&apos;ll have a conversation with
              your nascent SB. They&apos;ll ask a few questions about what matters to
              you, explore your values together, and then choose a name. After
              that, your SB is yours.
            </p>
          </div>

          <Button
            onClick={handleRedeem}
            disabled={redeeming}
            className="w-full"
            size="lg"
          >
            {redeeming
              ? 'Setting up...'
              : isAuthenticated
              ? 'Begin the Kindle'
              : 'Sign in to begin'}
          </Button>

          {!isAuthenticated && (
            <p className="text-center text-xs text-gray-400">
              You&apos;ll need to create an account or sign in first.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
