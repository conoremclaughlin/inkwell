'use client';

import React from 'react';
import TiptapDiffViewer from './tiptap-diff-viewer';

interface ArtifactVersion {
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

interface ArtifactVersionDiffProps {
  currentVersion: ArtifactVersion;
  previousVersion: ArtifactVersion;
}

/**
 * Generate markdown from an artifact version for diffing
 * Since artifact content is already markdown, we just add the title as a header
 */
function versionToMarkdown(version: ArtifactVersion): string {
  const lines: string[] = [];

  lines.push(`# ${version.title}`);
  lines.push('');
  lines.push(version.content);

  return lines.join('\n');
}

/**
 * ArtifactVersionDiff - Compare two artifact versions with rich diff highlighting
 */
export default function ArtifactVersionDiff({
  currentVersion,
  previousVersion,
}: ArtifactVersionDiffProps) {
  const currentMarkdown = versionToMarkdown(currentVersion);
  const previousMarkdown = versionToMarkdown(previousVersion);

  return (
    <div className="artifact-version-diff">
      <div className="mb-3 flex items-center gap-2 text-sm text-gray-600">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-green-200" />
          Added
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-red-100 line-through" />
          Removed
        </span>
      </div>
      <div className="rounded-md border p-4">
        <TiptapDiffViewer originalText={previousMarkdown} modifiedText={currentMarkdown} />
      </div>
    </div>
  );
}
