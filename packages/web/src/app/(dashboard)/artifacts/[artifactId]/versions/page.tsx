'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Loader2,
  BookOpen,
  Lightbulb,
  FileCheck,
  FileText,
  StickyNote,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

// Dynamic import for TipTap diff viewer (client-only, heavy deps)
const ArtifactVersionDiff = dynamic(() => import('@/stories/diff-versions/artifact-version-diff'), {
  ssr: false,
  loading: () => <p className="text-gray-500 p-4">Loading diff viewer...</p>,
});

interface Artifact {
  id: string;
  uri: string;
  title: string;
  content: string;
  artifactType: 'spec' | 'design' | 'decision' | 'document' | 'note';
  version: number;
  updatedAt: string;
}

interface HistoryEntry {
  id: string;
  version: number;
  title: string;
  content: string;
  changedByAgentId?: string;
  changedByUserId?: string;
  changeType: string;
  changeSummary?: string;
  createdAt: string;
}

interface ArtifactResponse {
  artifact: Artifact;
}

interface HistoryResponse {
  artifactId: string;
  history: HistoryEntry[];
}

const typeConfig = {
  spec: { icon: BookOpen, label: 'Spec', color: 'text-purple-600' },
  design: { icon: Lightbulb, label: 'Design', color: 'text-blue-600' },
  decision: { icon: FileCheck, label: 'Decision', color: 'text-green-600' },
  document: { icon: FileText, label: 'Document', color: 'text-gray-600' },
  note: { icon: StickyNote, label: 'Note', color: 'text-yellow-600' },
};

export default function ArtifactVersionsPage() {
  const params = useParams();
  const artifactId = params.artifactId as string;

  const [selectedVersionIndex, setSelectedVersionIndex] = React.useState(0);

  // Fetch artifact for title/metadata
  const {
    data: artifactData,
    isLoading: artifactLoading,
    error: artifactError,
  } = useApiQuery<ArtifactResponse>(
    ['artifacts', artifactId],
    `/api/admin/artifacts/${artifactId}`
  );

  // Fetch history - this contains ALL versions including current
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
  } = useApiQuery<HistoryResponse>(
    ['artifacts', artifactId, 'history'],
    `/api/admin/artifacts/${artifactId}/history`
  );

  const artifact = artifactData?.artifact ?? null;
  // History is already sorted by version descending (newest first)
  const allVersions = historyData?.history ?? [];

  const isLoading = artifactLoading || historyLoading;
  const error = artifactError || historyError;

  const selectedVersion = allVersions[selectedVersionIndex];
  const comparisonVersion = allVersions[selectedVersionIndex + 1];

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
        <Link href="/artifacts" className="ml-2 underline">
          Back to Documents
        </Link>
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-yellow-800">
        Document not found
        <Link href="/artifacts" className="ml-2 underline">
          Back to Documents
        </Link>
      </div>
    );
  }

  const config = typeConfig[artifact.artifactType] || typeConfig.document;
  const TypeIcon = config.icon;

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/artifacts/${artifactId}`}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <TypeIcon className={clsx('h-5 w-5', config.color)} />
              <h1 className="text-2xl font-bold text-gray-900">
                {artifact.title} - Version History
              </h1>
            </div>
            <p className="text-gray-600 mt-1">
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
                  <ArtifactVersionDiff
                    currentVersion={selectedVersion}
                    previousVersion={comparisonVersion}
                  />
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
                  const isCurrent = i === 0; // First in history is current version

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

                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center font-semibold">
                            <span>v{v.version}</span>
                            {isCurrent && (
                              <Badge variant="secondary" className="ml-2 text-xs">
                                Current
                              </Badge>
                            )}
                          </div>
                          {v.changeSummary && (
                            <p className="text-sm text-gray-600 mt-1">{v.changeSummary}</p>
                          )}
                          <div className="text-sm text-gray-500 mt-1">
                            {new Date(v.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </div>
                          {v.changedByAgentId && (
                            <div className="text-xs text-gray-400 mt-1">
                              by {v.changedByAgentId}
                            </div>
                          )}
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
