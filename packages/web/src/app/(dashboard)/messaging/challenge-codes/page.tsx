'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Copy, Check } from 'lucide-react';
import { useApiQuery, useApiPost, useQueryClient } from '@/lib/api';

interface ChallengeCode {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedForPlatform: string | null;
  usedForGroupId: string | null;
}

interface CodesResponse {
  codes: ChallengeCode[];
}

export default function ChallengeCodesPage() {
  const queryClient = useQueryClient();
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Fetch codes
  const { data, isLoading, error } = useApiQuery<CodesResponse>(
    ['challenge-codes'],
    '/api/admin/challenge-codes'
  );

  // Generate code mutation
  const generateMutation = useApiPost<CodesResponse>('/api/admin/challenge-codes', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenge-codes'] });
    },
  });

  const handleGenerateCode = () => {
    generateMutation.mutate(undefined as never);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const codes = data?.codes ?? [];
  const isExpired = (expiresAt: string) => new Date(expiresAt) < new Date();
  const activeCodes = codes.filter((c) => !c.usedAt && !isExpired(c.expiresAt));
  const errorMessage = error?.message || generateMutation.error?.message;

  const getCodeStatus = (code: ChallengeCode) => {
    if (code.usedAt) {
      return <Badge variant="secondary">Used</Badge>;
    }
    if (isExpired(code.expiresAt)) {
      return <Badge variant="destructive">Expired</Badge>;
    }
    return <Badge variant="success">Active</Badge>;
  };

  // Sort: active first, then by creation date
  const sortedCodes = [...codes].sort((a, b) => {
    const aActive = !a.usedAt && !isExpired(a.expiresAt);
    const bActive = !b.usedAt && !isExpired(b.expiresAt);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Challenge Codes</h1>
          <p className="mt-2 text-gray-600">
            Generate codes to authorize new groups. Share the code with a group admin.
          </p>
        </div>
        <Button
          onClick={handleGenerateCode}
          size="sm"
          disabled={generateMutation.isPending || activeCodes.length >= 5}
        >
          <Plus className="mr-2 h-4 w-4" />
          {generateMutation.isPending ? 'Generating...' : 'Generate Code'}
        </Button>
      </div>

      {errorMessage && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{errorMessage}</div>
      )}

      {activeCodes.length >= 5 && (
        <div className="mt-4 rounded-md bg-yellow-50 p-4 text-yellow-800">
          You have reached the maximum of 5 active codes. Wait for some to expire or be used.
        </div>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {/* Instructions */}
        <Card>
          <CardHeader>
            <CardTitle>How to Use</CardTitle>
            <CardDescription>Authorize a new group in 3 steps</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
                1
              </div>
              <div>
                <p className="font-medium">Generate a code</p>
                <p className="text-sm text-gray-500">
                  Click the button above to generate a new 6-character code.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
                2
              </div>
              <div>
                <p className="font-medium">Add Myra to the group</p>
                <p className="text-sm text-gray-500">
                  Add the bot to your WhatsApp or Telegram group.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
                3
              </div>
              <div>
                <p className="font-medium">Send the authorize command</p>
                <p className="text-sm text-gray-500">
                  In the group, send:{' '}
                  <code className="bg-gray-100 px-1 rounded">/authorize CODE</code>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Active Codes */}
        <Card>
          <CardHeader>
            <CardTitle>Active Codes</CardTitle>
            <CardDescription>{activeCodes.length} of 5 codes available</CardDescription>
          </CardHeader>
          <CardContent>
            {activeCodes.length === 0 ? (
              <p className="text-gray-500 text-center py-4">
                No active codes. Generate one to get started.
              </p>
            ) : (
              <div className="space-y-3">
                {activeCodes.map((code) => (
                  <div
                    key={code.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <code className="text-2xl font-bold tracking-wider">{code.code}</code>
                      <p className="text-xs text-gray-500 mt-1">
                        Expires {new Date(code.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleCopyCode(code.code)}>
                      {copiedCode === code.code ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* History */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Code History</CardTitle>
          <CardDescription>All generated codes</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : sortedCodes.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No codes generated yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium">Code</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Created</th>
                    <th className="pb-3 font-medium">Expires</th>
                    <th className="pb-3 font-medium">Used For</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCodes.map((code) => (
                    <tr key={code.id} className="border-b">
                      <td className="py-3 font-mono font-bold">{code.code}</td>
                      <td className="py-3">{getCodeStatus(code)}</td>
                      <td className="py-3 text-sm text-gray-500">
                        {new Date(code.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 text-sm text-gray-500">
                        {new Date(code.expiresAt).toLocaleString()}
                      </td>
                      <td className="py-3 text-sm">
                        {code.usedForPlatform ? (
                          <span className="text-gray-500">{code.usedForPlatform}</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
