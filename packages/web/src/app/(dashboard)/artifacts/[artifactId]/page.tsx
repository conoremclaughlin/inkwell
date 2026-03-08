'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  BookOpen,
  Lightbulb,
  FileCheck,
  FileText,
  StickyNote,
  Eye,
  Users,
  Lock,
  History,
  Loader2,
} from 'lucide-react';
import { apiPatch, useApiPost, useApiQuery, useQueryClient } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';
import {
  ObjectPermissionsEditor,
  type PermissionIdentityOption,
} from '@/components/permissions/object-permissions-editor';

interface Artifact {
  id: string;
  uri: string;
  title: string;
  content: string;
  contentType: string;
  artifactType: 'spec' | 'design' | 'decision' | 'document' | 'note';
  createdByAgentId?: string;
  editMode: 'workspace' | 'editors';
  editors: string[];
  collaborators?: string[];
  visibility: 'private' | 'shared' | 'public';
  version: number;
  tags: string[] | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactResponse {
  artifact: Artifact;
}

interface ArtifactCommentIdentity {
  id: string;
  agentId: string;
  name: string;
  backend: string | null;
}

interface ArtifactCommentUser {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
}

interface ArtifactComment {
  id: string;
  artifactId: string;
  parentCommentId: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByUser: ArtifactCommentUser | null;
  createdByIdentityId: string | null;
  createdByIdentity: ArtifactCommentIdentity | null;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactCommentsResponse {
  artifactId: string;
  comments: ArtifactComment[];
}

interface IndividualIdentity {
  id: string;
  agentId: string;
  name: string;
}

interface IndividualsResponse {
  individuals: IndividualIdentity[];
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

export default function ArtifactDetailPage() {
  const params = useParams();
  const artifactId = params.artifactId as string;
  const queryClient = useQueryClient();
  const [commentDraft, setCommentDraft] = useState('');
  const [commentAgentId, setCommentAgentId] = useState('');
  const [permissionEditMode, setPermissionEditMode] = useState<'workspace' | 'editors'>(
    'workspace'
  );
  const [permissionEditorIdentityIds, setPermissionEditorIdentityIds] = useState<string[]>([]);
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionSuccess, setPermissionSuccess] = useState<string | null>(null);

  const {
    data: artifactData,
    isLoading,
    error,
  } = useApiQuery<ArtifactResponse>(
    ['artifacts', artifactId],
    `/api/admin/artifacts/${artifactId}`
  );
  const {
    data: commentsData,
    isLoading: commentsLoading,
    error: commentsError,
  } = useApiQuery<ArtifactCommentsResponse>(
    ['artifact-comments', artifactId],
    `/api/admin/artifacts/${artifactId}/comments`
  );
  const { data: identitiesData } = useApiQuery<IndividualsResponse>(
    ['individual-identities'],
    '/api/admin/individuals'
  );

  const addCommentMutation = useApiPost<
    { comment: ArtifactComment },
    {
      content: string;
      agentId?: string;
    }
  >(`/api/admin/artifacts/${artifactId}/comments`, {
    onSuccess: () => {
      setCommentDraft('');
      queryClient.invalidateQueries({ queryKey: ['artifact-comments', artifactId] });
    },
  });

  const artifact = artifactData?.artifact ?? null;
  const comments = commentsData?.comments ?? [];
  const identityOptions: PermissionIdentityOption[] = useMemo(
    () =>
      identitiesData?.individuals.map((identity) => ({
        id: identity.id,
        name: identity.name,
      })) ?? [],
    [identitiesData?.individuals]
  );
  const identityNameById = useMemo(
    () => new Map(identityOptions.map((identity) => [identity.id, identity.name] as const)),
    [identityOptions]
  );
  const identityIdByAgentId = useMemo(
    () =>
      new Map(
        (identitiesData?.individuals ?? []).map(
          (identity) => [identity.agentId, identity.id] as const
        )
      ),
    [identitiesData?.individuals]
  );

