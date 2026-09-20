// SPDX-License-Identifier: MIT
/**
 * `api-pending.ts` now calls the real, generated `/notifications/*` client
 * (WP 2.r). These tests pin the same two things the old stub's suite pinned —
 * the request shape a mutation actually sends, and that a failure surfaces as
 * a normal React Query error rather than a thrown exception — against the
 * real routes instead of a guessed 404.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
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
  beforeEach(() => {
    ensureApiClient();
  });

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

  it('a problem response surfaces as a query error, not a thrown exception', async () => {
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'GET',
        handle: () =>
          jsonResponse(
            {
              type: 'https://personalfi.local/problems/not_authenticated',
              title: 'Unauthorized',
              status: 401,
              code: 'not_authenticated',
              correlationId: 'corr_1',
            },
            401,
          ),
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
                destinationHost: 'ntfy.sh',
                destinationPort: 443,
                scheme: 'https',
                destination: 'ntfy.sh:443',
                enabled: false,
                verifiedAt: null,
                verifyFailureCode: null,
                lastDeliveryAt: null,
                lastTestResult: null,
              },
            },
            201,
          );
        },
      },
    ]);

    const { result } = renderHook(() => useCreateNotificationChannelMutation(), { wrapper });
    const response = await result.current.mutateAsync({
      kind: 'ntfy',
      displayName: 'Phone',
      destination: 'topic',
    });

    expect(body).toEqual({ kind: 'ntfy', displayName: 'Phone', destination: 'topic' });
    // The real route's `destination` is synthesised from the (redacted)
    // clear columns, never the topic the form typed in — see this module's
    // own header comment on why.
    expect(response.channel.destination).toBe('ntfy.sh:443');
  });

  it('sendTestNotification POSTs to /api/notifications/channels/{id}/verify with no body', async () => {
    let sawPath: string | null = null;
    stubFetchRoutes([
      {
        match: '/api/notifications/channels/chan_1/verify',
        method: 'POST',
        handle: ({ url }) => {
          sawPath = url.pathname;
          return jsonResponse({
            result: { ok: true, message: 'Verified', testedAt: '2026-06-01T00:00:00.000Z' },
          });
        },
      },
    ]);

    const { result } = renderHook(() => useSendTestNotificationMutation(), { wrapper });
    const response = await result.current.mutateAsync('chan_1');

    expect(sawPath).toBe('/api/notifications/channels/chan_1/verify');
    expect(response.result.ok).toBe(true);
  });
});
