// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { MarketDataSettingsScreen } from './MarketDataSettingsScreen.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/** A synthetic value shaped like a real provider key — never a real secret (test-only fixture). */
const SYNTHETIC_KEY_MARKER = 'pfi-synthetic-tiingo-key-do-not-use-9f3c1a77';

const COINGECKO_ATTRIBUTION = {
  provider: 'coingecko',
  required: true,
  text: 'Data provided by CoinGecko',
  linkUrl: 'https://www.coingecko.com',
  logoRequired: true,
  surfaces: ['any_price', 'settings'],
  clause: "CoinGecko: 'Data provided by CoinGecko' with logo + hyperlink is a licence condition.",
  redistribution: 'permitted_with_attribution',
};

function settingsResponse(overrides?: { tiingoExtra?: Record<string, unknown> }) {
  return {
    providers: [
      {
        provider: 'tiingo',
        keyPresent: true,
        registered: true,
        capabilities: { prices: true, fx: false, macro: false, search: false },
        budget: [{ label: 'requests/day', used: 12, limit: 1000 }],
        attribution: {
          provider: 'tiingo',
          required: false,
          text: '',
          linkUrl: null,
          logoRequired: false,
          surfaces: [],
          clause: 'Tiingo forbids redistribution.',
          redistribution: 'forbidden',
        },
        // A defensive-in-depth field a buggy backend might one day add —
        // this test proves it never reaches the DOM regardless (S5's UI-side
        // twin, wp3.9-routes.md §4).
        ...(overrides?.tiingoExtra ?? {}),
      },
      {
        provider: 'coingecko',
        keyPresent: false,
        registered: true,
        capabilities: { prices: true, fx: false, macro: false, search: false },
        budget: [{ label: 'requests/min', used: 0, limit: 100 }],
        attribution: COINGECKO_ATTRIBUTION,
      },
    ],
    ladders: [
      {
        securityKind: 'crypto',
        sources: [
          { source: 'user_override', rung: 1 },
          { source: 'coingecko', rung: 2 },
          { source: 'last_known', rung: 3 },
        ],
      },
    ],
    settingsAttributions: [COINGECKO_ATTRIBUTION],
    allowedHostsNarrowed: true,
  };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MarketDataSettingsScreen />
    </QueryClientProvider>,
  );
}

describe('MarketDataSettingsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows key presence as a badge, never a value — and a planted key-shaped value never reaches the DOM', async () => {
    stubFetchRoutes([
      {
        match: '/api/market-data/settings',
        method: 'GET',
        handle: () =>
          jsonResponse(settingsResponse({ tiingoExtra: { debugApiKey: SYNTHETIC_KEY_MARKER } })),
      },
    ]);

    renderScreen();

    expect(await screen.findByText('Key configured')).toBeInTheDocument();
    expect(screen.getByText('No key configured')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SYNTHETIC_KEY_MARKER);
  });

  it('renders the CoinGecko attribution beside its provider row, with the licence clause quoted', async () => {
    stubFetchRoutes([
      {
        match: '/api/market-data/settings',
        method: 'GET',
        handle: () => jsonResponse(settingsResponse()),
      },
    ]);

    renderScreen();

    expect(await screen.findByText('Data provided by CoinGecko')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText('Licence clause'));
    expect(
      screen.getByText(
        /'Data provided by CoinGecko' with logo \+ hyperlink is a licence condition/,
      ),
    ).toBeInTheDocument();
  });

  it('reorders and saves a priority ladder through the step-up gated PUT', async () => {
    let putBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/market-data/settings',
        method: 'GET',
        handle: () => jsonResponse(settingsResponse()),
      },
      {
        match: '/api/auth/step-up/options',
        method: 'POST',
        handle: () => jsonResponse({ options: {} }),
      },
      {
        match: '/api/auth/step-up/verify',
        method: 'POST',
        handle: () => jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() }),
      },
      {
        match: '/api/market-data/priority',
        method: 'PUT',
        handle: async ({ request }) => {
          putBody = await request.json();
          return jsonResponse({
            securityKind: 'crypto',
            sources: [
              { source: 'coingecko', rung: 1 },
              { source: 'user_override', rung: 2 },
              { source: 'last_known', rung: 3 },
            ],
          });
        },
      },
    ]);

    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('crypto');
    await user.click(
      screen.getByRole('button', { name: "Move coingecko up in crypto's priority" }),
    );
    await user.click(screen.getByRole('button', { name: 'Save priority' }));

    await waitFor(() =>
      expect(putBody).toMatchObject({
        securityKind: 'crypto',
        sources: ['coingecko', 'user_override', 'last_known'],
      }),
    );
  });

  it('runs a test fetch and shows the quote with its attribution, gated by step-up', async () => {
    stubFetchRoutes([
      {
        match: '/api/market-data/settings',
        method: 'GET',
        handle: () => jsonResponse(settingsResponse()),
      },
      {
        match: '/api/auth/step-up/options',
        method: 'POST',
        handle: () => jsonResponse({ options: {} }),
      },
      {
        match: '/api/auth/step-up/verify',
        method: 'POST',
        handle: () => jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() }),
      },
      {
        match: '/api/market-data/test-fetch',
        method: 'POST',
        handle: () =>
          jsonResponse({
            provider: 'coingecko',
            operation: 'test_fetch',
            outcome: 'ok',
            quote: {
              date: '2026-09-24',
              value: '64000.12',
              currency: 'USD',
              attribution: COINGECKO_ATTRIBUTION,
            },
            detail: null,
            refusalCode: null,
            retryAfterMs: null,
            budget: [{ label: 'requests/min', used: 1, limit: 100 }],
          }),
      },
    ]);

    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('crypto');
    await user.selectOptions(screen.getByLabelText('Provider'), 'coingecko');
    await user.click(screen.getByRole('button', { name: 'Run test fetch' }));

    expect(await screen.findByText(/64000.12/)).toBeInTheDocument();
    // Two CoinGecko attributions are now on screen — the settings row's and
    // the test-fetch result's — proving the attribution travels with the
    // quote rather than being a one-off decoration near the provider list.
    expect(screen.getAllByText('Data provided by CoinGecko').length).toBeGreaterThanOrEqual(2);
  });
});