  useEffect(() => {
    if (!artifact) return;
    const normalizedEditorIds = Array.from(
      new Set(
        (artifact.editors || [])
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) =>
            identityNameById.get(value) ? value : identityIdByAgentId.get(value) || value
          )
      )
    );
    setPermissionEditMode(artifact.editMode || 'workspace');
    setPermissionEditorIdentityIds(normalizedEditorIds);
  }, [artifact, identityNameById, identityIdByAgentId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading document...</span>
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
  const visConfig = visibilityConfig[artifact.visibility] || visibilityConfig.private;
  const TypeIcon = config.icon;
  const VisIcon = visConfig.icon;
  const commentsErrorMessage = commentsError?.message || addCommentMutation.error?.message;

  const handleAddComment = (event: React.FormEvent) => {
    event.preventDefault();
    if (!commentDraft.trim()) return;

    addCommentMutation.mutate({
      content: commentDraft.trim(),
      ...(commentAgentId.trim() ? { agentId: commentAgentId.trim() } : {}),
    });
  };

  const handleSavePermissions = async () => {
    setPermissionError(null);
    setPermissionSuccess(null);
    setIsSavingPermissions(true);

    try {
      await apiPatch(`/api/admin/artifacts/${artifactId}/permissions`, {
        editMode: permissionEditMode,
        editors: permissionEditorIdentityIds,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['artifacts', artifactId] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      setPermissionSuccess('Permissions updated.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update permissions';
      setPermissionError(message);
    } finally {
      setIsSavingPermissions(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/artifacts">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <TypeIcon className={clsx('h-5 w-5', config.color)} />
              <h1 className="text-2xl font-bold text-gray-900">{artifact.title}</h1>
              <Badge className={clsx('text-xs', config.bgColor, config.color)}>
                {config.label}
              </Badge>
              <Badge variant="outline" className="text-xs">
                <VisIcon className="h-3 w-3 mr-1" />
                {visConfig.label}
              </Badge>
              <span className="text-sm text-gray-500">v{artifact.version}</span>
            </div>
            <p className="text-sm text-gray-500 font-mono mt-1">{artifact.uri}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/artifacts/${artifactId}/versions`}>
            <History className="mr-2 h-4 w-4" />
            {artifact.version} version{artifact.version !== 1 ? 's' : ''}
          </Link>
        </Button>
      </div>

      {/* Tags */}
      {artifact.tags && artifact.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {artifact.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Content */}
      <Card>
        <CardContent className="p-6">
          <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="p-6 space-y-4">
          <ObjectPermissionsEditor
            title="Edit permissions"
            description="Control who can update this document. “Anyone” mode keeps stored editor selections so you can switch back safely."
            mode={permissionEditMode}
            onModeChange={setPermissionEditMode}
            editorIdentityIds={permissionEditorIdentityIds}
            onEditorIdentityIdsChange={setPermissionEditorIdentityIds}
            identities={identityOptions}
            actionLabel="Save"
            pendingActionLabel="Saving…"
            onAction={handleSavePermissions}
            isActionPending={isSavingPermissions}
            error={permissionError}
            success={permissionSuccess}
          />
        </CardContent>
      </Card>

      {/* Comments */}
      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Comments</h2>
            <span className="text-sm text-gray-500">{comments.length}</span>
          </div>

          <form onSubmit={handleAddComment} className="mb-6 space-y-3">
            <textarea
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              placeholder="Add a comment about this document…"
              rows={3}
              className="w-full rounded-md border border-gray-300 p-3 text-sm focus:border-gray-400 focus:outline-none"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <input
                value={commentAgentId}
                onChange={(event) => setCommentAgentId(event.target.value)}
                placeholder="Agent ID (optional, e.g. lumen)"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm sm:max-w-xs focus:border-gray-400 focus:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                disabled={addCommentMutation.isPending || !commentDraft.trim()}
              >
                {addCommentMutation.isPending ? 'Posting…' : 'Post Comment'}
              </Button>
            </div>
          </form>

          {commentsErrorMessage && (
            <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {commentsErrorMessage}
            </div>
          )}

          {commentsLoading ? (
            <p className="text-sm text-gray-500">Loading comments…</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-gray-500">No comments yet.</p>
          ) : (
            <div className="space-y-4">
              {comments.map((comment) => {
                const identityName =
                  comment.createdByIdentity?.name ||
                  comment.createdByIdentity?.agentId ||
                  comment.createdByUser?.name ||
                  comment.createdByUser?.username ||
                  comment.createdByUser?.email ||
                  comment.createdByAgentId ||
                  'You';
                return (
                  <div key={comment.id} className="rounded-md border border-gray-200 p-4">
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-700">{identityName}</span>
                        {comment.createdByIdentity?.backend && (
                          <Badge variant="outline" className="text-[10px]">
                            {comment.createdByIdentity.backend}
                          </Badge>
                        )}
                      </div>
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-gray-800">{comment.content}</p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Metadata footer */}
      <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
        <div className="flex items-center gap-4">
          {artifact.createdByAgentId && <span>Created by: {artifact.createdByAgentId}</span>}
          <span>
            Edit mode:{' '}
            {artifact.editMode === 'workspace' ? 'workspace editors' : 'specific editor list'}
          </span>
          {artifact.editMode === 'editors' && artifact.editors && artifact.editors.length > 0 && (
            <span>
              Editors:{' '}
              {artifact.editors
                .map((identityId) => {
                  const identityName = identityNameById.get(identityId);
                  if (identityName) return identityName;
                  const remappedId = identityIdByAgentId.get(identityId);
                  const remappedIdentityName = remappedId ? identityNameById.get(remappedId) : null;
                  return remappedIdentityName || identityId;
                })
                .join(', ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span>Created: {new Date(artifact.createdAt).toLocaleDateString()}</span>
          <span>Updated: {new Date(artifact.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}
