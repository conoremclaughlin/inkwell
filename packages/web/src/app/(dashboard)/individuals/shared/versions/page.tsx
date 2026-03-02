'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { ArrowLeft, History, Loader2, Sparkles, User, Workflow } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApiQuery } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';

const MarkdownVersionDiff = dynamic(() => import('@/stories/diff-versions/markdown-version-diff'), {
  ssr: false,
  loading: () => <p className="p-4 text-gray-500">Loading diff viewer...</p>,
});

interface UserIdentity {
  id: string;
  userId: string;
  userProfile?: string;
  sharedValues?: string;
  process?: string;
  // Deprecated aliases kept for compatibility during migration
  userProfileMd?: string;
  sharedValuesMd?: string;
  processMd?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface HistoryEntry {
  id: string;
  version: number;
  userProfile?: string;
  sharedValues?: string;
  process?: string;
  // Deprecated aliases kept for compatibility during migration
  userProfileMd?: string;
  sharedValuesMd?: string;
  processMd?: string;
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
  userProfile?: string;
  sharedValues?: string;
  process?: string;
  changeType: string;
  archivedAt: string;
};

function DiffPanel({
  icon,
  label,
  changed,
  current,
  previous,
}: {
  icon: ReactNode;
  label: string;
  changed: boolean;
  current: string;
  previous: string;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border',
        changed ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-gray-50/30'
      )}
    >
      <div className="flex items-center gap-2 rounded-t-lg border-b bg-white/50 px-4 py-2">
        {icon}
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {changed ? (
          <Badge variant="outline" className="ml-auto bg-amber-100 text-xs">
            Changed
          </Badge>
        ) : (
          <Badge variant="outline" className="ml-auto text-xs text-gray-400">
            Unchanged
          </Badge>
        )}
      </div>
      <div className="p-4">
        {changed ? (
          <MarkdownVersionDiff currentMarkdown={current} previousMarkdown={previous} />
        ) : (
          <p className="text-sm italic text-gray-500">No changes in this document.</p>
        )}
      </div>
    </div>
  );
}

export default function SharedVersionsPage() {
  const [selectedVersionIndex, setSelectedVersionIndex] = React.useState(0);

  const {
    data: userIdentityData,
    isLoading: userIdentityLoading,
    error: userIdentityError,
  } = useApiQuery<UserIdentityResponse>(['user-identity'], '/api/admin/user-identity');

  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
  } = useApiQuery<HistoryResponse>(
    ['user-identity', 'history'],
    '/api/admin/user-identity/history'
  );

  const userIdentity = userIdentityData?.userIdentity ?? null;
  const history = historyData?.history ?? [];

  const isLoading = userIdentityLoading || historyLoading;
  const error = userIdentityError || historyError;

  const allVersions: VersionEntry[] = userIdentity
    ? [
        {
          id: userIdentity.id,
          version: userIdentity.version,
          userProfile: userIdentity.userProfile ?? userIdentity.userProfileMd,
          sharedValues: userIdentity.sharedValues ?? userIdentity.sharedValuesMd,
          process: userIdentity.process ?? userIdentity.processMd,
          changeType: 'current',
          archivedAt: userIdentity.updatedAt,
        },
        ...history.map((entry) => ({
          ...entry,
          userProfile: entry.userProfile ?? entry.userProfileMd,
          sharedValues: entry.sharedValues ?? entry.sharedValuesMd,
          process: entry.process ?? entry.processMd,
        })),
      ]
    : [];

  const selectedVersion = allVersions[selectedVersionIndex];
  const comparisonVersion = allVersions[selectedVersionIndex + 1];

  const hasUserProfile = allVersions.some((v) => v.userProfile);
  const hasValues = allVersions.some((v) => v.sharedValues);
  const hasProcess = allVersions.some((v) => v.process);

  const userProfileChanged =
    !!selectedVersion &&
    !!comparisonVersion &&
    selectedVersion.userProfile !== comparisonVersion.userProfile;
  const valuesChanged =
    !!selectedVersion &&
    !!comparisonVersion &&
    selectedVersion.sharedValues !== comparisonVersion.sharedValues;
  const processChanged =
    !!selectedVersion &&
    !!comparisonVersion &&
    selectedVersion.process !== comparisonVersion.process;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading shared version history...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-red-800">
        {error.message}
        <Link href="/individuals/shared" className="ml-2 underline">
          Back to shared docs
        </Link>
      </div>
    );
  }

  if (!userIdentity) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-yellow-800">
        No shared identity found yet.
        <Link href="/individuals" className="ml-2 underline">
          Back to Individuals
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/individuals/shared">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Shared context history</h1>
            <p className="text-gray-600">
              {allVersions.length} version{allVersions.length !== 1 ? 's' : ''} available
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
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

                  <div className="space-y-6">
                    {hasUserProfile && (
                      <DiffPanel
                        icon={<User className="h-4 w-4 text-blue-600" />}
                        label="About you"
                        changed={userProfileChanged}
                        current={normalizeDocMarkdown(selectedVersion.userProfile)}
                        previous={normalizeDocMarkdown(comparisonVersion.userProfile)}
                      />
                    )}

                    {hasValues && (
                      <DiffPanel
                        icon={<Sparkles className="h-4 w-4 text-amber-600" />}
                        label="Shared values"
                        changed={valuesChanged}
                        current={normalizeDocMarkdown(selectedVersion.sharedValues)}
                        previous={normalizeDocMarkdown(comparisonVersion.sharedValues)}
                      />
                    )}

                    {hasProcess && (
                      <DiffPanel
                        icon={<Workflow className="h-4 w-4 text-emerald-600" />}
                        label="Process"
                        changed={processChanged}
                        current={normalizeDocMarkdown(selectedVersion.process)}
                        previous={normalizeDocMarkdown(comparisonVersion.process)}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="py-8 text-center text-gray-500">
                  <p className="font-medium">Original version</p>
                  <p className="mt-1 text-sm">
                    This is the first version, so there is nothing to diff yet.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:w-1/3">
          <Card>
            <CardContent className="p-4">
              <h3 className="mb-4 flex items-center gap-2 font-semibold text-gray-700">
                <History className="h-4 w-4" />
                Versions
              </h3>
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
                      <span
                        className={clsx(
                          'absolute left-[11px] w-[2px]',
                          {
                            'top-1/2 bottom-0': isFirst,
                            'top-0 bottom-1/2': isLast,
                            'top-0 bottom-0': !isFirst && !isLast,
                          },
                          isActive ? 'bg-blue-500' : 'bg-gray-300'
                        )}
                      />
                      <span
                        className={clsx(
                          'absolute left-[7px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 rounded-full border-2',
                          isActive ? 'border-blue-500 bg-blue-500' : 'border-gray-300 bg-white'
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
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
