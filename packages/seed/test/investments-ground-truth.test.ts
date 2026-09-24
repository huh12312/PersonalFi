// SPDX-License-Identifier: MIT
/**
 * WP 3.14's exit test: the seed's declared ground truth, graded against the
 * engine it exists to grade.
 *
 * `src/phase3-investments.ts` **declares** every lot's basis, its
 * `quantity_remaining`, the short-term / long-term split of every realised
 * gain, and every `POSSIBLE_WASH_SALE` — as hand-computed literals, with the
 * arithmetic written beside each one. This file feeds the same generator's
 * *transactions* (never its expectations) into `@ctx/investments`' pure engine
 * and compares. Two independent derivations of the same numbers: a
 * disagreement is either a generator that lies to every fixture downstream of
 * it or an engine that computes a tax number wrongly, and both are worth
 * failing a build over.
 *
 * ## The import that points the wrong way, and why it is confined to here
 *
 * `@core/seed` is a core package: `scripts/eslint-boundaries.js` allows it
 * `@core/kernel` and nothing else, and that rule is right — the demo generator
 * must not become something a context has to compile against. The engine
 * import below is therefore a *relative* one, in a `test/` file, with the
 * boundary rule disabled on the line and this paragraph as the reason. It is
 * the same shape `@ctx/categorization`'s harness used before its layer landed
 * (`docs/evidence/phase-1/wp1.4-categorization.md` §5).
 *
 * The alternative — a `@ctx/investments` devDependency on `@core/seed`'s
 * package.json, plus an `allow` entry — is the orchestrator's to make (agents
 * touch neither the lockfile nor `eslint-boundaries.js`), and
 * `docs/evidence/phase-3/wp3.14-quality.md` §8 asks for it. Nothing under
 * `src/` imports a context, so `@core/seed` still ships with one dependency.
 */
import {
  DateOnly,
  Money,
  Quantity,
  currency,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
} from '@core/kernel';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allocationBy,
  applyWashSales,
  marketValueOf,
  matchDisposal,
  openLot,
  remainingBasisOf,
  scanForPossibleWashSales,
  unrealizedGainOf,
  valueHoldings,
  type AcquisitionForScan,
  type AnalyticsHolding,
  type DisposalForScan,
  type DisposalRequest,
  type Lot,
  type ValuationOptions,
} from '@ctx/investments';
import {
  generatePhase3Investments,
  type SeedInvestmentsDataset,
  type SeedPhase3Holding,
  type SeedSecurity,
} from '../src/phase3-investments.ts';

const USD = currency('USD');
const SCALE = 2;
const SEED = 3_14;

const dataset = generatePhase3Investments(SEED);

// ---------------------------------------------------------------------------
// Driving the engine over the generator's transactions
// ---------------------------------------------------------------------------

interface EngineRun {
  readonly lots: readonly Lot[];
  readonly disposals: ReadonlyMap<string, ReturnType<typeof matchDisposal>>;
}

/**
 * Replay the seed's investment transactions through the real engine, in trade
 * date order, opening a lot per acquisition and matching every disposal FIFO.
 *
 * The only thing taken from the generator's ground truth is the *lot id* to
 * open each acquisition under, so the two sides can be compared by name. Every
 * number comes from the transaction.
 */
function replay(data: SeedInvestmentsDataset): EngineRun {
  const lotIdByTransaction = new Map(
    data.lots.map((lot) => [lot.openedByTransactionId, lot.lotId]),
  );
  const ordered = [...data.transactions].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  let lots: readonly Lot[] = [];
  const disposals = new Map<string, ReturnType<typeof matchDisposal>>();

  for (const transaction of ordered) {
    if (transaction.type === 'SELL') {
      const request: DisposalRequest = {
        accountId: transaction.accountId,
        securityId: transaction.securityId,
        date: transaction.tradeDate,
        quantity: Quantity.of(transaction.quantity),
        proceeds: Money.fromJSON(transaction.gross),
        fees: Money.fromJSON(transaction.fees),
        method: 'FIFO',
      };
      const result = matchDisposal(lots, request);
      disposals.set(transaction.id, result);
      lots = result.lots;
      continue;
    }

    const lotId = lotIdByTransaction.get(transaction.id);
    if (lotId === undefined) throw new Error(`no declared lot for ${transaction.id}`);
    // A BUY reports what it cost. A TRANSFER_IN reports nothing, and an
    // unknown basis must stay unknown rather than become the zero in `gross`.
    const known = transaction.type === 'BUY';
    const opened = openLot({
      id: lotId,
      accountId: transaction.accountId,
      securityId: transaction.securityId,
      openDate: transaction.tradeDate,
      quantity: Quantity.of(transaction.quantity),
      basis: known ? Money.fromJSON(transaction.gross) : null,
      currency: currency(transaction.gross.currency),
      basisSource: known ? 'BROKER' : 'ESTIMATED',
      acquisitionType: known ? 'BUY' : 'TRANSFER_IN',
      openedByTransactionId: transaction.id,
    });
    lots = [...lots, opened.lot];
  }

  return { lots, disposals };
}

