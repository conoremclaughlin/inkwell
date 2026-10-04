'use client';

import { memo, useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  REACTION_CHOICES,
  canAddReaction,
  reactionChipLabel,
  reactionChoiceLabel,
  type ConversationReaction,
} from '@inklabs/shared/stories/thread-viewing';

/**
 * A message's reactions as chips ("❤️ 2"), the viewer's own highlighted
 * (spec inkling-reactions). With `onToggle`, tapping a chip adds or takes
 * back the viewer's reaction and a picker offers the six choices; without
 * it (a background thread, a role that cannot write) the chips are read-only
 * and nothing is offered. No reactions from the source means nothing at all.
 */
export const ReactionChips = memo(function ReactionChips({
  messageId,
  reactions,
  onToggle,
}: {
  messageId: string;
  reactions: ConversationReaction[] | undefined;
  onToggle?: (messageId: string, emoji: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (reactions === undefined) return null;
  const interactive = onToggle !== undefined;
  if (reactions.length === 0 && !interactive) return null;

  const toggle = (emoji: string) => {
    setPicking(false);
    onToggle?.(messageId, emoji);
  };

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-reactions-for={messageId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setPicking(false);
      }}
    >
      {reactions.map((reaction) => {
        const chipClass = cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs tabular-nums',
          reaction.mine
            ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
            : 'border-border bg-muted/50 text-muted-foreground'
        );
        const body = (
          <>
            <span aria-hidden>{reaction.emoji}</span>
            <span aria-hidden>{reaction.count}</span>
          </>
        );
        return interactive ? (
          <button
            key={reaction.emoji}
            type="button"
            aria-label={reactionChipLabel(reaction)}
            aria-pressed={reaction.mine}
            disabled={!canAddReaction(reaction.emoji, reactions)}
            onClick={() => toggle(reaction.emoji)}
            className={cn(chipClass, 'hover:border-sky-500/60 disabled:opacity-50')}
          >
            {body}
          </button>
        ) : (
          <span
            key={reaction.emoji}
            role="img"
            aria-label={reactionChipLabel(reaction)}
            className={chipClass}
          >
            {body}
          </span>
        );
      })}
      {interactive && (
        <button
          type="button"
          aria-label="React"
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
          className={cn(
            'inline-flex h-5 items-center rounded-full px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100',
            reactions.length === 0 && !picking && 'opacity-0 group-hover:opacity-100'
          )}
        >
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
      )}
      {/*
        The choices sit in this row's own flow, after the React button. A
        popover anchored to the button ran past the conversation's right edge
        once a few chips had pushed the button along (Lumen, #742 r1); in the
        row they wrap to the next line, and wrap within themselves on a
        narrower column still.
      */}
      {interactive && picking && (
        <div
          role="group"
          aria-label="Choose a reaction"
          className="flex flex-wrap gap-0.5 rounded-2xl border bg-background p-1 shadow-sm"
        >
          {REACTION_CHOICES.map((choice) => (
            <button
              key={choice.emoji}
              type="button"
              aria-label={reactionChoiceLabel(choice)}
              disabled={!canAddReaction(choice.emoji, reactions)}
              onClick={() => toggle(choice.emoji)}
              className="rounded-full px-1.5 py-0.5 text-base hover:bg-muted disabled:opacity-40"
            >
              {choice.emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
