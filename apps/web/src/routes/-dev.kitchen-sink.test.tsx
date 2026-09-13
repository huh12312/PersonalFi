// SPDX-License-Identifier: MIT
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../app/query-client.ts';
import { router } from '../app/router.tsx';

expect.extend(toHaveNoViolations);

/**
 * Accessibility gate for `/dev/kitchen-sink` (05-frontend-architecture.md
 * §9): every vendored primitive and finance component lives on this one
 * route, in both themes, so a single axe-core pass here is the cheapest
 * possible proxy for "the design system doesn't regress WCAG 2.1 AA".
 *
 * `beforeLoad` on the route only guards `import.meta.env.DEV`, which is true
 * under Vitest (mode `test`, never `production`), so navigating there works
 * the same way the Playwright smoke test's dev server does.
 */
describe('/dev/kitchen-sink accessibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has no axe violations in either theme', async () => {
    // `/dev/kitchen-sink` itself isn't behind the `/_app` auth guard (gate-
    // remediation-web.md M-3/M-8) — it's a root-level route — but `render`
    // mounts `RouterProvider` at whatever the router's current location
    // already is, which *is* behind the guard by default. Stub `fetch` so
    // that initial match doesn't make a real, unhandled network call before
    // the explicit `navigate` below takes over.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 })),
    );

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await router.navigate({ to: '/dev/kitchen-sink' });
    await router.invalidate();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 20_000);
});
