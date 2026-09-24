'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The box grows with the draft up to this height, then scrolls. */
const MAX_HEIGHT_PX = 240;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** A send is in flight: the box locks until it lands. */
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
  /** A line above the box — e.g. why a closed conversation still takes a reply. */
  notice?: ReactNode;
  error?: string | null;
  className?: string;
}

/**
 * The message box. Enter sends and Shift+Enter starts a new line, as in
 * every chat; ⌘/Ctrl+Enter sends too, for hands used to the old composer.
 * Text being composed through an input method (accents, CJK) is never sent
 * mid-composition.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  sending = false,
  disabled = false,
  placeholder,
  ariaLabel,
  notice,
  error,
  className,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !sending && !disabled;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const submit = () => {
    if (canSend) onSubmit();
  };

  return (
    <div className={cn('shrink-0 border-t bg-background px-3 pb-3 pt-2 md:px-5', className)}>
      {notice && (
        <div className="mb-2 text-[11px] leading-snug text-muted-foreground">{notice}</div>
      )}
      <div
        className={cn(
          'flex items-end gap-2 rounded-xl border bg-background px-3 py-2 shadow-sm transition-shadow',
          'focus-within:border-ring/40 focus-within:shadow-md',
          (sending || disabled) && 'opacity-80'
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={sending || disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            submit();
          }}
          className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={sending ? 'Sending…' : 'Send'}
          title="Send (Enter)"
          className={cn(
            'mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            canSend ? 'bg-sky-600 text-white hover:bg-sky-700' : 'bg-muted text-muted-foreground'
          )}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span className="hidden sm:inline">
            <kbd className="font-sans">Enter</kbd> to send ·{' '}
            <kbd className="font-sans">Shift + Enter</kbd> for a new line · Markdown supported
          </span>
        )}
      </div>
    </div>
  );
}
