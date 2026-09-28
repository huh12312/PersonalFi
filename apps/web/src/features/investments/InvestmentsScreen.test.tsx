// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { InvestmentsScreen } from './InvestmentsScreen.tsx';
import {
  accountHoldingsResponse,
  allocationResponse,
  driftWithTargets,
  driftWithoutTargets,
  holdingsResponse,
  marketDataSettingsResponse,
  performanceResponse,
  unresolvedSecurity,
} from './fixtures.ts';
import type { InvestmentsSearch } from './search.ts';

const TODAY = new Date('2026-09-23T00:00:00Z');

const ACCOUNTS = [
  {
    id: 'acct-taxable',
    connectionId: 'conn_1',
    provider: 'manual',
    name: 'Taxable brokerage',
    officialName: null,
    type: 'investment',
    subtype: 'brokerage',
    classification: 'asset',
    currency: 'USD',
    mask: '1234',
    closedAt: null,
    includeInNetWorth: true,
    balance: null,
  },
];

function accountsRoute(): FetchRoute {
  return { match: '/api/accounts', handle: () => jsonResponse({ accounts: ACCOUNTS }) };
}

interface RouteOverrides {
  readonly drift?: unknown;
  readonly holdings?: unknown;
  readonly accountHoldings?: unknown;
  readonly performance?: unknown;
  readonly onBasisMethod?: (body: unknown) => Response;
}

function routesFor(overrides: RouteOverrides = {}): FetchRoute[] {
  return [
    {
      match: /^\/api\/accounts\/[^/]+\/holdings$/,
      handle: () => jsonResponse(overrides.accountHoldings ?? accountHoldingsResponse()),
    },
    accountsRoute(),
    {
      match: '/api/holdings',
      handle: () => jsonResponse(overrides.holdings ?? holdingsResponse()),
    },
    { match: '/api/investments/allocation', handle: () => jsonResponse(allocationResponse()) },
    {
      match: '/api/investments/drift',
      handle: () => jsonResponse(overrides.drift ?? driftWithoutTargets()),
    },
    {
      match: '/api/investments/performance',
      handle: () => jsonResponse(overrides.performance ?? performanceResponse()),
    },
    {
      // `useCoinGeckoAttribution` (`features/market-data/api.ts`) fires on
      // every mount of `InvestmentsScreen` — `wp3.14-carryovers.md` item 1.
      match: '/api/market-data/settings',
      handle: () => jsonResponse(marketDataSettingsResponse()),
    },
    {
      method: 'PUT',
      match: '/api/investments/basis-method',
      handle: async ({ request }) =>
        overrides.onBasisMethod === undefined
          ? jsonResponse({
              accountId: 'acct-taxable',
              securityId: 'sec-vti',
              method: 'HIFO',
              sticky: false,
            })
          : overrides.onBasisMethod(await request.json()),
    },
  ];
}

function renderScreen(search: InvestmentsSearch = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSearchChange = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <InvestmentsScreen search={search} onSearchChange={onSearchChange} today={TODAY} />
    </QueryClientProvider>,
  );
  return { onSearchChange, view };
}

