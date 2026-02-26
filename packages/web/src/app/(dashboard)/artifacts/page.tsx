'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  FileText,
  BookOpen,
  Lightbulb,
  FileCheck,
  StickyNote,
  Eye,
  Users,
  Lock,
  History,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

interface Artifact {
  id: string;
  uri: string;
  title: string;
  artifactType: 'spec' | 'design' | 'decision' | 'document' | 'note';
  visibility: 'private' | 'shared' | 'public';
  version: number;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactsResponse {
  artifacts: Artifact[];
}

const typeConfig = {
  spec: {
    icon: BookOpen,
    label: 'Spec',
    color: 'text-purple-600',
    bgColor: 'bg-purple-100',
  },
  design: {
    icon: Lightbulb,
    label: 'Design',
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  decision: {
    icon: FileCheck,
    label: 'Decision',
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  document: {
    icon: FileText,
    label: 'Document',
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
  },
  note: {
    icon: StickyNote,
    label: 'Note',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-100',
  },
};

const visibilityConfig = {
  private: {
    icon: Lock,
    label: 'Private',
  },
  shared: {
    icon: Users,
    label: 'Shared',
  },
  public: {
    icon: Eye,
    label: 'Public',
  },
};

function formatRelativeTime(date: string): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return target.toLocaleDateString();
}

export default function ArtifactsPage() {
  const { data, isLoading, error } = useApiQuery<ArtifactsResponse>(
    ['artifacts'],
    '/api/admin/artifacts'
  );

  const artifacts = data?.artifacts ?? [];

  // Stats by type
  const stats = {
    spec: artifacts.filter((a) => a.artifactType === 'spec').length,
    design: artifacts.filter((a) => a.artifactType === 'design').length,
    decision: artifacts.filter((a) => a.artifactType === 'decision').length,
    document: artifacts.filter((a) => a.artifactType === 'document').length,
    note: artifacts.filter((a) => a.artifactType === 'note').length,
    total: artifacts.length,
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Documents</h1>
          <p className="mt-2 text-gray-600">
            Shared documents, specs, and designs that AI beings collaborate on.
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* Stats */}
      <div className="grid grid-cols-6 gap-4 mt-6">
        {Object.entries(typeConfig).map(([type, config]) => {
          const TypeIcon = config.icon;
          const count = stats[type as keyof typeof stats] || 0;
          return (
            <Card key={type}>
              <CardContent className="p-4 text-center">
                <TypeIcon className={clsx('h-5 w-5 mx-auto mb-1', config.color)} />
                <div className={clsx('text-2xl font-bold', config.color)}>{count}</div>
                <div className="text-xs text-gray-500">{config.label}s</div>
              </CardContent>
            </Card>
          );
        })}
        <Card>
          <CardContent className="p-4 text-center">
            <FileText className="h-5 w-5 mx-auto text-gray-600 mb-1" />
            <div className="text-2xl font-bold text-gray-600">{stats.total}</div>
            <div className="text-xs text-gray-500">Total</div>
          </CardContent>
        </Card>
      </div>

      {/* Documents List */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>All Documents</CardTitle>
          <CardDescription>Sorted by last updated</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : artifacts.length === 0 ? (
            <div className="text-center py-8">
              <FileText className="h-12 w-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No documents yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Use the <code className="bg-gray-100 px-1 rounded">create_artifact</code> tool to
                create one.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {artifacts.map((artifact) => {
                const config = typeConfig[artifact.artifactType] || typeConfig.document;
                const visConfig = visibilityConfig[artifact.visibility] || visibilityConfig.private;
                const TypeIcon = config.icon;
                const VisIcon = visConfig.icon;

                return (
                  <Link
                    key={artifact.id}
                    href={`/artifacts/${artifact.id}`}
                    className="block rounded-lg border border-gray-200 p-4 hover:border-gray-400 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <TypeIcon className={clsx('h-4 w-4', config.color)} />
                          <h3 className="font-semibold text-gray-900">{artifact.title}</h3>
                          <Badge className={clsx('text-xs', config.bgColor, config.color)}>
                            {config.label}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            <VisIcon className="h-3 w-3 mr-1" />
                            {visConfig.label}
                          </Badge>
                          <span className="text-xs text-gray-400">v{artifact.version}</span>
                          {artifact.version > 1 && (
                            <span className="text-xs text-blue-500 flex items-center gap-1">
                              <History className="h-3 w-3" />
                              {artifact.version} versions
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500 mt-1 font-mono">{artifact.uri}</p>
                        {artifact.tags && artifact.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {artifact.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-sm text-gray-500">
                        <div>Updated {formatRelativeTime(artifact.updatedAt)}</div>
                        <div className="text-xs text-gray-400 mt-1">
                          Created {formatRelativeTime(artifact.createdAt)}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
