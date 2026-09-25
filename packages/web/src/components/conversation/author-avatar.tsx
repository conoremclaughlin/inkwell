'use client';

import { Cog, User } from 'lucide-react';
import { cn, getAgentGradient } from '@/lib/utils';
import type { ConversationAuthor } from './types';

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

const ICON_SIZES = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-5 w-5' } as const;

export type AvatarSize = keyof typeof SIZES;

/**
 * An author's avatar: an SB's gradient initial (the same gradient the
 * dashboard uses for that slug everywhere), a person, or the system.
 */
export function AuthorAvatar({
  author,
  size = 'md',
  className,
}: {
  author: Pick<ConversationAuthor, 'kind' | 'id' | 'name'>;
  size?: AvatarSize;
  className?: string;
}) {
  const base = cn(
    'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
    SIZES[size],
    className
  );
  if (author.kind === 'system') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')} aria-hidden>
        <Cog className={ICON_SIZES[size]} />
      </span>
    );
  }
  if (author.kind === 'user') {
    return (
      <span
        className={cn(
          base,
          'bg-gradient-to-br from-slate-600 to-slate-800 text-white dark:from-slate-300 dark:to-slate-500 dark:text-slate-900'
        )}
        aria-hidden
      >
        <User className={ICON_SIZES[size]} />
      </span>
    );
  }
  return (
    <span
      className={cn(base, 'bg-gradient-to-br text-white', getAgentGradient(author.id))}
      aria-hidden
    >
      {(author.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** Overlapping avatars for a conversation's participants, with an overflow count. */
export function AvatarStack({
  authors,
  max = 3,
  size = 'sm',
  className,
}: {
  authors: Array<Pick<ConversationAuthor, 'kind' | 'id' | 'name'>>;
  max?: number;
  size?: AvatarSize;
  className?: string;
}) {
  const shown = authors.slice(0, max);
  const extra = authors.length - shown.length;
  return (
    <span className={cn('flex items-center -space-x-1.5', className)}>
      {shown.map((author) => (
        <AuthorAvatar
          key={`${author.kind}:${author.id}`}
          author={author}
          size={size}
          className="ring-2 ring-background"
        />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background',
            SIZES[size]
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
