// SPDX-License-Identifier: MIT
/**
 * `api-pending.ts` is a Phase-0-`pending-contracts.ts`-shaped stub: real
 * `fetch` calls against paths that do not exist yet. These tests pin the
 * request shape (method, path, body) so the eventual swap to the generated
 * client is provably a like-for-like replacement, and pin that a 404 (today's
 * honest reality) surfaces as a normal React Query error rather than a thrown
 * exception the caller has to know to catch.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetchRoutes } from '../../test-support/api-test-utils.ts';
import {
  useCreateNotificationChannelMutation,
  useNotificationChannelsQuery,
  useSendTestNotificationMutation,
} from './api-pending.ts';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('notifications api-pending', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('GET /api/notifications/channels resolves normally when the route answers', async () => {
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'GET',
        handle: () => jsonResponse({ channels: [] }),
      },
    ]);

    const { result } = renderHook(() => useNotificationChannelsQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ channels: [] });
  });

  it('surfaces a 404 (today’s honest reality — no route exists yet) as a query error, not a thrown exception', async () => {
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'GET',
        handle: () => jsonResponse({ code: 'not_found' }, 404),
      },
    ]);

    const { result } = renderHook(() => useNotificationChannelsQuery(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('createChannel POSTs kind/displayName/destination to /api/notifications/channels', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'POST',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse(
            {
              channel: {
                id: 'chan_1',
                kind: 'ntfy',
                displayName: 'Phone',
                enabled: true,
                destination: 'topic',
                lastTestResult: null,
              },
            },
            201,
          );
        },
      },
    ]);

    const { result } = renderHook(() => useCreateNotificationChannelMutation(), { wrapper });
    await result.current.mutateAsync({ kind: 'ntfy', displayName: 'Phone', destination: 'topic' });

    expect(body).toEqual({ kind: 'ntfy', displayName: 'Phone', destination: 'topic' });
  });

  it('sendTestNotification POSTs to /api/notifications/channels/{id}/test with no body', async () => {
    let sawPath: string | null = null;
    stubFetchRoutes([
      {
        match: '/api/notifications/channels/chan_1/test',
        method: 'POST',
        handle: ({ url }) => {
          sawPath = url.pathname;
          return jsonResponse({
            result: { ok: true, message: 'Delivered', testedAt: '2026-06-01T00:00:00.000Z' },
          });
        },
      },
    ]);

    const { result } = renderHook(() => useSendTestNotificationMutation(), { wrapper });
    const response = await result.current.mutateAsync('chan_1');

    expect(sawPath).toBe('/api/notifications/channels/chan_1/test');
    expect(response.result.ok).toBe(true);
  });
});
