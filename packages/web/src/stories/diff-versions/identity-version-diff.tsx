'use client';

import React from 'react';
import TiptapDiffViewer from './tiptap-diff-viewer';

interface IdentityVersion {
  id: string;
  version: number;
  name: string;
  role: string;
  description?: string;
  values?: string[];
  relationships?: Record<string, string>;
  capabilities?: string[];
  changeType: string;
  archivedAt: string;
}

interface IdentityVersionDiffProps {
  currentVersion: IdentityVersion;
  previousVersion: IdentityVersion;
}

/**
 * Generate markdown from an identity version for diffing
 */
function versionToMarkdown(version: IdentityVersion): string {
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

/**
 * IdentityVersionDiff - Compare two identity versions with rich diff highlighting
 */
export default function IdentityVersionDiff({
  currentVersion,
  previousVersion,
}: IdentityVersionDiffProps) {
  const currentMarkdown = versionToMarkdown(currentVersion);
  const previousMarkdown = versionToMarkdown(previousVersion);

  return (
    <div className="identity-version-diff">
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
