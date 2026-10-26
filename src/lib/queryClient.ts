import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // Data is fresh for 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // Cache persists in memory for 24 hours
      refetchOnWindowFocus: true, // Auto-update when unlocking iPhone/opening browser tab
      retry: 2 // Retry failed network requests twice before serving offline cache
    }
  }
});