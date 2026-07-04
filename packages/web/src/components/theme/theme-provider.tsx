'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'ink-theme';

interface ThemeContextValue {
  /** The user's stored preference ('system' until they explicitly choose). */
  theme: Theme;
  /** The effective theme after resolving 'system' against prefers-color-scheme. */
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through
  }
  return 'system';
}

/**
 * Read the theme the inline <head> script (app/layout.tsx) already applied.
 *
 * INVARIANT: the inline script owns first paint — it sets the `dark` class
 * on <html> before hydration from the same storage key + media query this
 * provider uses. The provider must initialize its state FROM that DOM state
 * and must not touch the class unless the resolved theme actually differs.
 * Initializing to a hardcoded default and "correcting" in a mount effect
 * would briefly strip `.dark` and re-add it, flashing light for
 * persisted/system dark users.
 */
function getInitialResolvedTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Sync the `dark` class, mutating the DOM only when it disagrees. */
function applyThemeClass(resolved: 'light' | 'dark') {
  const classList = document.documentElement.classList;
  const isDark = classList.contains('dark');
  if (resolved === 'dark' && !isDark) {
    classList.add('dark');
  } else if (resolved === 'light' && isDark) {
    classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializers run during the first client render, so by mount the
  // provider already agrees with what the inline script painted — no
  // corrective effect pass, no flash. (On the server they fall back to
  // defaults, which is fine: the provider renders no theme-dependent markup,
  // so there is no hydration mismatch.)
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(getInitialResolvedTheme);

  // Follow OS preference changes while in 'system' mode.
  useEffect(() => {
    if (theme !== 'system') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const systemTheme = getSystemTheme();
      setResolvedTheme(systemTheme);
      applyThemeClass(systemTheme);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Keep the DOM class in sync with the resolved theme. On mount this is a
  // no-op (state was initialized from the DOM and applyThemeClass only
  // mutates on disagreement); it only takes effect after an explicit
  // setTheme or a system-preference change.
  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
    const resolved = nextTheme === 'system' ? getSystemTheme() : nextTheme;
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // localStorage unavailable — theme still applies for this session
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
