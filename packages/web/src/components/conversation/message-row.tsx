'use client';

import { memo, useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AuthorAvatar } from './author-avatar';
import { formatClockTime } from './format';
import { MessageMarkdown } from './message-markdown';
import type { ConversationMessage } from './types';

/** Bodies past either limit start folded; the reader opens what they want. */
const FOLD_CHARS = 1_600;
const FOLD_LINES = 28;

const LABELS: Record<string, string> = {
  task_request: 'task request',
  notification: 'notification',
  session_resume: 'resume',
  permission_grant: 'permission',
};

function shouldFold(body: string): boolean {
  if (body.length > FOLD_CHARS) return true;
  let lines = 1;
  for (const ch of body) if (ch === '\n' && ++lines > FOLD_LINES) return true;
  return false;
}

function FoldableBody({ message }: { message: ConversationMessage }) {
  const foldable = !message.streaming && shouldFold(message.body);
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  return (
    <div>
      <div className={cn('relative', folded && 'max-h-72 overflow-hidden')}>
        <MessageMarkdown content={message.body} />
        {message.streaming && (
          <span
            className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/50 align-text-bottom"
            aria-label="still writing"
          />
        )}
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {foldable && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * One message in a conversation, laid out like a terminal transcript or a
 * Slack channel: the avatar in a gutter column, a name-and-time header on
 * the first message of a group, and continuation messages aligned under it
 * with their time revealed on hover.
 */
export const MessageRow = memo(function MessageRow({
  message,
  continuation = false,
}: {
  message: ConversationMessage;
  continuation?: boolean;
}) {
  const { author } = message;
  const clock = formatClockTime(message.createdAt);
  const fullTime = new Date(message.createdAt).toLocaleString();

  if (author.kind === 'system') {
    return (
      <div className="flex justify-center px-4 py-2" data-message-id={message.id}>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/70 px-3 py-1 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3 shrink-0" />
          <span className="truncate">{message.body}</span>
          <time dateTime={message.createdAt} title={fullTime} className="shrink-0 tabular-nums">
            · {clock}
          </time>
        </span>
      </div>
    );
  }

  const label = message.label ? (LABELS[message.label] ?? message.label.replace(/_/g, ' ')) : null;
  const urgent = message.priority === 'high' || message.priority === 'urgent';

  return (
    <div
      className={cn('group flex gap-3 px-4 md:px-6', continuation ? 'pt-0.5' : 'pt-3')}
      data-message-id={message.id}
    >
      <div className="w-9 shrink-0">
        {continuation ? (
          <time
            dateTime={message.createdAt}
            title={fullTime}
            className="block pt-[3px] text-right text-[10px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          >
            {clock}
          </time>
        ) : (
          <AuthorAvatar author={author} size="md" className="mt-0.5" />
        )}
      </div>
      <div className="min-w-0 flex-1 pb-0.5">
        {!continuation && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'text-sm font-semibold',
                author.isOwn ? 'text-sky-700 dark:text-sky-400' : 'text-foreground'
              )}
            >
              {author.name}
            </span>
            {label && (
              <span className="rounded bg-violet-500/10 px-1.5 py-px text-[10px] font-medium text-violet-600 dark:text-violet-400">
                {label}
              </span>
            )}
            {urgent && (
              <span
                className={cn(
                  'rounded px-1.5 py-px text-[10px] font-medium',
                  message.priority === 'urgent'
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                )}
              >
                {message.priority}
              </span>
            )}
            <time
              dateTime={message.createdAt}
              title={fullTime}
              className="text-[11px] tabular-nums text-muted-foreground"
            >
              {clock}
            </time>
          </div>
        )}
        <FoldableBody message={message} />
      </div>
    </div>
  );
});
