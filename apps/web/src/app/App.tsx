// SPDX-License-Identifier: MIT
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';

import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { usePrivacyShortcut } from '../lib/privacy.ts';
import { queryClient } from './query-client.ts';
import { router } from './router.tsx';

// Tree-shaken out of production (05-frontend-architecture.md §10.3): only
// imported behind `import.meta.env.DEV`, so the dynamic import never appears
// in a production chunk graph.
const DevTools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ ReactQueryDevtools }, { TanStackRouterDevtoolsPanel }] = await Promise.all([
        import('@tanstack/react-query-devtools'),
        import('@tanstack/react-router-devtools'),
      ]);
      return {
        default: () => (
          <>
            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
            <TanStackRouterDevtoolsPanel router={router} />
          </>
        ),
      };
    })
  : null;

export function App() {
  usePrivacyShortcut();

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        {/* role="status" toasts only — errors that must stop work use a route
            errorComponent or a field-level message, never a toast alone (05 §4.4). */}
        <Toaster richColors closeButton position="bottom-right" />
        {DevTools !== null && (
          <Suspense fallback={null}>
            <DevTools />
          </Suspense>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
