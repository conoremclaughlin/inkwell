'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const components: Components = {
  // Every link leaves the conversation in a new tab; the chat keeps its place.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  // Wide tables scroll inside the message instead of widening the column.
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table {...props} />
    </div>
  ),
};

/**
 * A message body: GitHub-flavoured markdown, sized for a conversation — tight
 * paragraph rhythm, small headings, code and tables that scroll in place
 * rather than stretching the timeline.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words text-foreground dark:prose-invert',
        'prose-p:my-1 prose-p:leading-relaxed prose-p:text-foreground',
        // A newline typed in a chat is a line break, not a space. Paragraphs
        // only: between block elements the renderer emits newline text too.
        '[&_p]:whitespace-pre-line',
        'prose-headings:mb-1 prose-headings:mt-3 prose-headings:text-[0.95rem] prose-headings:font-semibold prose-headings:text-foreground',
        'prose-strong:text-foreground prose-li:my-0 prose-li:text-foreground prose-ol:my-1 prose-ul:my-1',
        // GFM task lists: the checkbox is the marker.
        '[&_.contains-task-list]:pl-1 [&_.task-list-item]:list-none [&_.task-list-item_input]:mr-1.5',
        'prose-a:font-normal prose-a:text-sky-600 prose-a:underline-offset-2 hover:prose-a:underline dark:prose-a:text-sky-400',
        'prose-a:no-underline',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:text-foreground',
        'prose-code:before:content-none prose-code:after:content-none',
        'prose-pre:my-2 prose-pre:rounded-md prose-pre:border prose-pre:bg-muted/60 prose-pre:px-3 prose-pre:py-2 prose-pre:text-[12px] prose-pre:leading-relaxed prose-pre:text-foreground',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        'prose-blockquote:my-2 prose-blockquote:border-l-2 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground',
        'prose-hr:my-3 prose-table:my-0 prose-table:text-xs prose-th:px-2 prose-td:px-2',
        'prose-img:my-2 prose-img:max-h-80 prose-img:rounded-md',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
