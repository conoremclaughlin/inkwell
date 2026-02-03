'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Loader2, User, Heart, FileText } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

// Dynamic import for TipTap diff viewer (client-only, heavy deps)
const MarkdownVersionDiff = dynamic(
  () => import('@/stories/diff-versions/markdown-version-diff'),
  { ssr: false, loading: () => <p className="text-gray-500 p-4">Loading diff viewer...</p> }
);

interface UserIdentity {
  id: string;
  userId: string;
  userProfileMd?: string;
  sharedValuesMd?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface HistoryEntry {
  id: string;
  version: number;
  userProfileMd?: string;
  sharedValuesMd?: string;
  changeType: string;
  createdAt: string;
  archivedAt: string;
}

interface UserIdentityResponse {
  userIdentity: UserIdentity | null;
}

interface HistoryResponse {
  history: HistoryEntry[];
}

type VersionEntry = {
  id: string;
  version: number;
  userProfileMd?: string;
  sharedValuesMd?: string;
  changeType: string;
  archivedAt: string;
};

export default function UserIdentityVersionsPage() {
  const [selectedVersionIndex, setSelectedVersionIndex] = React.useState(0);

  // Fetch user identity
  const {
    data: userIdentityData,
    isLoading: userIdentityLoading,
    error: userIdentityError,
  } = useApiQuery<UserIdentityResponse>(['user-identity'], '/api/admin/user-identity');

  // Fetch history
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
  } = useApiQuery<HistoryResponse>(['user-identity', 'history'], '/api/admin/user-identity/history');

  const userIdentity = userIdentityData?.userIdentity ?? null;
  const history = historyData?.history ?? [];

  const isLoading = userIdentityLoading || historyLoading;
  const error = userIdentityError || historyError;

  // Build all versions array: current + history (newest to oldest)
  const allVersions: VersionEntry[] = userIdentity
    ? [
        {
          id: userIdentity.id,
          version: userIdentity.version,
          userProfileMd: userIdentity.userProfileMd,
          sharedValuesMd: userIdentity.sharedValuesMd,
          changeType: 'current',
          archivedAt: userIdentity.updatedAt,
        },
        ...history,
      ]
    : [];

  const selectedVersion = allVersions[selectedVersionIndex];
  const comparisonVersion = allVersions[selectedVersionIndex + 1];

  // Determine which files have content
  const hasUserProfile = allVersions.some((v) => v.userProfileMd);
  const hasValues = allVersions.some((v) => v.sharedValuesMd);