const run = replay(dataset);
const lotById = new Map(run.lots.map((lot) => [lot.id, lot]));

function moneyOf(json: { minor: string; currency: string }): Money {
  return Money.fromJSON(json);
}

describe('the seed investments dataset, against @ctx/investments', () => {
  it("the generator's declared lots match what the basis engine computes", () => {
    expect(run.lots).toHaveLength(dataset.lots.length);

    for (const declared of dataset.lots) {
      const actual = lotById.get(declared.lotId);
      expect(actual, `no engine lot for ${declared.lotId} (${declared.why})`).toBeDefined();
      if (actual === undefined) continue;

      const where = `${declared.lotId}: ${declared.why}`;

      // What is left, to 18 decimal places.
      expect(Quantity.toDatabaseString(actual.quantityRemaining), where).toBe(
        Quantity.toDatabaseString(Quantity.of(declared.expectedQuantityRemaining)),
      );

      // The basis as opened — `null` stays `null`, and never becomes a zero.
      if (declared.expectedBasis === null) {
        expect(actual.basis, where).toBeNull();
        expect(actual.basisSource, where).toBe('ESTIMATED');
        expect(actual.basisWarning, where).not.toBeNull();
      } else {
        expect(actual.basis, where).toEqual(moneyOf(declared.expectedBasis));
        expect(actual.basisSource, where).toBe(declared.basisSource);
      }

      // And what the disposals left attached to it.
      const remaining = remainingBasisOf(actual);
      if (declared.expectedRemainingBasis === null) {
        expect(remaining, where).toBeNull();
      } else {
        expect(remaining, where).toEqual(moneyOf(declared.expectedRemainingBasis));
      }
    }
  });

  it('every declared disposal matches the same lots, in the same order, with the same ST/LT split', () => {
    for (const declared of dataset.disposals) {
      const result = run.disposals.get(declared.transactionId);
      expect(result, `no engine disposal for ${declared.transactionId}`).toBeDefined();
      if (result === undefined) continue;

      const where = `${declared.transactionId}: ${declared.why}`;

      expect(
        result.matches.map((match) => match.lotId),
        where,
      ).toEqual(declared.matches.map((match) => match.lotId));
      expect(Quantity.toDatabaseString(result.unmatchedQuantity), where).toBe(
        Quantity.toDatabaseString(Quantity.zero),
      );

      declared.matches.forEach((expectedMatch, index) => {
        const match = result.matches[index];
        expect(match, where).toBeDefined();
        if (match === undefined) return;
        expect(Quantity.toDatabaseString(match.quantity), where).toBe(
          Quantity.toDatabaseString(Quantity.of(expectedMatch.quantity)),
        );
        expect(match.proceeds, where).toEqual(moneyOf(expectedMatch.proceeds));
        expect(match.basis, where).toEqual(
          expectedMatch.basis === null ? null : moneyOf(expectedMatch.basis),
        );
        expect(match.term, where).toBe(expectedMatch.term);
        expect(match.gain, where).toEqual(
          expectedMatch.gain === null ? null : moneyOf(expectedMatch.gain),
        );
      });

      for (const [term, expected] of [
        ['shortTerm', declared.expectedShortTerm],
        ['longTerm', declared.expectedLongTerm],
      ] as const) {
        const realized = result.realized[term];
        if (expected === 'unavailable') {
          expect(realized.status, `${where} (${term})`).toBe('unavailable');
          continue;
        }
        expect(realized.status, `${where} (${term})`).toBe('available');
        if (realized.status !== 'available') continue;
        // A term that realised nothing is an explicit zero, not an absence.
        const target = expected === null ? Money.zero(realized.amount.currency) : moneyOf(expected);
        expect(realized.amount, `${where} (${term})`).toEqual(target);
      }
    }
  });

  it('the declared POSSIBLE_WASH_SALE is found, and the day-31 repurchase is not', () => {
    const retirement = new Set(
      dataset.accounts.filter((account) => account.isRetirement).map((account) => account.id),
    );
    const cryptoIds = new Set(
      dataset.securities.filter((s) => s.type === 'crypto').map((s) => s.id),
    );

    const disposalsForScan: DisposalForScan[] = [];
    const soldHoldingPeriodStart = new Map<string, DateOnlyType>();
    for (const declared of dataset.disposals) {
      const result = run.disposals.get(declared.transactionId);
      if (result === undefined) continue;
      const first = result.matches[0];
      if (first === undefined) continue;
      const gain = result.matches.reduce<Money | null>(
        (total, match) =>
          total === null || match.gain === null ? null : Money.add(total, match.gain),
        Money.zero(first.proceeds.currency),
      );
      disposalsForScan.push({
        id: declared.transactionId,
        accountId: declared.accountId,
        securityId: declared.securityId,
        date: declared.date,
        quantity: Quantity.of(declared.quantity),
        gain,
      });
      soldHoldingPeriodStart.set(declared.transactionId, first.holdingPeriodStartDate);
    }

    const acquisitions: AcquisitionForScan[] = run.lots.map((lot) => ({
      lotId: lot.id,
      accountId: lot.accountId,
      securityId: lot.securityId,
      openDate: lot.openDate,
      quantity: lot.quantity,
      isRetirementAccount: retirement.has(lot.accountId),
    }));

    const flags = scanForPossibleWashSales({
      disposals: disposalsForScan,
      acquisitions,
      soldHoldingPeriodStart,
      isDigitalAsset: (securityId) => cryptoIds.has(securityId),
    });

    expect(flags.map((flag) => flag.disposalId)).toEqual(
      dataset.washSales.map((declared) => declared.disposalTransactionId),
    );

    dataset.washSales.forEach((declared, index) => {
      const flag = flags[index];
      expect(flag, declared.why).toBeDefined();
      if (flag === undefined) return;
      expect(flag.label).toBe('POSSIBLE_WASH_SALE');
      expect(flag.replacementLotId).toBe(declared.replacementLotId);
      expect(flag.offsetDays).toBe(declared.offsetDays);
      expect(flag.disallowedLoss).toEqual(moneyOf(declared.disallowedLoss));
      expect(flag.tackedHoldingPeriodStartDate).toBe(declared.tackedHoldingPeriodStartDate);
      expect(flag.basisAdjustmentIsPermanentlyLost).toBe(declared.basisAdjustmentIsPermanentlyLost);
    });

    // The other half of the boundary: day 31 is not a wash sale, and a check
    // that only ever asserts the positive case cannot tell 30 from 31.
    for (const declared of dataset.notWashSales) {
      expect(
        flags.some((flag) => flag.disposalId === declared.disposalTransactionId),
        declared.why,
      ).toBe(false);
    }

    // And the adjustment lands where the generator says it lands.
    const adjusted = new Map(applyWashSales(run.lots, flags).map((lot) => [lot.id, lot] as const));
    for (const declared of dataset.lots) {
      const lot = adjusted.get(declared.lotId);
      if (lot === undefined) continue;
      if (declared.expectedBasisAfterWashSale === null) {
        expect(lot.washSaleAdjustment, declared.lotId).toEqual(Money.zero(lot.currency));
      } else {
        expect(lot.basis, declared.why).toEqual(moneyOf(declared.expectedBasisAfterWashSale));
        expect(lot.holdingPeriodStartDate, declared.why).toBe(declared.holdingPeriodStartDate);
      }
    }
  });

  it('a lot transferred in with no basis reports its gain as unavailable, never as gain from zero', () => {
    const declared = dataset.lots.find((lot) => lot.expectedBasis === null);
    expect(declared).toBeDefined();
    if (declared === undefined) return;
    const lot = lotById.get(declared.lotId);
    expect(lot).toBeDefined();
    if (lot === undefined) return;

    const security = dataset.securities.find((row) => row.id === declared.securityId);
    const valuation = unrealizedGainOf(
      [lot],
      { amount: Quantity.of(security?.closeOnAsOf ?? '0'), currency: USD },
      { scale: SCALE },
    );

    expect(valuation.status).toBe('unavailable');
    if (valuation.status !== 'unavailable') return;
    expect(valuation.reason).toBe('basis_unknown');
    expect(valuation.lotIds).toContain(declared.lotId);
    // The *worth* is still reported. 5 × $64.20 = $321.00.
    expect(valuation.marketValue).toEqual(
      moneyOf(
        dataset.holdings.find((holding) => holding.securityId === declared.securityId)
          ?.expectedMarketValue ?? { minor: '0', currency: 'USD' },
      ),
    );
  });

  it('every declared market value is what the engine computes from quantity × close', () => {
    for (const holding of dataset.holdings) {
      const security = dataset.securities.find((row) => row.id === holding.securityId);
      expect(security, holding.symbol).toBeDefined();
      if (security === undefined) continue;
      const code = currency(holding.currency) satisfies CurrencyCode;
      const value = marketValueOf(
        Quantity.of(holding.quantity),
        { amount: Quantity.of(security.closeOnAsOf), currency: code },
        SCALE,
      );
      expect(value, `${holding.symbol}: ${holding.quantity} × ${security.closeOnAsOf}`).toEqual(
        moneyOf(holding.expectedMarketValue),
      );
    }
  });

  it('the FX series has exactly one gap, on the date the generator declares', () => {
    const forPair = dataset.fx.filter((point) => point.pair === dataset.fxGap.pair);
    const dates = new Set(forPair.map((point) => point.date));

    expect(dates.has(dataset.fxGap.date), dataset.fxGap.why).toBe(false);
    // One hole, not a truncated series: the month before and the month after
    // are both present, so "missing" cannot be confused with "not started yet".
    expect(forPair.length).toBe(dataset.prices.filter((p) => p.symbol === 'VTI').length - 1);
    expect(dates.has(DateOnly.of(2026, 2, 28))).toBe(true);
    expect(dates.has(DateOnly.of(2026, 4, 30))).toBe(true);
    // And no rate is ever 1.0-by-default for a genuine cross pair.
    expect(forPair.every((point) => point.rate !== '1.0000')).toBe(true);
  });

  it('the declared net worth is the sum of its declared parts', () => {
    const { netWorth } = dataset;
    const total = Money.subtract(
      Money.sum(
        [
          moneyOf(netWorth.investmentsInBase),
          moneyOf(netWorth.nonBaseInBase),
          moneyOf(netWorth.manualAssets),
        ],
        USD,
      ),
      moneyOf(netWorth.liabilities),
    );
    expect(total, netWorth.why).toEqual(moneyOf(netWorth.expectedTotal));

    // The investments leg is the sum of the USD holdings, to the cent.
    const usdHoldings = dataset.holdings.filter((holding) => holding.currency === 'USD');
    expect(
      Money.sum(
        usdHoldings.map((holding) => moneyOf(holding.expectedMarketValue)),
        USD,
      ),
    ).toEqual(moneyOf(netWorth.investmentsInBase));

    // And the dataset really does carry every account type the §5 criterion
    // names, including the two a brokerage export never contains.
    const kinds = new Set(dataset.accounts.map((account) => account.kind));
    expect(kinds).toContain('manual_asset');
    expect(kinds).toContain('liability');
    expect(dataset.accounts.some((account) => account.currency !== 'USD')).toBe(true);
  });

  it('is byte-identical for the same seed and different for another', () => {
    expect(JSON.stringify(generatePhase3Investments(SEED))).toBe(
      JSON.stringify(generatePhase3Investments(SEED)),
    );
    expect(JSON.stringify(generatePhase3Investments(SEED))).not.toBe(
      JSON.stringify(generatePhase3Investments(SEED + 1)),
    );
    // The *facts* do not move with the seed, only the ids: a declared basis
    // that depended on a random draw could not be checked by hand.
    const other = generatePhase3Investments(SEED + 1);
    expect(other.lots.map((lot) => lot.expectedBasis)).toEqual(
      dataset.lots.map((lot) => lot.expectedBasis),
    );
  });
});

