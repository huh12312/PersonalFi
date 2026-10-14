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
import { useHoldingsQuery } from '../investments/api.ts';
import { holdingsResponse } from '../investments/fixtures.ts';
import { summary, unpriced } from './refresh-fixtures.ts';
import { RefreshPrices } from './RefreshPricesButton.tsx';

/**
 * WP 10.5: the Refresh prices button - its busy state, what it says on success, on the 409 and on any other
 * failure, and that a success makes the screens that show prices read them again.
 */

const TOO_SOON = {
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  code: 'market_data.refresh_too_soon',
  detail:
    'Prices were refreshed less than ten minutes ago. Try again after 2026-10-14T09:10:00.000Z.',
};

function localClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** Counts reads of `GET /holdings`, so a refetch after a refresh can be seen. */
function HoldingsProbe() {
  const query = useHoldingsQuery('as_of_now');
  return <p data-testid="probe">{query.data === undefined ? 'loading' : query.data.asOf}</p>;
}

function setUp(refresh: FetchRoute['handle']) {
  const reads = { holdings: 0, refresh: 0 };
  stubFetchRoutes([
    {
      method: 'POST',
      match: '/api/market-data/refresh',
      handle: (context) => {
        reads.refresh += 1;
        return refresh(context);
      },
    },
    {
      match: '/api/holdings',
      handle: () => {
        reads.holdings += 1;
        return jsonResponse(holdingsResponse());
      },
    },
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HoldingsProbe />
      <RefreshPrices />
    </QueryClientProvider>,
  );
  return reads;
}

const button = () => screen.getByRole('button', { name: /^Refresh(ing)? prices/u });

describe('Refresh prices (WP 10.5)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has a polite live region from the start, empty until there is something to say', () => {
    setUp(() => jsonResponse(summary()));
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
    expect(button()).toBeEnabled();
    expect(button()).toHaveAttribute('aria-busy', 'false');
  });

  it('is disabled and busy while the refresh runs, and enabled again after', async () => {
    let release: (response: Response) => void = () => undefined;
    const reads = setUp(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const user = userEvent.setup();
    await user.click(button());

    await waitFor(() => expect(button()).toBeDisabled());
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(button()).toHaveTextContent('Refreshing prices…');
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing prices…');
    // A second press while it runs sends nothing.
    await user.click(button());
    expect(reads.refresh).toBe(1);

    release(jsonResponse(summary()));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Priced 12 of 12.');
  });

  it('says in words what was priced and what was not, and lists each unpriced holding in a disclosure', async () => {
    setUp(() =>
      jsonResponse(
        summary({
          unpriced: [unpriced({ detail: 'COINGECKO_API_KEY is not set.' })],
          counts: { held: 14, priceable: 13, priced: 12, unpriced: 1, notPricedByProvider: 1 },
        }),
      ),
    );
    const user = userEvent.setup();
    await user.click(button());

    const region = await screen.findByRole('status');
    await waitFor(() =>
      expect(region).toHaveTextContent(
        'Priced 12 of 13; 1 unpriced: no CoinGecko key. 1 cash or other holding is not priced by a provider.',
      ),
    );
    const result = screen.getByTestId('refresh-prices-result');
    // The disclosure is outside the live region, so opening it is not announced as news.
    const summaryEl = within(result).getByText(/Which holdings were not priced \(1\)/u);
    expect(region).not.toContainElement(summaryEl);
    const details = summaryEl.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    await user.click(summaryEl);
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent('BTC: no CoinGecko key — COINGECKO_API_KEY is not set.');
  });

  it('shows no disclosure when everything was priced', async () => {
    setUp(() => jsonResponse(summary()));
    await userEvent.setup().click(button());
    await screen.findByText('Priced 12 of 12.');
    expect(screen.queryByText(/Which holdings were not priced/u)).not.toBeInTheDocument();
  });

  it('turns the 409 into "try again after <local time>", not an error', async () => {
    setUp(() => jsonResponse(TOO_SOON, 409));
    await userEvent.setup().click(button());

    const expected = `Prices were refreshed recently. Try again after ${localClock('2026-10-14T09:10:00.000Z')}.`;
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(expected);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(button()).toBeEnabled();
  });

  it("shows the api's own words as an alert for any other failure", async () => {
    setUp(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Market data is off.',
        },
        503,
      ),
    );
    await userEvent.setup().click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Market data is off.');
  });

  it('reads the holdings again after a successful refresh, so the new prices show', async () => {
    const reads = setUp(() => jsonResponse(summary()));
    await waitFor(() => expect(screen.getByTestId('probe')).not.toHaveTextContent('loading'));
    expect(reads.holdings).toBe(1);

    await userEvent.setup().click(button());
    await screen.findByText('Priced 12 of 12.');
    await waitFor(() => expect(reads.holdings).toBe(2));
  });

  it('does not read anything again when the refresh was refused', async () => {
    const reads = setUp(() => jsonResponse(TOO_SOON, 409));
    await waitFor(() => expect(screen.getByTestId('probe')).not.toHaveTextContent('loading'));
    await userEvent.setup().click(button());
    await screen.findByText(/Prices were refreshed recently/u);
    expect(reads.holdings).toBe(1);
  });
});
