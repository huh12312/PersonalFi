// SPDX-License-Identifier: MIT
/**
 * The lot engine's proofs.
 *
 * Four of these are the dispatch's exit tests and two are properties, and the
 * split between them is deliberate. An example test says "these five lots and
 * this sale produce that answer", which is what a reader checks against a
 * 1099-B by hand. A property says "for *any* lots and *any* chain of sales,
 * nothing is created or lost", which is what catches the partial-disposal
 * rounding bug an example would have to be unlucky to hit.
 *
 * Everything here is pure: no clock, no database, no ids minted. The lot ids
 * are literals (`'lot-a'`) rather than `newId()` so that a failure message
 * names the lot a reader can find in the table above the test.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LotConstraintError, inMemoryLotStore } from './lots-store.ts';
import {
  DEFAULT_BASIS_METHOD,
  LONG_TERM_HOLDING_DAYS,
  LotError,
  carryLotsOnTransfer,
  matchDisposal,
  openLot,
  remainingBasisOf,
  termOf,
  type BasisMethod,
  type DisposalResult,
  type Lot,
} from './lots.ts';

const USD = currency('USD');
const ACCOUNT = 'acct-brokerage';
const SECURITY = 'sec-vti';

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

/** A `BROKER` lot with a known basis — the ordinary case, so tests can vary one thing. */
function lot(
  id: string,
  openDate: string,
  quantity: string,
  basisDollars: string | null,
  overrides: Partial<Parameters<typeof openLot>[0]> = {},
): Lot {
  return openLot({
    id,
    accountId: ACCOUNT,
    securityId: SECURITY,
    openDate: DateOnly.parse(openDate),
    quantity: Quantity.of(quantity),
    basis: basisDollars === null ? null : usd(basisDollars),
    currency: USD,
    basisSource: basisDollars === null ? 'ESTIMATED' : 'BROKER',
    acquisitionType: 'BUY',
    ...overrides,
  }).lot;
}

/** Which lots a disposal actually took from, and how much of each. */
function taken(result: DisposalResult): readonly (readonly [string, string])[] {
  return result.matches.map(
    (match) => [match.lotId, Quantity.toDatabaseString(match.quantity)] as const,
  );
}

// ---------------------------------------------------------------------------
// The five methods
// ---------------------------------------------------------------------------

