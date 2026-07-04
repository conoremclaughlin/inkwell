'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider, createTheme } from '@mantine/core';
import { useState } from 'react';
import { ThemeProvider } from '@/components/theme/theme-provider';

import '@mantine/core/styles.css';

const theme = createTheme({
  // Customize Mantine theme if needed
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MantineProvider theme={theme}>{children}</MantineProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
