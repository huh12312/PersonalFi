// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleLockOverlay } from './IdleLockOverlay.tsx';

// `useIdleTimer` drives off a real 1s interval against wall-clock activity
// (src/lib/idle.ts) — mocked here so the test can flip "idle" synchronously
// instead of waiting out the real 15-minute lock / 60s warning thresholds.
// Matched by argument value: IdleLockOverlay calls `useIdleTimer` twice, once
// with the warn threshold (LOCK_AFTER_MS - 60_000 = 840_000ms) and once with
// the lock threshold (LOCK_AFTER_MS = 900_000ms, i.e. 15 minutes —
// 05-frontend-architecture.md §7.2). Only the second call matters here.
let idle = false;
vi.mock('../../lib/idle.ts', () => ({
  useIdleTimer: vi.fn((timeoutMs: number) => (timeoutMs === 900_000 ? idle : false)),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * gate-remediation-web.md M-4/M-8: `IdleLockOverlay` never touched the query
 * cache, so `query-client.ts`'s `refetchOnWindowFocus: true` could refetch
 * balances behind the locked scrim. Locking now cancels in-flight queries and
 * clears the cache outright; a successful unlock refetches.
 */
describe('IdleLockOverlay', () => {
  beforeEach(() => {
    idle = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const raw =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(raw, 'http://localhost/').pathname;
        if (path === '/auth/step-up/options') {
          return jsonResponse({ options: {} });
        }
        if (path === '/auth/step-up/verify') {
          return jsonResponse({ freshUntil: new Date().toISOString() });
        }
        throw new Error(`IdleLockOverlay.test.tsx: no fetch handler stubbed for ${path}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears the query cache the moment the idle timer fires', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['dashboard', 'net-worth'], { minor: '100000' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <IdleLockOverlay />
      </QueryClientProvider>,
    );

    idle = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <IdleLockOverlay />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('PersonalFi is locked')).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
  });

  it('refetches after a successful unlock', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <IdleLockOverlay />
      </QueryClientProvider>,
    );

    idle = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <IdleLockOverlay />
      </QueryClientProvider>,
    );
    await screen.findByText('PersonalFi is locked');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(refetchSpy).toHaveBeenCalled());
  });
});