describe('basis methods', () => {
  // Three lots, priced so that every method reaches for a different one. The
  // 15-share sale is the point: a 10-share sale would take exactly one lot and
  // FIFO and "the oldest lot" would be indistinguishable, so the second lot
  // each method falls through to is what actually pins the ordering down.
  //
  // | lot   | opened     | qty | basis  | per unit |
  // |-------|------------|-----|--------|----------|
  // | lot-a | 2024-01-10 |  10 | $1,000 |     $100 |
  // | lot-b | 2024-06-10 |  10 | $3,000 |     $300 |
  // | lot-c | 2025-02-10 |  10 | $2,000 |     $200 |
  const threeLots = (): readonly Lot[] => [
    lot('lot-a', '2024-01-10', '10', '1000.00'),
    lot('lot-b', '2024-06-10', '10', '3000.00'),
    lot('lot-c', '2025-02-10', '10', '2000.00'),
  ];

  const sellFifteen = (
    lots: readonly Lot[],
    method: BasisMethod,
    specificLotIds?: readonly string[],
  ): DisposalResult =>
    matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('15'),
      proceeds: usd('4500.00'),
      method,
      ...(specificLotIds === undefined ? {} : { specificLotIds }),
    });

  it('FIFO, LIFO, HIFO and specific-ID select different lots for the same sale and each is reproducible', () => {
    const fifo = sellFifteen(threeLots(), 'FIFO');
    const lifo = sellFifteen(threeLots(), 'LIFO');
    const hifo = sellFifteen(threeLots(), 'HIFO');
    const specific = sellFifteen(threeLots(), 'SPECIFIC_ID', ['lot-c', 'lot-a']);

    // Oldest first; newest first; dearest first; exactly what the user named.
    expect(taken(fifo)).toEqual([
      ['lot-a', '10.000000000000000000'],
      ['lot-b', '5.000000000000000000'],
    ]);
    expect(taken(lifo)).toEqual([
      ['lot-c', '10.000000000000000000'],
      ['lot-b', '5.000000000000000000'],
    ]);
    expect(taken(hifo)).toEqual([
      ['lot-b', '10.000000000000000000'],
      ['lot-c', '5.000000000000000000'],
    ]);
    expect(taken(specific)).toEqual([
      ['lot-c', '10.000000000000000000'],
      ['lot-a', '5.000000000000000000'],
    ]);

    // Four distinct answers, not two that happen to coincide.
    const selections = [fifo, lifo, hifo, specific].map((result) => JSON.stringify(taken(result)));
    expect(new Set(selections).size).toBe(4);

    // Reproducible: the same history, run again, selects the same lots in the
    // same order. A tax figure that moved between two runs of the same data
    // would be worse than one that was merely wrong.
    for (const [method, first] of [
      ['FIFO', fifo],
      ['LIFO', lifo],
      ['HIFO', hifo],
    ] as const) {
      expect(taken(sellFifteen(threeLots(), method)), method).toEqual(taken(first));
    }
    expect(taken(sellFifteen(threeLots(), 'SPECIFIC_ID', ['lot-c', 'lot-a']))).toEqual(
      taken(specific),
    );
  });

  it('two lots opened on the same day break the tie by id, in both directions', () => {
    // Without a tie-break the sort is whatever the input order was, and the
    // input order is whatever the database returned — so the same sale would
    // select a different lot after a VACUUM. `id` makes it total.
    const sameDay = [
      lot('lot-z', '2024-03-01', '5', '500.00'),
      lot('lot-a', '2024-03-01', '5', '500.00'),
    ];
    const fifo = matchDisposal(sameDay, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('5'),
      proceeds: usd('600.00'),
      method: 'FIFO',
    });
    const lifo = matchDisposal(sameDay, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('5'),
      proceeds: usd('600.00'),
      method: 'LIFO',
    });
    expect(fifo.matches[0]?.lotId).toBe('lot-a');
    expect(lifo.matches[0]?.lotId).toBe('lot-z');
  });

  it('FIFO is the default, because it is the IRS default when nothing is elected', () => {
    expect(DEFAULT_BASIS_METHOD).toBe('FIFO');
    const withoutMethod = matchDisposal(threeLots(), {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('15'),
      proceeds: usd('4500.00'),
    });
    expect(taken(withoutMethod)).toEqual(taken(sellFifteen(threeLots(), 'FIFO')));
  });

  it('a lot in another account is never eligible, however well it would have sorted', () => {
    // Rev. Proc. 2024-28: basis is per wallet. An older, cheaper lot in the
    // other account is exactly what a naive FIFO would grab.
    const lots = [
      { ...lot('lot-other', '2020-01-01', '10', '100.00'), accountId: 'acct-coinbase' },
      lot('lot-here', '2025-01-01', '10', '5000.00'),
    ];
    const result = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('4'),
      proceeds: usd('2400.00'),
      method: 'FIFO',
    });
    expect(result.matches.map((match) => match.lotId)).toEqual(['lot-here']);
  });
});

// ---------------------------------------------------------------------------
// The holding-period boundary
// ---------------------------------------------------------------------------