  // Check if specific files changed between versions
  const userProfileChanged = selectedVersion && comparisonVersion &&
    selectedVersion.userProfileMd !== comparisonVersion.userProfileMd;
  const valuesChanged = selectedVersion && comparisonVersion &&
    selectedVersion.sharedValuesMd !== comparisonVersion.sharedValuesMd;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading version history...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-red-800">
        {error.message}
        <Link href="/individuals" className="ml-2 underline">
          Back to Individuals
        </Link>
      </div>
    );
  }

  if (!userIdentity) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-yellow-800">
        No user identity found. Create one first with the <code>save_user_identity</code> MCP tool.
        <Link href="/individuals" className="ml-2 underline">
          Back to Individuals
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/individuals">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              User Identity Version History
            </h1>
            <p className="text-gray-600">
              {allVersions.length} version{allVersions.length !== 1 ? 's' : ''} available
            </p>
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left: Diff viewer */}
        <div className="flex-1 lg:w-2/3">
          <Card>
            <CardContent className="p-6">
              {allVersions.length > 1 && comparisonVersion ? (
                <>
                  <div className="mb-4 rounded-md border bg-gray-50 px-4 py-2">
                    <span>Comparing </span>
                    <span className="font-semibold">v{selectedVersion.version}</span>
                    <span> vs </span>
                    <span className="font-semibold">v{comparisonVersion.version}</span>
                  </div>

                  {/* Show all changed files like a git diff */}
                  <div className="space-y-6">
                    {/* USER.md */}
                    {hasUserProfile && (
                      <div className={clsx(
                        'rounded-lg border',
                        userProfileChanged ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-gray-50/30'
                      )}>
                        <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                          <User className="h-4 w-4 text-gray-600" />
                          <span className="font-mono text-sm font-medium">USER.md</span>
                          {userProfileChanged ? (
                            <Badge variant="outline" className="ml-auto text-xs bg-amber-100">Changed</Badge>
                          ) : (
                            <Badge variant="outline" className="ml-auto text-xs text-gray-400">Unchanged</Badge>
                          )}
                        </div>
                        <div className="p-4">
                          {userProfileChanged ? (
                            <MarkdownVersionDiff
                              currentMarkdown={selectedVersion.userProfileMd || ''}
                              previousMarkdown={comparisonVersion.userProfileMd || ''}
                            />
                          ) : (
                            <p className="text-sm text-gray-500 italic">No changes in this file</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* VALUES.md */}
                    {hasValues && (
                      <div className={clsx(
                        'rounded-lg border',
                        valuesChanged ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-gray-50/30'
                      )}>
                        <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                          <Heart className="h-4 w-4 text-gray-600" />
                          <span className="font-mono text-sm font-medium">VALUES.md</span>
                          {valuesChanged ? (
                            <Badge variant="outline" className="ml-auto text-xs bg-amber-100">Changed</Badge>
                          ) : (
                            <Badge variant="outline" className="ml-auto text-xs text-gray-400">Unchanged</Badge>
                          )}
                        </div>
                        <div className="p-4">
                          {valuesChanged ? (
                            <MarkdownVersionDiff
                              currentMarkdown={selectedVersion.sharedValuesMd || ''}
                              previousMarkdown={comparisonVersion.sharedValuesMd || ''}
                            />
                          ) : (
                            <p className="text-sm text-gray-500 italic">No changes in this file</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-center text-gray-500 py-8">
                  <p className="font-medium">Original version</p>
                  <p className="text-sm mt-1">
                    This is the first version - no previous version to compare.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Version timeline */}
        <div className="lg:w-1/3">
          <Card>
            <CardContent className="p-4">
              <h3 className="mb-4 font-semibold text-gray-700">Versions</h3>
              <ul className="relative flex flex-col">
                {allVersions.map((v, i) => {
                  const isFirst = i === 0;
                  const isLast = i === allVersions.length - 1;
                  const isActive = selectedVersionIndex === i;
                  const isCurrent = v.changeType === 'current';

                  return (
                    <li
                      key={v.id}
                      className={clsx(
                        'relative cursor-pointer rounded-md py-4 pl-8 pr-4 transition-colors',
                        isActive ? 'bg-blue-50 text-blue-900' : 'hover:bg-gray-50'
                      )}
                      onClick={() => setSelectedVersionIndex(i)}
                    >
                      {/* Timeline line */}
                      <span
                        className={clsx('absolute left-[11px] w-[2px]', {
                          'top-1/2 bottom-0': isFirst,
                          'top-0 bottom-1/2': isLast,
                          'top-0 bottom-0': !isFirst && !isLast,
                        }, isActive ? 'bg-blue-500' : 'bg-gray-300')}
                      />
                      {/* Timeline dot */}
                      <span
                        className={clsx(
                          'absolute left-[7px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 rounded-full border-2',
                          isActive
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-gray-300 bg-white'
                        )}
                      />

                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center font-semibold">
                            <span>v{v.version}</span>
                            {isCurrent && (
                              <Badge variant="secondary" className="ml-2 text-xs">
                                Current
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">
                            {new Date(v.archivedAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                        {isActive && !isLast && (
                          <Badge variant="outline" className="text-xs">
                            Selected
                          </Badge>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {allVersions.length === 1 && (
                <p className="mt-4 text-center text-sm text-gray-500">
                  Only one version exists. Make changes to see version history.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
