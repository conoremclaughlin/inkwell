'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './sidebar';

/**
 * Dashboard shell that survives a phone. The sidebar is a fixed 256px
 * column, which on a 390px viewport left main 134px — no page can render
 * there. Desktop keeps the static sidebar; below md it becomes a slide-over
 * drawer behind a top-bar menu button, and the content gets the full width.
 */
export function ResponsiveShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Navigating from the drawer should land on the page, not the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen flex-col md:flex-row">
      <div className="flex items-center gap-3 border-b border-white/[0.06] bg-[#0f1117] px-4 py-3 md:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
          className="text-gray-300 hover:text-white"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-white">Inkwell</span>
      </div>

      <div className="hidden md:block">
        <Sidebar />
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="absolute inset-y-0 left-0 flex">
            <Sidebar />
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setDrawerOpen(false)}
              className="m-2 h-8 w-8 self-start rounded-md bg-black/40 p-1.5 text-white"
            >
              <X className="h-full w-full" />
            </button>
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-4 dark:bg-background md:p-8">
        {children}
      </main>
    </div>
  );
}