describe('the short-term / long-term boundary', () => {
  it('a lot held exactly 365 days is short-term and one held 366 days is long-term', () => {
    // IRC §1222: long-term is held *more than* one year. The whole rule is one
    // `>`, and turning it into a `>=` moves a gain from a 37% bracket to a 15%
    // one with nothing in the output looking different — which is why this is
    // the sabotage recorded in the evidence note.
    const opened = DateOnly.parse('2025-01-02');
    expect(LONG_TERM_HOLDING_DAYS).toBe(365);

    const exactlyAYear = DateOnly.addDays(opened, 365);
    const aDayLater = DateOnly.addDays(opened, 366);
    expect(DateOnly.differenceInDays(opened, exactlyAYear)).toBe(365);

    expect(termOf(opened, exactlyAYear)).toBe('SHORT_TERM');
    expect(termOf(opened, aDayLater)).toBe('LONG_TERM');
  });

  it('the boundary is read off holdingPeriodStartDate, not openDate', () => {
    // A wash sale tacks the prior holding period on by moving
    // `holdingPeriodStartDate` earlier than `openDate`. Software that measured
    // from `openDate` would report a long-term gain as short-term for up to a
    // year — the more expensive of the two errors, and the invisible one.
    const tacked = lot('lot-tacked', '2025-06-01', '10', '1000.00', {
      holdingPeriodStartDate: DateOnly.parse('2024-01-01'),
    });
    const sale = matchDisposal([tacked], {
      accountId: ACCOUNT,
      securityId: SECURITY,
      // Only 122 days after the lot opened, but 608 after the period started.
      date: DateOnly.parse('2025-10-01'),
      quantity: Quantity.of('10'),
      proceeds: usd('1200.00'),
    });
    expect(sale.matches[0]?.term).toBe('LONG_TERM');
    expect(sale.realized.longTerm).toEqual({ status: 'available', amount: usd('200.00') });
    expect(sale.realized.shortTerm).toEqual({ status: 'available', amount: usd('0.00') });
  });

  it('a sale splits into a short-term and a long-term figure, and fees come off the gain', () => {
    const lots = [
      lot('lot-old', '2023-01-01', '10', '1000.00'),
      lot('lot-new', '2025-05-01', '10', '2000.00'),
    ];
    const sale = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('20'),
      proceeds: usd('4000.00'),
      fees: usd('10.00'),
      method: 'FIFO',
    });
    // $2,000 proceeds per lot by quantity; $5 of fee each.
    expect(sale.realized.longTerm).toEqual({ status: 'available', amount: usd('995.00') });
    expect(sale.realized.shortTerm).toEqual({ status: 'available', amount: usd('-5.00') });
  });
});

// ---------------------------------------------------------------------------
// Self-transfers
// ---------------------------------------------------------------------------

