// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { YAHOO_ATTRIBUTION } from '../market-data/yahoo-fixtures.ts';
import { HoldingsTable } from './HoldingsTable.tsx';
import { aggregatedHolding, coinGeckoAttribution, freshPrice } from './fixtures.ts';

function row(source: string) {
  return aggregatedHolding({
    securityId: 'sec-pftest',
    symbol: 'PFTEST',
    name: 'PF Test Corp (synthetic)',
    securityType: 'equity',
    price: { ...freshPrice('123.45'), source },
  });
}

function renderTable(source: string) {
  render(
    <HoldingsTable
      holdings={[row(source)]}
      accountHoldings={new Map()}
      accountNameOf={(id) => id}
      onOpenAccount={() => undefined}
      coinGeckoAttribution={coinGeckoAttribution()}
      yahooAttribution={YAHOO_ATTRIBUTION}
    />,
  );
}

describe('HoldingsTable provider labels (WP 12.6)', () => {
  it('a Yahoo-priced row carries the unofficial, best-effort label', () => {
    renderTable('yfinance');
    expect(screen.getByTestId('attribution-yfinance')).toHaveTextContent(
      'Yahoo Finance via yfinance — unofficial, best effort',
    );
    expect(screen.queryByTestId('attribution-coingecko')).not.toBeInTheDocument();
  });

  it('a Tiingo-priced row carries neither label', () => {
    renderTable('tiingo');
    expect(screen.queryByTestId('attribution-yfinance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attribution-coingecko')).not.toBeInTheDocument();
  });

  it('a CoinGecko-priced row still carries CoinGecko, and only that', () => {
    renderTable('coingecko');
    expect(screen.getByTestId('attribution-coingecko')).toBeInTheDocument();
    expect(screen.queryByTestId('attribution-yfinance')).not.toBeInTheDocument();
  });
});
