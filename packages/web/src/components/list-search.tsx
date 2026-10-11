'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export function useListSearch() {
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const normalized = value.trim().replace(/\s+/gu, ' ');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(normalized), 250);
    return () => clearTimeout(timer);
  }, [normalized]);
  return {
    value,
    query,
    pending: normalized !== query,
    setValue: (next: string) => {
      setValue(next);
      if (!next.trim()) setQuery('');
    },
  };
}

export function ListSearch({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-6 max-w-xl">
      <label htmlFor={id} className="block text-sm font-medium text-foreground mb-2">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-lg border bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          id={id}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={200}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
        {value && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onChange('');
              input.current?.focus();
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline focus-visible:outline-2"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="mt-2 text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
