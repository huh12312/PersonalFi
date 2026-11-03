// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetMarketDataSettingsResponse } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { ladderWithYahoo, YahooFinanceCard } from './YahooFinanceCard.tsx';
import { YAHOO_CONSENT_TEXT, yahooSettings } from './yahoo-fixtures.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

const LADDER = [
  { source: 'user_override', rung: 1 },
  { source: 'exchange_fill', rung: 2 },
  { source: 'tiingo', rung: 3 },
  { source: 'last_known', rung: 99 },
] as const;

function settings(
  yahoo: Partial<GetMarketDataSettingsResponse['yahoo']> = {},
  equity: readonly { source: string; rung: number }[] = LADDER,
): GetMarketDataSettingsResponse {
  return {
    providers: [],
    ladders: [{ securityKind: 'equity', sources: [...equity] as never }],
    settingsAttributions: [],
    allowedHostsNarrowed: false,
    yahoo: yahooSettings(yahoo),
  };
}

const CONSENTED = {
  operatorEnabled: true,
  consent: { given: true, consentedAt: '2026-11-02T15:00:00.000Z', version: 'yahoo-consent/1' },
  ready: true,
  notReady: null,
} as const;

function renderCard(data: GetMarketDataSettingsResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <YahooFinanceCard settings={data} />
    </QueryClientProvider>,
  );
}