describe('self-transfers between wallets', () => {
  it('a self-transfer between wallets carries its lots and realizes nothing', () => {
    // 07 §6.2: "the single most common source of wrong crypto tax numbers".
    // Moving BTC from Coinbase to a cold wallet is not a disposal; treating it
    // as one invents a gain and restarts the holding period, which is the
    // wrong answer twice.
    const source = openLot({
      id: 'lot-btc',
      accountId: 'wallet-coinbase',
      securityId: 'sec-btc',
      openDate: DateOnly.parse('2023-03-01'),
      quantity: Quantity.of('0.5'),
      basis: usd('12000.00'),
      currency: USD,
      basisSource: 'BROKER',
      acquisitionType: 'BUY',
    }).lot;

    const { lots, carried } = carryLotsOnTransfer([source], {
      fromAccountId: 'wallet-coinbase',
      toAccountId: 'wallet-ledger',
      securityId: 'sec-btc',
      newLotId: (from) => `${from.id}-moved`,
    });

    expect(carried).toHaveLength(1);
    const moved = carried[0];
    expect(moved?.accountId).toBe('wallet-ledger');
    // Basis, acquisition date and holding period all survive the move.
    expect(moved?.basis).toEqual(usd('12000.00'));
    expect(moved?.openDate).toBe(source.openDate);
    expect(moved?.holdingPeriodStartDate).toBe(source.holdingPeriodStartDate);
    expect(moved?.basisSource).toBe('BROKER');
    expect(Quantity.toDatabaseString(moved?.quantityRemaining ?? Quantity.zero)).toBe(
      '0.500000000000000000',
    );

    // Nothing is realised: there is no `RealizedGain` in this API at all, and
    // the source lot is emptied rather than disposed of.
    const drained = lots.find((entry) => entry.id === 'lot-btc');
    expect(Quantity.isZero(drained?.quantityRemaining ?? Quantity.of('1'))).toBe(true);

    // And the total basis across both accounts is unchanged — a transfer that
    // duplicated basis would halve every future gain.
    const totalBasis = lots
      .filter((entry) => Quantity.compare(entry.quantityRemaining, Quantity.zero) > 0)
      .reduce(
        (sum, entry) => Money.add(sum, remainingBasisOf(entry) ?? Money.zero(USD)),
        Money.zero(USD),
      );
    expect(totalBasis).toEqual(usd('12000.00'));

    // The moved lot is long-term on a date the *destination* lot has only
    // existed for a week — which is the whole point of carrying the period.
    expect(
      termOf(
        moved?.holdingPeriodStartDate ?? DateOnly.parse('2099-01-01'),
        DateOnly.parse('2025-06-01'),
      ),
    ).toBe('LONG_TERM');
  });

  it('a partially sold lot carries only what is left', () => {
    const source = openLot({
      id: 'lot-eth',
      accountId: 'wallet-coinbase',
      securityId: 'sec-eth',
      openDate: DateOnly.parse('2024-01-01'),
      quantity: Quantity.of('10'),
      basis: usd('20000.00'),
      currency: USD,
      basisSource: 'BROKER',
      acquisitionType: 'BUY',
    }).lot;
    const afterSale = matchDisposal([source], {
      accountId: 'wallet-coinbase',
      securityId: 'sec-eth',
      date: DateOnly.parse('2024-06-01'),
      quantity: Quantity.of('4'),
      proceeds: usd('10000.00'),
    });

    const { carried } = carryLotsOnTransfer(afterSale.lots, {
      fromAccountId: 'wallet-coinbase',
      toAccountId: 'wallet-ledger',
      securityId: 'sec-eth',
      newLotId: () => 'lot-eth-moved',
    });
    // 6 ETH and the $12,000 of basis still attached to them; the $8,000 that
    // was already consumed stays consumed in the source account's history.
    expect(Quantity.toDatabaseString(carried[0]?.quantity ?? Quantity.zero)).toBe(
      '6.000000000000000000',
    );
    expect(carried[0]?.basis).toEqual(usd('12000.00'));
  });
});

// ---------------------------------------------------------------------------
// AVERAGE_COST
// ---------------------------------------------------------------------------

