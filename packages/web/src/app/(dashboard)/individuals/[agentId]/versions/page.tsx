'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Loader2, Sparkles, FileText, Zap } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';
import clsx from 'clsx';

// Dynamic import for TipTap diff viewer (client-only, heavy deps)
const MarkdownVersionDiff = dynamic(() => import('@/stories/diff-versions/markdown-version-diff'), {
  ssr: false,
  loading: () => <p className="text-gray-500 p-4">Loading diff viewer...</p>,
});

interface Identity {
  id: string;
  agentId: string;
  name: string;
  role: string;
  description?: string;
  values?: string[];
  relationships?: Record<string, string>;
  capabilities?: string[];
  heartbeat?: string;
  soul?: string;
  hasSoul: boolean;
  hasHeartbeat: boolean;
  version: number;
  updatedAt: string;
}

interface HistoryEntry {
  id: string;
  version: number;
  name: string;
  role: string;
  description?: string;
  values?: string[];
  relationships?: Record<string, string>;
  capabilities?: string[];
  heartbeat?: string;
  soul?: string;
  hasSoul: boolean;
  hasHeartbeat: boolean;
  changeType: string;
  archivedAt: string;
}

interface IndividualsResponse {
  individuals: Identity[];
}

interface HistoryResponse {
  history: HistoryEntry[];
}

/**
 * Generate identity document content from identity data
 */
