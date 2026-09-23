// SPDX-License-Identifier: MIT
/**
 * The loader for WP 3.3's committed spreadsheet fixture.
 *
 * Lives beside the CSVs rather than inside one test file because four suites
 * read the same portfolio — allocation, fees, concentration and the property
 * tests — and a fixture imported from another `*.test.ts` would re-register
 * that file's tests in every importer.
 *
 * The CSVs carry their formulas in `#` comment lines at the top; this parser
 * skips them, which is what makes the formulas part of the committed artefact
 * rather than something that drifts out of a README.
 */
import { Money, Quantity, currency } from '@core/kernel';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AssetClass, Region } from '../../schema/index.ts';
import type { AnalyticsHolding } from '../../src/analytics/types.ts';
import type { PriceStaleness } from '../../src/prices.ts';

export const FIXTURE_CURRENCY = currency('USD');
export const FIXTURE_SCALE = 2;

export interface FixtureHolding extends AnalyticsHolding {
  /** The spreadsheet's own `ROUND(quantity * price, 2)` column. */
  readonly expectedMarketValue: string;
}

export function readFixtureRows(name: string): readonly Record<string, string>[] {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const header = lines[0]?.split(',') ?? [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
  });
}

function holdingOf(row: Record<string, string>): FixtureHolding {
  const price = row['price'] ?? '';
  const expenseRatio = row['expense_ratio'] ?? '';
  const costBasis = row['cost_basis'] ?? '';
  return {
    holdingId: row['holding_id'] ?? '',
    accountId: row['account_id'] ?? '',
    securityId: row['security_id'] ?? '',
    symbol: row['symbol'] ?? null,
    quantity: Quantity.of(row['quantity'] ?? '0'),
    price: price === '' ? null : { amount: Quantity.of(price), currency: FIXTURE_CURRENCY },
    staleness: (row['staleness'] === 'STALE' ? 'STALE' : 'FRESH') satisfies PriceStaleness,
    assetClass: (row['asset_class'] ?? 'UNCLASSIFIED') as AssetClass,
    region: (row['region'] ?? 'UNKNOWN') as Region,
    sector: row['sector'] ?? 'UNKNOWN',
    // An empty cell is `null` — "we do not know" — and never `'0'`, which
    // would claim the fund charges nothing.
    expenseRatio: expenseRatio === '' ? null : expenseRatio,
    isCashEquivalent: row['is_cash_equivalent'] === 'true',
    isInvestable: row['is_investable'] === 'true',
    costBasis: costBasis === '' ? null : Money.parseAmount(costBasis, FIXTURE_CURRENCY),
    expectedMarketValue: row['expected_market_value'] ?? '',
  };
}

/** The eleven positions of `allocation-portfolio.csv`. */
export const FIXTURE_HOLDINGS: readonly FixtureHolding[] = readFixtureRows(
  'allocation-portfolio.csv',
).map(holdingOf);

/** Every expected slice of `allocation-expected.csv`. */
export const FIXTURE_EXPECTED = readFixtureRows('allocation-expected.csv');

export function expectedSlices(
  basis: string,
  dimension: string,
): readonly Record<string, string>[] {
  return FIXTURE_EXPECTED.filter((row) => row['basis'] === basis && row['dimension'] === dimension);
}

export function expectedTotal(basis: string): string {
  return expectedSlices(basis, 'portfolio')[0]?.['expected_value'] ?? '';
}
