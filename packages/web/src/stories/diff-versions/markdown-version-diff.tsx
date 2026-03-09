'use client';

import React from 'react';
import TiptapDiffViewer from './tiptap-diff-viewer';

interface MarkdownVersionDiffProps {
  currentMarkdown: string;
  previousMarkdown: string;
}

/**
 * MarkdownVersionDiff - Compare two markdown documents with rich diff highlighting
 * Generic component that can be used for any document content (user, values, soul, etc.)
 */
export default function MarkdownVersionDiff({
  currentMarkdown,
  previousMarkdown,
}: MarkdownVersionDiffProps) {
  return (
    <div className="markdown-version-diff">
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
