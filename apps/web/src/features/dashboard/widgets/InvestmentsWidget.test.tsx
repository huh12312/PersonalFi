// SPDX-License-Identifier: MIT
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { renderWidget } from '../test-utils.tsx';
import { usd } from './fixtures.ts';
import { InvestmentsWidget, yesterdayIso } from './InvestmentsWidget.tsx';

const NOW = new Date('2026-03-17T16:00:00');

function holding(id: string, valueMinor: number | null, stale = false, priceDate = '2026-03-17') {
  return {
    securityId: id,
    symbol: id.toUpperCase(),
    name: id,
    securityType: 'etf',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'Diversified',
    classificationSource: 'provider',
    quantity: '10',
    accountCount: 1,
    marketValue: valueMinor === null ? null : usd(valueMinor),
    costBasis: null,
    unrealized: { status: 'unavailable', reason: 'no_basis' },
    weight: null,
    price:
      valueMinor === null
        ? null
        : {
            close: '100',
            currency: 'USD',
            priceDate,
            rung: 'provider',
            source: 'tiingo',
            carriedForward: false,
            providerCarriedForward: false,
            observedAt: '2026-03-17T00:00:00Z',
            staleness: stale ? 'STALE' : 'FRESH',
            includeInAsOfNowDeltas: true,
          },
    stale,
  };
}

function serve(
  holdings: ReturnType<typeof holding>[],
  totalMinor: number,
  opts: { excluded?: number; opening?: number; gain?: number; performance?: boolean } = {},
) {
  stubFetchRoutes([
    {
      match: '/api/holdings',
      method: 'GET',
      handle: () =>
        jsonResponse({
          asOf: '2026-03-17',
          basis: 'as_of_now',
          currency: 'USD',
          total: usd(totalMinor),
          unclassifiedPct: '0',
          holdings,
          excluded: Array.from({ length: opts.excluded ?? 0 }, (_unused, index) => ({
            holdingId: `h${String(index)}`,
            symbol: null,
            reason: 'price_unknown',
          })),
          unresolved: [],
        }),
    },
    {
      match: '/api/investments/performance',
      method: 'GET',
      handle: ({ url }) =>
        opts.performance === false
          ? jsonResponse({ code: 'x' }, 404)
          : jsonResponse({
              from: url.searchParams.get('from'),
              to: '2026-03-17',
              currency: 'USD',
              summary: {
                kind: 'period_summary',
                from: url.searchParams.get('from'),
                to: '2026-03-17',
                openingValue: usd(opts.opening ?? 0),
                closingValue: usd(totalMinor),
                netContributions: usd(0),
                dividendsAndInterest: usd(0),
                reinvestedDividends: usd(0),
                feesPaid: usd(0),
                taxesWithheld: usd(0),
                periodGain: usd(opts.gain ?? 0),
              },
            }),
    },
  ]);
}

describe('InvestmentsWidget (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for the change since yesterday in the browser’s calendar', () => {
    expect(yesterdayIso(NOW)).toBe('2026-03-16');
    expect(yesterdayIso(new Date('2026-03-01T10:00:00'))).toBe('2026-02-28');
  });

  it('populated: the total and today’s change from the period gain', async () => {
    serve([holding('vti', 1_250_000)], 1_250_000, { opening: 1_240_000, gain: 10_000 });
    renderWidget(<InvestmentsWidget now={NOW} />);
    expect(await screen.findByText('Total value')).toBeInTheDocument();
    expect(document.body.textContent).toContain('$12,500.00');
    expect(await screen.findByText(/today/u)).toBeInTheDocument();
    expect(screen.getByTestId('investments-day-change').textContent).toMatch(
      /\+\$100\.00.* today/u,
    );
  });

  it('no price for yesterday: says there is no change to show, never +$0.00', async () => {
    serve([holding('vti', 1_250_000)], 1_250_000, { opening: 0, gain: 1_250_000 });
    renderWidget(<InvestmentsWidget now={NOW} />);
    const change = await screen.findByText(/No change since yesterday to show/u);
    expect(change).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('+$0.00');
  });

  it('holdings with no price: "no price yet", never a $0 total', async () => {
    serve([holding('vti', null)], 0, { excluded: 1 });
    const { container } = renderWidget(<InvestmentsWidget now={NOW} />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      'No price yet for 1 holding',
    );
    expect(container.textContent).not.toContain('$0.00');
  });

  it('no holdings: links to connecting a brokerage', async () => {
    serve([], 0);
    renderWidget(<InvestmentsWidget now={NOW} />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      'No investment holdings yet.',
    );
    expect(screen.getByRole('link', { name: 'Connect a brokerage' })).toHaveAttribute(
      'href',
      '/accounts/connections',
    );
  });

  it('a stale price shows its date', async () => {
    serve([holding('vti', 1_000_000, true, '2026-03-12')], 1_000_000, { opening: 1_000_000 });
    renderWidget(<InvestmentsWidget now={NOW} />);
    expect(await screen.findByTestId('widget-as-of')).toHaveTextContent(
      'Some prices are from Mar 12',
    );
  });
});