describe('YahooFinanceCard (WP 12.6)', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('names Yahoo unofficial, shows the consent text verbatim and never says recommended or default', () => {
    renderCard(settings());
    expect(screen.getByRole('heading', { name: /Yahoo Finance \(unofficial\)/ })).toBeVisible();
    expect(screen.getByLabelText(YAHOO_CONSENT_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId('yahoo-what-leaves')).toHaveTextContent(
      'Only this leaves the machine: the ticker symbols and dates asked for',
    );
    expect(screen.getByTestId('yahoo-card').textContent).not.toMatch(/recommend|default/i);
  });

  it('operator half off: says how the operator turns it on', () => {
    renderCard(settings());
    const operator = screen.getByTestId('yahoo-operator');
    expect(operator).toHaveTextContent('Not enabled on this install');
    expect(operator).toHaveTextContent('YAHOO_FINANCE_ENABLED=true');
    expect(operator).toHaveTextContent('docker compose --profile yahoo up -d');
  });

  it('operator half on: says so', () => {
    renderCard(settings({ ...CONSENTED }));
    expect(screen.getByTestId('yahoo-operator')).toHaveTextContent('Enabled on this install');
  });

  it('"Use this provider" is disabled, with its reason, until the consent is given', () => {
    renderCard(settings({ operatorEnabled: true }));
    const use = screen.getByRole('button', { name: 'Use this provider' });
    expect(use).toBeDisabled();
    expect(use).toHaveAccessibleDescription('Disabled until the consent above is ticked.');
  });

  it('with consent, "Use this provider" places Yahoo after Tiingo by default', async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes([
      {
        match: '/api/market-data/priority',
        method: 'PUT',
        handle: async ({ request }) => {
          bodies.push(await request.json());
          return jsonResponse({ securityKind: 'equity', sources: [] });
        },
      },
      { match: '/api/market-data/settings', method: 'GET', handle: () => jsonResponse(settings()) },
    ]);
    renderCard(settings({ ...CONSENTED }));
    const use = screen.getByRole('button', { name: 'Use this provider' });
    expect(use).toBeEnabled();
    await userEvent.click(use);
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toEqual({
      securityKind: 'equity',
      sources: ['user_override', 'exchange_fill', 'tiingo', 'yfinance', 'last_known'],
    });
  });

  it("shows the api's refusal when it still answers 409 consent_required", async () => {
    stubFetchRoutes([
      {
        match: '/api/market-data/priority',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            {
              status: 409,
              code: 'market_data.consent_required',
              detail: 'Consent to the Yahoo Finance text is required first.',
            },
            409,
          ),
      },
    ]);
    renderCard(settings({ ...CONSENTED }));
    await userEvent.click(screen.getByRole('button', { name: 'Use this provider' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Consent to the Yahoo Finance text is required first.',
    );
  });

  it('ticking sends PUT consent with the shown version', async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes([
      {
        match: '/api/market-data/providers/yfinance/consent',
        method: 'PUT',
        handle: async ({ request }) => {
          bodies.push(await request.json());
          return jsonResponse(yahooSettings({ ...CONSENTED }));
        },
      },
      { match: '/api/market-data/settings', method: 'GET', handle: () => jsonResponse(settings()) },
    ]);
    renderCard(settings({ operatorEnabled: true }));
    await userEvent.click(screen.getByLabelText(YAHOO_CONSENT_TEXT));
    await waitFor(() => {
      expect(bodies).toEqual([{ consentVersion: 'yahoo-consent/1' }]);
    });
  });

  it('unticking calls DELETE consent', async () => {
    const calls: string[] = [];
    stubFetchRoutes([
      {
        match: '/api/market-data/providers/yfinance/consent',
        method: 'DELETE',
        handle: () => {
          calls.push('DELETE');
          return jsonResponse(yahooSettings({ operatorEnabled: true }));
        },
      },
      { match: '/api/market-data/settings', method: 'GET', handle: () => jsonResponse(settings()) },
    ]);
    renderCard(settings({ ...CONSENTED }));
    const box = screen.getByLabelText(YAHOO_CONSENT_TEXT);
    expect(box).toBeChecked();
    expect(screen.getByText(/removes Yahoo Finance from every ladder at once/)).toBeVisible();
    await userEvent.click(box);
    await waitFor(() => {
      expect(calls).toEqual(['DELETE']);
    });
  });

  it('shows where Yahoo sits, the last outcome and the budget left, and removes it from a ladder', async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes([
      {
        match: '/api/market-data/priority',
        method: 'PUT',
        handle: async ({ request }) => {
          bodies.push(await request.json());
          return jsonResponse({ securityKind: 'equity', sources: [] });
        },
      },
      { match: '/api/market-data/settings', method: 'GET', handle: () => jsonResponse(settings()) },
    ]);
    renderCard(
      settings(
        {
          ...CONSENTED,
          placements: [{ securityKind: 'equity', rung: 4, position: 4, of: 5 }],
          lastOutcome: {
            operation: 'price_refresh',
            outcome: 'rate_limited',
            at: '2026-11-02T15:30:00.000Z',
            detail: 'Yahoo asked us to slow down.',
            refusalCode: null,
            retryAfterMs: 60_000,
          },
          budget: [{ label: 'requests/hour', used: 3, limit: 60 }],
        },
        [
          { source: 'user_override', rung: 1 },
          { source: 'exchange_fill', rung: 2 },
          { source: 'tiingo', rung: 3 },
          { source: 'yfinance', rung: 4 },
          { source: 'last_known', rung: 99 },
        ],
      ),
    );
    expect(screen.getByTestId('yahoo-placement-equity')).toHaveTextContent(
      'Equity: 4th of 5, after Tiingo',
    );
    expect(screen.getByTestId('yahoo-last-outcome')).toHaveTextContent('Rate limited');
    expect(screen.getByTestId('yahoo-last-outcome')).toHaveTextContent(
      'Yahoo asked us to slow down.',
    );
    expect(screen.getByTestId('yahoo-budget')).toHaveTextContent('57 of 60 left this hour');
    expect(screen.getByTestId('attribution-yfinance')).toHaveTextContent(
      'Yahoo Finance via yfinance — unofficial, best effort',
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Yahoo Finance from the equity ladder' }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([
        {
          securityKind: 'equity',
          sources: ['user_override', 'exchange_fill', 'tiingo', 'last_known'],
        },
      ]);
    });
  });

  it('says so when nothing has been asked and nothing is placed', () => {
    renderCard(settings());
    expect(screen.getByTestId('yahoo-placements-none')).toBeVisible();
    expect(screen.getByTestId('yahoo-last-outcome')).toHaveTextContent('Never asked yet');
  });
});

describe('ladderWithYahoo', () => {
  const base = ['user_override', 'exchange_fill', 'tiingo', 'last_known'];
  it('after Tiingo', () => {
    expect(ladderWithYahoo(base, 'after_tiingo')).toEqual([
      'user_override',
      'exchange_fill',
      'tiingo',
      'yfinance',
      'last_known',
    ]);
  });
  it('before Tiingo, and moving rather than duplicating', () => {
    const placed = ['user_override', 'exchange_fill', 'tiingo', 'yfinance', 'last_known'];
    expect(ladderWithYahoo(placed, 'before_tiingo')).toEqual([
      'user_override',
      'exchange_fill',
      'yfinance',
      'tiingo',
      'last_known',
    ]);
  });
  it('never ahead of user_override or behind last_known without Tiingo', () => {
    const noTiingo = ['user_override', 'last_known'];
    expect(ladderWithYahoo(noTiingo, 'before_tiingo')).toEqual([
      'user_override',
      'yfinance',
      'last_known',
    ]);
    expect(ladderWithYahoo(noTiingo, 'after_tiingo')).toEqual([
      'user_override',
      'yfinance',
      'last_known',
    ]);
  });
});
