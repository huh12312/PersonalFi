// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { GetRecurringForecastResponse } from '../../api/generated/types.gen.ts';
import { ForwardCashFlowCard } from './ForwardCashFlowCard.tsx';

const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });

function forecast(charges: GetRecurringForecastResponse['charges']): GetRecurringForecastResponse {
  return {
    from: '2026-10-16',
    to: '2026-11-15',
    currency: 'USD',
    outflow: usd(0),
    inflow: usd(0),
    net: usd(0),
    netLow: usd(0),
    netHigh: usd(0),
    chargeCount: charges.length,
    charges,
  };
}

const SAFE = {
  from: '2026-10-16',
  to: '2026-11-15',
  currency: 'USD',
  availableCash: usd(6749800),
  committed: usd(0),
  committedWorstCase: usd(0),
  expectedIncome: usd(0),
  safe: usd(6749800),
  committedCount: 0,
};

const UBER = { id: 'series_uber', merchantId: 'merch_uber', cadence: 'ANNUAL', state: 'ACTIVE' };

describe('ForwardCashFlowCard (WP 10.7)', () => {
  it('no charge in the window: the statement, not a projection; the strip still populated', () => {
    render(
      <ForwardCashFlowCard
        forecast={forecast([])}
        safeToSpend={SAFE}
        series={[UBER]}
        nameOf={() => 'Uber'}
      />,
    );
    expect(screen.getByTestId('forecast-empty')).toHaveTextContent(
      'No charges expected in the next 30 days — 1 stream (Uber, yearly) has no due date in this window.',
    );
    // No chart of any kind: no legend, no table toggle, no image.
    expect(screen.queryByTestId('forecast-legend')).toBeNull();
    expect(screen.queryByRole('button', { name: /^View as table/ })).toBeNull();
    expect(screen.getByText('Safe to spend')).toBeInTheDocument();
    expect(screen.getByText('+$67,498.00')).toBeInTheDocument();
    expect(screen.getByText('Expected net (30 days)')).toBeInTheDocument();
    expect(screen.getByText('After every expected charge')).toBeInTheDocument();
    expect(screen.getByText('If every uncertain charge lands at its worst')).toBeInTheDocument();
  });

  it('a charge in the window: the chart (its key and its table), no statement', () => {
    render(
      <ForwardCashFlowCard
        forecast={forecast([
          {
            seriesId: 'series_uber',
            streamKey: 'k',
            merchantId: 'merch_uber',
            type: 'SUBSCRIPTION',
            cadence: 'ANNUAL',
            sign: 'OUTFLOW',
            status: 'ACTIVE',
            userConfirmed: true,
            confidence: 0.9,
            slot: 0,
            date: '2026-10-20',
            earliest: '2026-10-19',
            latest: '2026-10-21',
            uncertaintyDays: 1,
            expected: usd(-586),
            low: usd(-586),
            high: usd(-586),
          },
        ])}
        safeToSpend={SAFE}
        series={[UBER]}
        nameOf={() => 'Uber'}
      />,
    );
    expect(screen.queryByTestId('forecast-empty')).toBeNull();
    expect(screen.getByTestId('forecast-legend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^View as table/ })).toBeInTheDocument();
    // A single fixed charge: the band is empty, and the card says why.
    expect(screen.getByTestId('forecast-band-note')).toHaveTextContent(
      'No band is shaded: every charge in this window has a fixed amount, so nothing is uncertain.',
    );
  });
});
