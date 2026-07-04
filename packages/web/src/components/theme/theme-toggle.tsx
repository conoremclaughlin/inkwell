'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';
import { cn } from '@/lib/utils';

/**
 * Sun/moon theme toggle. Renders both icons and lets the `dark` class on
 * <html> decide which is visible — this avoids any hydration mismatch since
 * the server markup is identical regardless of the active theme.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className={cn(
        'flex items-center gap-x-3 rounded-lg px-3 py-2 text-[13px] font-medium',
        'text-gray-400 transition-colors duration-150 hover:bg-white/[0.04] hover:text-gray-200',
        className
      )}
      aria-label="Toggle theme"
    >
      <Sun className="h-[18px] w-[18px] shrink-0 dark:hidden" strokeWidth={1.75} />
      <Moon className="hidden h-[18px] w-[18px] shrink-0 dark:block" strokeWidth={1.75} />
      <span className="dark:hidden">Light mode</span>
      <span className="hidden dark:inline">Dark mode</span>
    </button>
  );
}
