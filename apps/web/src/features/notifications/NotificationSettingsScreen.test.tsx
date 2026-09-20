// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetchRoutes } from '../../test-support/api-test-utils.ts';
import { NotificationSettingsScreen } from './NotificationSettingsScreen.tsx';

const CHANNEL = {
  id: 'chan_1',
  kind: 'ntfy',
  displayName: 'My phone',
  enabled: true,
  destination: 'personalfi-alerts',
  lastTestResult: null,
};

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationSettingsScreen />
    </QueryClientProvider>,
  );
}

describe('NotificationSettingsScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows an honest "not available yet" state when the channels request 404s', async () => {
    stubFetchRoutes([
      { match: '/api/notifications/channels', method: 'GET', handle: () => jsonResponse({}, 404) },
      {
        match: '/api/notifications/rules',
        method: 'GET',
        handle: () => jsonResponse({ rules: [] }),
      },
    ]);

    renderScreen();

    expect(await screen.findByText("Notifications aren't available yet")).toBeInTheDocument();
  });

  it('lists a configured channel and reports a real delivery result on "Send test"', async () => {
    let testedChannelId: string | null = null;
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'GET',
        handle: () => jsonResponse({ channels: [CHANNEL] }),
      },
      {
        match: '/api/notifications/rules',
        method: 'GET',
        handle: () => jsonResponse({ rules: [] }),
      },
      {
        match: '/api/notifications/channels/chan_1/test',
        method: 'POST',
        handle: () => {
          testedChannelId = 'chan_1';
          return jsonResponse({
            result: {
              ok: true,
              message: 'Delivered to My phone',
              testedAt: '2026-06-01T00:00:00.000Z',
            },
          });
        },
      },
    ]);

    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByText('My phone')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send test' }));

    await waitFor(() => expect(testedChannelId).toBe('chan_1'));
    expect(await screen.findByText('Delivered to My phone')).toBeInTheDocument();
  });

  it('adds a channel via the form, POSTing kind/displayName/destination', async () => {
    let createBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/notifications/channels',
        method: 'GET',
        handle: () => jsonResponse({ channels: [] }),
      },
      {
        match: '/api/notifications/rules',
        method: 'GET',
        handle: () => jsonResponse({ rules: [] }),
      },
      {
        match: '/api/notifications/channels',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return jsonResponse({ channel: { ...CHANNEL, id: 'chan_2' } }, 201);
        },
      },
    ]);

    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('No channels configured yet.');
    await user.type(screen.getByLabelText('Name'), 'Work phone');
    await user.type(screen.getByLabelText('Topic'), 'work-alerts');
    await user.click(screen.getByRole('button', { name: 'Add channel' }));

    await waitFor(() =>
      expect(createBody).toEqual({
        kind: 'ntfy',
        displayName: 'Work phone',
        destination: 'work-alerts',
      }),
    );
  });
});