// ---------------------------------------------------------------------------
// The committed spreadsheet check, reproduced through the seed's own shapes
// ---------------------------------------------------------------------------

/**
 * WP 3.3 authored the spreadsheet fixture (a portfolio CSV plus an expectations
 * CSV computed with Python `decimal`, not with the engine — provenance in
 * `docs/evidence/phase-3/wp3.3-analytics.md` §4). This block asserts that the
 * *seed's* vocabulary is rich enough to carry it: every fixture row is mapped
 * into `SeedSecurity` + `SeedPhase3Holding` + `SeedPricePoint` first, and only
 * then handed to the allocation engine. If a future seed change dropped
 * `expenseRatio`, `isCashEquivalent` or the ability to hold one security in two
 * accounts, this fails — which is the guarantee a perf fixture and a demo
 * database both depend on.
 */
function readFixture(name: string): readonly Record<string, string>[] {
  const path = fileURLToPath(
    new URL(`../../contexts/investments/test/fixtures/${name}`, import.meta.url),
  );
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

interface SeedShapedRow {
  readonly security: SeedSecurity;
  readonly holding: SeedPhase3Holding;
  readonly close: string;
  readonly stale: boolean;
  readonly expectedMarketValue: string;
  readonly costBasis: string;
}

function asSeedShapes(row: Record<string, string>): SeedShapedRow {
  const expenseRatio = row['expense_ratio'] ?? '';
  return {
    security: {
      id: row['security_id'] ?? '',
      symbol: row['symbol'] ?? '',
      name: row['symbol'] ?? '',
      type: row['is_cash_equivalent'] === 'true' ? 'cash' : 'etf',
      currency: 'USD',
      assetClass: row['asset_class'] ?? 'UNCLASSIFIED',
      region: row['region'] ?? 'UNKNOWN',
      sector: row['sector'] ?? 'UNKNOWN',
      expenseRatio: expenseRatio === '' ? null : expenseRatio,
      isCashEquivalent: row['is_cash_equivalent'] === 'true',
      chain: null,
      contract: null,
      identifiers: [{ kind: 'ticker', value: row['symbol'] ?? '' }],
      closeOnAsOf: row['price'] ?? '',
    },
    holding: {
      accountId: row['account_id'] ?? '',
      securityId: row['security_id'] ?? '',
      symbol: row['symbol'] ?? '',
      quantity: row['quantity'] ?? '0',
      asOf: dataset.asOf,
      currency: 'USD',
      expectedMarketValue: {
        minor: (row['expected_market_value'] ?? '0').replace('.', ''),
        currency: 'USD',
      },
    },
    close: row['price'] ?? '',
    stale: row['staleness'] === 'STALE',
    expectedMarketValue: row['expected_market_value'] ?? '',
    costBasis: row['cost_basis'] ?? '',
  };
}

function analyticsHoldingOf(row: SeedShapedRow, holdingId: string): AnalyticsHolding {
  const costBasis = row.costBasis;
  return {
    holdingId,
    accountId: row.holding.accountId,
    securityId: row.holding.securityId,
    symbol: row.holding.symbol,
    quantity: Quantity.of(row.holding.quantity),
    price: row.close === '' ? null : { amount: Quantity.of(row.close), currency: USD },
    staleness: row.stale ? 'STALE' : 'FRESH',
    assetClass: row.security.assetClass as AnalyticsHolding['assetClass'],
    region: row.security.region as AnalyticsHolding['region'],
    sector: row.security.sector,
    expenseRatio: row.security.expenseRatio,
    isCashEquivalent: row.security.isCashEquivalent,
    isInvestable: true,
    costBasis: costBasis === '' ? null : Money.parseAmount(costBasis, USD),
  };
}

describe('the committed spreadsheet check, carried through the seed vocabulary', () => {
  const rows = readFixture('allocation-portfolio.csv');
  const expected = readFixture('allocation-expected.csv');
  const holdings = rows.map((row) =>
    analyticsHoldingOf(asSeedShapes(row), row['holding_id'] ?? ''),
  );

  it('allocation matches the committed spreadsheet fixture, rebuilt from seed shapes', () => {
    expect(holdings.length).toBeGreaterThan(0);

    for (const basis of ['last_known', 'as_of_now'] as const) {
      const options: ValuationOptions = { currency: USD, scale: SCALE, basis };
      const set = valueHoldings(holdings, options);

      // Every row's value, to the cent, through the seed's own decimal strings.
      for (const entry of set.valued) {
        const source = rows.find((row) => row['holding_id'] === entry.holding.holdingId);
        expect(Money.formatAmount(entry.marketValue), entry.holding.holdingId).toBe(
          source?.['expected_market_value'],
        );
      }

      const total = expected.find(
        (row) => row['basis'] === basis && row['dimension'] === 'portfolio',
      );
      expect(Money.formatAmount(set.total), `${basis} total`).toBe(total?.['expected_value']);

      for (const dimension of ['asset_class', 'region', 'sector'] as const) {
        const report = allocationBy(dimension, holdings, options);
        const slices = expected.filter(
          (row) => row['basis'] === basis && row['dimension'] === dimension,
        );
        expect(slices.length, `${basis}/${dimension}`).toBeGreaterThan(0);
        for (const row of slices) {
          const slice = report.slices.find((candidate) => candidate.key === row['key']);
          expect(slice, `${basis}/${dimension}/${String(row['key'])}`).toBeDefined();
          expect(Money.formatAmount(slice?.value ?? Money.zero(USD))).toBe(row['expected_value']);
          expect(slice?.weight).toBe(row['expected_weight']);
        }
      }
    }
  });
});