describe('InvestmentsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the portfolio total and the unclassified share from GET /holdings', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    // `total` = 17_649_960 minor = the committed fixture's last_known TOTAL.
    expect(await screen.findByTestId('portfolio-total')).toHaveTextContent('$176,499.60');
    expect(screen.getByTestId('holdings-unclassified-pct')).toHaveTextContent('1.7%');
  });

  it('shows a position the resolver could not identify, rather than nothing (C-8, G3-11)', async () => {
    stubFetchRoutes(
      routesFor({
        holdings: { ...holdingsResponse(), unresolved: [unresolvedSecurity()] },
      }),
    );

    renderScreen();

    const notice = await screen.findByTestId('unresolved-securities');
    expect(notice).toHaveTextContent('1 position could not be identified');
    expect(notice).toHaveTextContent('Mystery Fund');
    expect(notice).toHaveTextContent('plaid');
  });

  it('shows nothing when every position resolved', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    await screen.findByTestId('portfolio-total');
    expect(screen.queryByTestId('unresolved-securities')).not.toBeInTheDocument();
  });

  it('aggregates by ticker and expands into the accounts holding it', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    const row = await screen.findByTestId('holding-row-VTI');
    expect(within(row).getByText(/2 accounts/)).toBeInTheDocument();

    const expander = within(row).getByRole('button', { expanded: false });
    await userEvent.click(expander);

    const accountsRow = await screen.findByTestId('holding-accounts-VTI');
    expect(within(accountsRow).getByRole('button', { name: 'Taxable brokerage' })).toBeVisible();
  });

  it('renders "unavailable" and not "$0.00" for a holding with no cost basis', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    const row = await screen.findByTestId('holding-row-BTC');
    expect(within(row).getAllByText('unavailable').length).toBeGreaterThan(0);
    // Twice: once for the cost-basis cell, once for the unrealized cell.
    expect(within(row).getAllByText(/cost basis unknown/)).toHaveLength(2);
    expect(row.textContent).not.toContain('$0.00');
  });

  it('labels a stale price rather than hiding it', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    const row = await screen.findByTestId('holding-row-OLDCO');
    const badge = within(row).getByTestId('stale-badge');
    expect(badge).toHaveTextContent('STALE');
    expect(badge).toHaveAttribute('title', 'Price last observed 2026-09-19');
  });

  it('renders the CoinGecko attribution on the holdings tab because BTC is coingecko-priced', async () => {
    stubFetchRoutes(routesFor());

    renderScreen();

    await screen.findByTestId('holding-row-BTC');
    const attribution = await screen.findByTestId('attribution-coingecko');
    expect(attribution).toHaveTextContent('Data provided by CoinGecko');
    expect(within(attribution).getByRole('link')).toHaveAttribute(
      'href',
      'https://www.coingecko.com',
    );
  });

  it('renders the allocation donut legend and the % unclassified beside it', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ tab: 'allocation' });

    const legend = await screen.findByTestId('allocation-legend');
    const usEquity = within(legend).getByTestId('allocation-slice-US_EQUITY');
    // `expected_value` for last_known / asset_class / US_EQUITY in
    // packages/contexts/investments/test/fixtures/allocation-expected.csv.
    expect(within(usEquity).getByTestId('slice-value')).toHaveTextContent('$76,300.80');

    const unclassified = screen.getByTestId('allocation-unclassified');
    expect(within(unclassified).getByTestId('unclassified-pct')).toHaveTextContent('1.7%');
  });

  it('renders the CoinGecko attribution on the allocation tab (the CRYPTO slice is a coingecko-priced sum)', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ tab: 'allocation' });

    await screen.findByTestId('allocation-legend');
    expect(await screen.findByTestId('attribution-coingecko')).toHaveTextContent(
      'Data provided by CoinGecko',
    );
  });

  it('switches the allocation dimension through URL state, never local state', async () => {
    stubFetchRoutes(routesFor());

    const { onSearchChange } = renderScreen({ tab: 'allocation' });

    await screen.findByTestId('allocation-legend');
    await userEvent.click(screen.getByRole('radio', { name: 'Sector' }));

    expect(onSearchChange).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: 'sector', tab: 'allocation' }),
    );
  });

  it('renders no drift rows and no band when no target is set', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ tab: 'drift' });

    expect(await screen.findByText('Set a target allocation')).toBeInTheDocument();
    expect(screen.queryByTestId('drift-band-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drift-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drift-row-US_EQUITY')).not.toBeInTheDocument();
  });

  it('draws the ±5-point band and an inside/outside label once targets are set', async () => {
    stubFetchRoutes(routesFor({ drift: driftWithTargets() }));

    renderScreen({ tab: 'drift', target: ['US_EQUITY:0.6', 'US_BOND:0.3', 'CASH:0.1'] });

    expect(await screen.findByTestId('drift-band')).toBeInTheDocument();
    expect(screen.getByText('Rebalancing band: ±5.0000 percentage points')).toBeInTheDocument();

    const cash = screen.getByTestId('drift-row-CASH');
    expect(within(cash).getByText('inside band')).toBeInTheDocument();
    const usEquity = screen.getByTestId('drift-row-US_EQUITY');
    expect(within(usEquity).getByText('outside band')).toBeInTheDocument();
  });

  it('keeps TWR, MWR and the dollar gain in three separate blocks', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ tab: 'performance' });

    const twr = await screen.findByTestId('twr-block');
    const mwr = screen.getByTestId('mwr-block');
    const gain = screen.getByTestId('dollar-gain-block');

    expect(within(twr).getByText('Time-weighted return (TWR)')).toBeInTheDocument();
    expect(within(mwr).getByText('Money-weighted return (MWR)')).toBeInTheDocument();
    expect(within(gain).getByTestId('dollar-gain-value')).toHaveTextContent('$18,242.10');

    // The rule: no dollar amount inside either rate block, and no percentage
    // return inside the dollar-gain block. `$` and `%` are the cheap, total
    // check — a layout change that put them together would trip it.
    expect(twr.textContent).not.toContain('$');
    expect(mwr.textContent).not.toContain('$');
    expect(gain.textContent).not.toContain('%');
  });

  it('renders the CoinGecko attribution on the performance tab', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ tab: 'performance' });

    await screen.findByTestId('twr-block');
    expect(await screen.findByTestId('attribution-coingecko')).toHaveTextContent(
      'Data provided by CoinGecko',
    );
  });

  it('shows a lot with no basis as "unavailable" with its basis source', async () => {
    stubFetchRoutes(routesFor());

    renderScreen({ account: 'acct-taxable' });

    const lots = await screen.findByTestId('lots-BTC');
    const basisCell = within(lots).getByTestId('lot-basis-lot-btc-1');
    expect(basisCell).toHaveTextContent('unavailable');
    expect(basisCell.textContent).not.toContain('$0.00');
    expect(within(lots).getByText('unknown')).toBeInTheDocument();
    expect(within(lots).getByText(/Transferred in without a basis/)).toBeInTheDocument();
  });

  it('offers AVERAGE_COST only for a mutual fund, and renders the API refusal verbatim', async () => {
    const refusal = 'AVERAGE_COST is available for mutual_fund only; this security is a etf.';
    stubFetchRoutes(
      routesFor({
        onBasisMethod: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              code: 'investments.average_cost_ineligible',
              detail: refusal,
            },
            422,
          ),
      }),
    );

    renderScreen({ account: 'acct-taxable' });

    const controls = await screen.findAllByTestId('basis-method-control');
    const vti = controls[0];
    expect(vti).toBeDefined();
    // VTI is an `etf` in `GET /holdings`, so the option is not even offered.
    expect(
      within(vti as HTMLElement).queryByRole('option', {
        name: 'Average cost (mutual funds only)',
      }),
    ).not.toBeInTheDocument();

    await userEvent.selectOptions(within(vti as HTMLElement).getByRole('combobox'), 'HIFO');
    await userEvent.click(
      within(vti as HTMLElement).getByRole('button', { name: 'Save election' }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('basis-method-refusal')).toHaveTextContent(refusal);
    });
  });

  it('locks the control once AVERAGE_COST has been elected', async () => {
    const response = accountHoldingsResponse();
    const [first, ...rest] = response.positions;
    expect(first).toBeDefined();
    stubFetchRoutes(
      routesFor({
        accountHoldings: {
          ...response,
          positions: [
            { ...(first as (typeof response.positions)[number]), basisMethod: 'AVERAGE_COST' },
            ...rest,
          ],
        },
      }),
    );

    renderScreen({ account: 'acct-taxable' });

    const sticky = await screen.findByTestId('basis-method-sticky');
    expect(sticky).toHaveTextContent('This election is permanent and cannot be changed.');
  });
});
