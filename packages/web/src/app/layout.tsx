import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Inkwell',
  description: 'Your AI beings remember what matters to you',
};

/**
 * Applies the persisted theme before first paint to avoid a flash of the
 * wrong theme. Must stay in sync with THEME_STORAGE_KEY in
 * components/theme/theme-provider.tsx.
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem('ink-theme');var d=t==='dark'||((t===null||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