describe('AVERAGE_COST', () => {
  it('AVERAGE_COST once elected cannot be switched for that security', async () => {
    // 07 §4.4: "once elected, it's sticky per security per account". The
    // in-memory store enforces the same rule the
    // `basis_method_elections_average_cost_is_sticky` trigger does, and
    // `test/db/lots.test.ts` proves Postgres agrees.
    const store = inMemoryLotStore();
    const election = {
      id: 'election-1',
      userId: 'user-1',
      accountId: ACCOUNT,
      securityId: 'sec-vtsax',
      electedOn: DateOnly.parse('2025-01-01'),
    };

    await store.electBasisMethod({ ...election, method: 'AVERAGE_COST' });
    expect(await store.basisMethodFor('user-1', ACCOUNT, 'sec-vtsax')).toBe('AVERAGE_COST');

    await expect(store.electBasisMethod({ ...election, method: 'FIFO' })).rejects.toThrowError(
      LotConstraintError,
    );
    await expect(store.electBasisMethod({ ...election, method: 'HIFO' })).rejects.toMatchObject({
      constraint: 'basis_method_elections_average_cost_is_sticky',
    });

    // Still AVERAGE_COST after both attempts, and the refusal is scoped: the
    // same account may elect anything it likes for a *different* security.
    expect(await store.basisMethodFor('user-1', ACCOUNT, 'sec-vtsax')).toBe('AVERAGE_COST');
    await store.electBasisMethod({
      ...election,
      id: 'election-2',
      securityId: 'sec-vti',
      method: 'HIFO',
    });
    expect(await store.basisMethodFor('user-1', ACCOUNT, 'sec-vti')).toBe('HIFO');
    // And re-electing AVERAGE_COST is not a switch away from it.
    await store.electBasisMethod({ ...election, method: 'AVERAGE_COST' });
    expect(await store.basisMethodFor('user-1', ACCOUNT, 'sec-vtsax')).toBe('AVERAGE_COST');
  });

  it('pools the basis across every open lot before any of it is consumed', () => {
    // 10 shares at $100 and 10 at $300 pool to $200/share, so selling 5 takes
    // $1,000 of basis — not the $500 FIFO would take from the cheap lot.
    const lots = [
      lot('lot-a', '2024-01-10', '10', '1000.00'),
      lot('lot-b', '2024-06-10', '10', '3000.00'),
    ];
    const sale = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('5'),
      proceeds: usd('1500.00'),
      method: 'AVERAGE_COST',
    });
    expect(sale.matches[0]?.basis).toEqual(usd('1000.00'));
    expect(sale.realized.longTerm).toEqual({ status: 'available', amount: usd('500.00') });
  });

  it('a pool with one unknown-basis lot in it is unavailable, not the known part relabelled', () => {
    const lots = [
      lot('lot-known', '2024-01-10', '10', '1000.00'),
      lot('lot-unknown', '2024-06-10', '10', null),
    ];
    const sale = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('5'),
      proceeds: usd('1500.00'),
      method: 'AVERAGE_COST',
    });
    expect(sale.matches[0]?.basis).toBeNull();
    expect(sale.realized.longTerm.status).toBe('unavailable');
    expect(sale.warnings.map((warning) => warning.code)).toContain('average_cost_pool_incomplete');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('a lot with no basis must declare ESTIMATED rather than claim a source that knows', () => {
    expect(() =>
      openLot({
        id: 'lot-x',
        accountId: ACCOUNT,
        securityId: SECURITY,
        openDate: DateOnly.parse('2025-01-01'),
        quantity: Quantity.of('1'),
        basis: null,
        currency: USD,
        // A broker that reported nothing did not report zero.
        basisSource: 'BROKER',
        acquisitionType: 'BUY',
      }),
    ).toThrowError(LotError);
  });

  it('a negative basis and a zero quantity are both refused', () => {
    expect(() => lot('lot-neg', '2025-01-01', '1', '-100.00')).toThrowError(/never negative/);
    expect(() => lot('lot-zero', '2025-01-01', '0', '100.00')).toThrowError(/positive quantity/);
  });

  it('short quantity is a warning and a reported remainder, not a throw', () => {
    // The R6 verdict guarantees this on every Coinbase wallet: v3 reports the
    // sale, the CSV export has the deposit that created the position, and a
    // user who has not uploaded one yet still deserves the half we can
    // attribute.
    const sale = matchDisposal([lot('lot-a', '2025-01-01', '1', '100.00')], {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-06-01'),
      quantity: Quantity.of('3'),
      proceeds: usd('600.00'),
    });
    expect(Quantity.toDatabaseString(sale.unmatchedQuantity)).toBe('2.000000000000000000');
    expect(sale.warnings.map((warning) => warning.code)).toContain('short_quantity');
    // And an unmatched remainder poisons *both* terms: nothing is known about
    // when the missing lot was opened.
    expect(sale.realized.shortTerm.status).toBe('unavailable');
    expect(sale.realized.longTerm.status).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Arbitrary lots and an arbitrary chain of sales against them.
 *
 * Quantities are whole numbers of hundredths and basis is whole cents, which
 * keeps the *generator* honest — a float-derived arbitrary would be testing
 * whether `fast-check` can make a decimal string, not whether the engine
 * conserves one.
 */
// `lot()` above takes plain strings; this one feeds kernel values in directly,
// which is what the generators produce.
function lotOf(
  id: string,
  openDate: ReturnType<typeof DateOnly.parse>,
  quantity: ReturnType<typeof Quantity.of>,
  basisCents: string | null,
): Lot {
  return openLot({
    id,
    accountId: ACCOUNT,
    securityId: SECURITY,
    openDate,
    quantity,
    basis: basisCents === null ? null : Money.of(BigInt(basisCents), USD),
    currency: USD,
    basisSource: basisCents === null ? 'ESTIMATED' : 'BROKER',
    acquisitionType: 'BUY',
  }).lot;
}

const arbPortfolio = fc
  .array(
    fc.record({
      days: fc.integer({ min: 0, max: 2_000 }),
      hundredths: fc.integer({ min: 1, max: 100_000 }),
      cents: fc.integer({ min: 0, max: 10_000_000 }),
      known: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((rows) =>
    rows.map((row, index) =>
      lotOf(
        `lot-${String(index).padStart(2, '0')}`,
        DateOnly.addDays(DateOnly.parse('2020-01-01'), row.days),
        Quantity.divide(Quantity.of(String(row.hundredths)), '100'),
        row.known ? String(row.cents) : null,
      ),
    ),
  );

const arbMethod: fc.Arbitrary<BasisMethod> = fc.constantFrom('FIFO', 'LIFO', 'HIFO');

const arbSales = fc.array(fc.integer({ min: 1, max: 30_000 }), { minLength: 1, maxLength: 6 });

const totalRemaining = (lots: readonly Lot[]): ReturnType<typeof Quantity.of> =>
  lots.reduce((sum, entry) => Quantity.add(sum, entry.quantityRemaining), Quantity.zero);

/** Run a chain of sales and return the final lots plus what was matched. */
function runSales(
  lots: readonly Lot[],
  sales: readonly number[],
  method: BasisMethod,
): { readonly lots: readonly Lot[]; readonly results: readonly DisposalResult[] } {
  let current = lots;
  const results: DisposalResult[] = [];
  sales.forEach((hundredths, index) => {
    const result = matchDisposal(current, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.addDays(DateOnly.parse('2026-01-01'), index),
      quantity: Quantity.divide(Quantity.of(String(hundredths)), '100'),
      proceeds: Money.of(BigInt(hundredths) * 7n, USD),
      method,
    });
    results.push(result);
    current = result.lots;
  });
  return { lots: current, results };
}

describe('properties', () => {
  it('quantity_remaining is never negative', () => {
    // The `NUMERIC(38,18) CHECK (quantity_remaining >= 0)` in 0014, asserted
    // against arbitrary input rather than against the four sales somebody
    // thought of. An over-sale must come out as `unmatchedQuantity`, never as
    // a lot driven below zero.
    fc.assert(
      fc.property(arbPortfolio, arbSales, arbMethod, (lots, sales, method) => {
        const { lots: after } = runSales(lots, sales, method);
        for (const entry of after) {
          expect(Quantity.isNegative(entry.quantityRemaining)).toBe(false);
          expect(Quantity.compare(entry.quantityRemaining, entry.quantity)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('quantity is conserved: what was matched plus what remains equals what was opened', () => {
    fc.assert(
      fc.property(arbPortfolio, arbSales, arbMethod, (lots, sales, method) => {
        const opened = lots.reduce(
          (sum, entry) => Quantity.add(sum, entry.quantity),
          Quantity.zero,
        );
        const { lots: after, results } = runSales(lots, sales, method);
        const matched = results
          .flatMap((result) => result.matches)
          .reduce((sum, match) => Quantity.add(sum, match.quantity), Quantity.zero);
        expect(Quantity.toDatabaseString(Quantity.add(matched, totalRemaining(after)))).toBe(
          Quantity.toDatabaseString(opened),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('basis is conserved across a chain of partial disposals', () => {
    // The one a naive "recompute per-unit basis and multiply" implementation
    // fails: it loses a cent per disposal, silently, and the loss only shows
    // up as a portfolio that will not reconcile to a statement.
    fc.assert(
      fc.property(arbPortfolio, arbSales, arbMethod, (lots, sales, method) => {
        const known = lots.filter((entry) => entry.basis !== null);
        fc.pre(known.length === lots.length);
        const openedBasis = Money.sum(
          lots.map((entry) => entry.basis as ReturnType<typeof Money.of>),
          USD,
        );
        const { lots: after, results } = runSales(lots, sales, method);
        const matchedBasis = Money.sum(
          results
            .flatMap((result) => result.matches)
            .map((match) => match.basis as ReturnType<typeof Money.of>),
          USD,
        );
        const remaining = Money.sum(
          after.map((entry) => remainingBasisOf(entry) as ReturnType<typeof Money.of>),
          USD,
        );
        expect(Money.add(matchedBasis, remaining)).toEqual(openedBasis);
      }),
      { numRuns: 300 },
    );
  });

  it('a basis is never negative, on a lot or on a match', () => {
    fc.assert(
      fc.property(arbPortfolio, arbSales, arbMethod, (lots, sales, method) => {
        const { lots: after, results } = runSales(lots, sales, method);
        for (const entry of after) {
          if (entry.basis !== null) expect(Money.isNegative(entry.basis)).toBe(false);
          const remaining = remainingBasisOf(entry);
          if (remaining !== null) expect(Money.isNegative(remaining)).toBe(false);
        }
        for (const match of results.flatMap((result) => result.matches)) {
          if (match.basis !== null) expect(Money.isNegative(match.basis)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('FIFO and LIFO pick different lots but agree on total proceeds and total quantity', () => {
    // The methods reorder *when* basis is recognised; they cannot change how
    // much was sold or what it sold for. A method that disagreed about the
    // totals would be moving money, not deferring it.
    fc.assert(
      fc.property(arbPortfolio, arbSales, (lots, sales) => {
        const fifo = runSales(lots, sales, 'FIFO');
        const lifo = runSales(lots, sales, 'LIFO');

        const quantityOf = (run: typeof fifo): string =>
          Quantity.toDatabaseString(
            run.results
              .flatMap((result) => result.matches)
              .reduce((sum, match) => Quantity.add(sum, match.quantity), Quantity.zero),
          );
        const proceedsOf = (run: typeof fifo): bigint =>
          run.results
            .flatMap((result) => result.matches)
            .reduce((sum, match) => sum + match.proceeds.minor, 0n);

        expect(quantityOf(fifo)).toBe(quantityOf(lifo));
        expect(proceedsOf(fifo)).toBe(proceedsOf(lifo));
        expect(Quantity.toDatabaseString(totalRemaining(fifo.lots))).toBe(
          Quantity.toDatabaseString(totalRemaining(lifo.lots)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('an unknown basis never becomes a number, however long the chain of sales', () => {
    fc.assert(
      fc.property(arbPortfolio, arbSales, arbMethod, (lots, sales, method) => {
        fc.pre(lots.some((entry) => entry.basis === null));
        const { lots: after, results } = runSales(lots, sales, method);
        // A lot that started unknown stays unknown, and every match against it
        // reports `null` rather than a gain from zero.
        const unknownIds = new Set(
          lots.filter((entry) => entry.basis === null).map((entry) => entry.id),
        );
        for (const entry of after) {
          if (unknownIds.has(entry.id)) expect(entry.basis).toBeNull();
        }
        for (const match of results.flatMap((result) => result.matches)) {
          if (unknownIds.has(match.lotId)) {
            expect(match.basis).toBeNull();
            expect(match.gain).toBeNull();
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