function generateIdentityMarkdown(version: HistoryEntry): string {
  const lines: string[] = [];

  lines.push(`# ${version.name}`);
  lines.push('');
  lines.push(`**Role:** ${version.role}`);
  lines.push('');

  if (version.description) {
    lines.push('## Nature');
    lines.push('');
    lines.push(version.description);
    lines.push('');
  }

  if (version.values && version.values.length > 0) {
    lines.push('## Values');
    lines.push('');
    for (const value of version.values) {
      lines.push(`- ${value}`);
    }
    lines.push('');
  }

  if (version.capabilities && version.capabilities.length > 0) {
    lines.push('## Capabilities');
    lines.push('');
    for (const cap of version.capabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push('');
  }

  if (version.relationships && Object.keys(version.relationships).length > 0) {
    lines.push('## Relationships');
    lines.push('');
    for (const [agent, desc] of Object.entries(version.relationships)) {
      lines.push(`- **${agent}:** ${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export default function VersionExplorerPage() {
  const params = useParams();
  const agentId = params.agentId as string;

  const [selectedVersionIndex, setSelectedVersionIndex] = React.useState(0);

  // Fetch identity
  const {
    data: individualsData,
    isLoading: individualsLoading,
    error: individualsError,
  } = useApiQuery<IndividualsResponse>(['individuals'], '/api/admin/individuals');

  // Fetch history
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
  } = useApiQuery<HistoryResponse>(
    ['individuals', agentId, 'history'],
    `/api/admin/individuals/${agentId}/history`
  );

  const identity = individualsData?.individuals.find((i) => i.agentId === agentId) ?? null;
  const history = historyData?.history ?? [];

  const isLoading = individualsLoading || historyLoading;
  const error = individualsError || historyError;

  // Build all versions array: current + history (newest to oldest)
  const allVersions: HistoryEntry[] = identity
    ? [
        {
          id: identity.id,
          version: identity.version,
          name: identity.name,
          role: identity.role,
          description: identity.description,
          values: identity.values,
          relationships: identity.relationships,
          capabilities: identity.capabilities,
          heartbeat: identity.heartbeat,
          soul: identity.soul,
          hasSoul: identity.hasSoul,
          hasHeartbeat: identity.hasHeartbeat,
          changeType: 'current',
          archivedAt: identity.updatedAt,
        },
        ...history,
      ]
    : [];

  const selectedVersion = allVersions[selectedVersionIndex];
  const comparisonVersion = allVersions[selectedVersionIndex + 1];

  // Determine which files have content across any version
  const hasIdentity = allVersions.some(
    (v) => v.description || v.values?.length || v.capabilities?.length || v.relationships
  );
  const hasSoul = allVersions.some((v) => v.soul);
  const hasHeartbeat = allVersions.some((v) => v.heartbeat);

  // Check if specific files changed between versions
  const currentIdentityMd = selectedVersion ? generateIdentityMarkdown(selectedVersion) : '';
  const prevIdentityMd = comparisonVersion ? generateIdentityMarkdown(comparisonVersion) : '';
  const identityChanged = currentIdentityMd !== prevIdentityMd;
  const soulChanged = selectedVersion?.soul !== comparisonVersion?.soul;
  const heartbeatChanged = selectedVersion?.heartbeat !== comparisonVersion?.heartbeat;

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

  if (!identity) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-yellow-800">
        Identity not found: {agentId}
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
            <h1 className="text-2xl font-bold text-gray-900">{identity.name} Version History</h1>
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
                    {/* Identity profile */}
                    <div
                      className={clsx(
                        'rounded-lg border',
                        identityChanged
                          ? 'border-amber-200 bg-amber-50/30'
                          : 'border-gray-200 bg-gray-50/30'
                      )}
                    >
                      <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                        <FileText className="h-4 w-4 text-gray-600" />
                        <span className="text-sm font-medium">Identity profile</span>
                        {identityChanged ? (
                          <Badge variant="outline" className="ml-auto text-xs bg-amber-100">
                            Changed
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-auto text-xs text-gray-400">
                            Unchanged
                          </Badge>
                        )}
                      </div>
                      <div className="p-4">
                        {identityChanged ? (
                          <MarkdownVersionDiff
                            currentMarkdown={currentIdentityMd}
                            previousMarkdown={prevIdentityMd}
                          />
                        ) : (
                          <p className="text-sm text-gray-500 italic">No changes in this file</p>
                        )}
                      </div>
                    </div>

                    {/* Constitution */}
                    <div
                      className={clsx(
                        'rounded-lg border',
                        soulChanged
                          ? 'border-amber-200 bg-amber-50/30'
                          : 'border-gray-200 bg-gray-50/30'
                      )}
                    >
                      <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                        <Sparkles className="h-4 w-4 text-amber-500" />
                        <span className="text-sm font-medium">Constitution</span>
                        {soulChanged ? (
                          <Badge variant="outline" className="ml-auto text-xs bg-amber-100">
                            Changed
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-auto text-xs text-gray-400">
                            Unchanged
                          </Badge>
                        )}
                      </div>
                      <div className="p-4">
                        {soulChanged ? (
                          <MarkdownVersionDiff
                            currentMarkdown={normalizeDocMarkdown(selectedVersion?.soul)}
                            previousMarkdown={normalizeDocMarkdown(comparisonVersion?.soul)}
                          />
                        ) : (
                          <p className="text-sm text-gray-500 italic">No changes in this file</p>
                        )}
                      </div>
                    </div>

                    {/* Operating guide */}
                    <div
                      className={clsx(
                        'rounded-lg border',
                        heartbeatChanged
                          ? 'border-amber-200 bg-amber-50/30'
                          : 'border-gray-200 bg-gray-50/30'
                      )}
                    >
                      <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                        <Zap className="h-4 w-4 text-blue-500" />
                        <span className="text-sm font-medium">Operating guide</span>
                        {heartbeatChanged ? (
                          <Badge variant="outline" className="ml-auto text-xs bg-amber-100">
                            Changed
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-auto text-xs text-gray-400">
                            Unchanged
                          </Badge>
                        )}
                      </div>
                      <div className="p-4">
                        {heartbeatChanged ? (
                          <MarkdownVersionDiff
                            currentMarkdown={normalizeDocMarkdown(selectedVersion?.heartbeat)}
                            previousMarkdown={normalizeDocMarkdown(comparisonVersion?.heartbeat)}
                          />
                        ) : (
                          <p className="text-sm text-gray-500 italic">No changes in this file</p>
                        )}
                      </div>
                    </div>
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
                      {/* Timeline dot */}
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
                            {v.hasSoul && (
                              <span title="Has Soul">
                                <Sparkles className="ml-2 h-3 w-3 text-amber-500" />
                              </span>
                            )}
                            {v.hasHeartbeat && (
                              <span title="Has Heartbeat">
                                <Zap className="ml-2 h-3 w-3 text-blue-500" />
                              </span>
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
