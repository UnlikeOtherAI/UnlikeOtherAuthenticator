import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type PropsWithChildren } from 'react';

import { AdminSessionProvider } from '../features/auth/admin-session';

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    const clear = () => {
      void queryClient.cancelQueries();
      queryClient.clear();
    };
    window.addEventListener('uoa-admin-session-cleared', clear);
    return () => window.removeEventListener('uoa-admin-session-cleared', clear);
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AdminSessionProvider>{children}</AdminSessionProvider>
    </QueryClientProvider>
  );
}
