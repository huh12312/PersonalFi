// SPDX-License-Identifier: MIT
/**
 * WP 10.3: which movements are external flows, asserted three ways.
 *
 *   1. **A table over Plaid's documented `type/subtype` pairs**, run through
 *      the real house normaliser (`normaliseTransactionType`) and then the
 *      classifier — the path a stored row takes.
 *   2. **The recorded Sandbox fixture** (`packages/connectors/plaid/test/
 *      fixtures/investments.json`: a buy, a sell, a dividend, a contribution
 *      and an account fee). Read as JSON — this context does not depend on
 *      `@connector/plaid` — with the one transformation the connector applies
 *      to an amount, `signedAmountOf`'s negation (Plaid: positive = cash
 *      debited; house: negative = money left), stated here rather than
 *      hidden. The same fixture goes through the real connector, the real
 *      orchestrator and the real route in
 *      `apps/api/test/db/investments-activity-routes.test.ts`.
 *   3. **Two properties** over generated portfolios: a single contribution
 *      and nothing else is a 0% TWR and a 0% MWR; a dividend with no price
 *      change raises both and is not a contribution.
 */
import { readFileSync } from 'node:fs';
import { DateOnly, Money, Quantity, currency, type DateOnly as DateOnlyType } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normaliseTransactionType } from '../holdings.ts';
import {
  classifyActivity,
  externalFlowsOf,
  summariseActivity,
  type ActivityInput,
  type SummaryMovement,
} from './flows.ts';
import { moneyWeightedReturn } from './mwr.ts';
import { timeWeightedReturn, type DatedValuation } from './twr.ts';

const USD = currency('USD');

/**
 * Plaid's amount → the house amount: `signedAmountOf` is
 * `Money.negate(moneyOf(...))`. Decimal strings throughout (08 §6.5); the
 * fixture's JSON numbers are stringified once, on the way in.
 */
function houseAmount(plaidAmount: string) {
  return Money.negate(Money.parseAmount(plaidAmount, USD));
}

function inputOf(
  plaidType: string,
  plaidSubtype: string,
  plaidAmount: string,
  extra: { quantity?: string; securityId?: string | null; fees?: string } = {},
): ActivityInput {
  return {
    type: normaliseTransactionType(plaidType, plaidSubtype),
    subtype: plaidSubtype,
    amount: houseAmount(plaidAmount),
    fees: Money.parseAmount(extra.fees ?? '0', USD),
    quantity: Quantity.of(extra.quantity ?? '0'),
    securityId: extra.securityId === undefined ? null : extra.securityId,
  };
}

describe('classifyActivity — Plaid type/subtype pairs through the house normaliser', () => {
  // [type, subtype, plaid amount, extra, expected kind, expected role, expected flow minor | null]
  const cases: readonly [
    string,
    string,
    string,
    { quantity?: string; securityId?: string | null },
    string,
    string,
    bigint | null,
  ][] = [
    ['buy', 'buy', '1342', { quantity: '5', securityId: 's' }, 'buy', 'trade', null],
    // A 401(k) payroll contribution arrives as a buy, not as cash.
    [
      'buy',
      'contribution',
      '500',
      { quantity: '2', securityId: 's' },
      'contribution',
      'external',
      50_000n,
    ],
    [
      'buy',
      'dividend reinvestment',
      '12.5',
      { quantity: '0.05', securityId: 's' },
      'reinvested_dividend',
      'income',
      null,
    ],
    [
      'buy',
      'interest reinvestment',
      '3',
      { quantity: '0.01', securityId: 's' },
      'reinvested_dividend',
      'income',
      null,
    ],
    [
      'buy',
      'long-term capital gain reinvestment',
      '7',
      { quantity: '0.03', securityId: 's' },
      'reinvested_dividend',
      'income',
      null,
    ],
    ['sell', 'sell', '-536.8', { quantity: '-2', securityId: 's' }, 'sell', 'trade', null],
    // A distribution out of an IRA arrives as a sell.
    [
      'sell',
      'distribution',
      '-300',
      { quantity: '-1', securityId: 's' },
      'withdrawal',
      'external',
      -30_000n,
    ],
    ['cash', 'contribution', '-1000', {}, 'contribution', 'external', 100_000n],
    ['cash', 'deposit', '-200', {}, 'contribution', 'external', 20_000n],
    ['cash', 'withdrawal', '150', {}, 'withdrawal', 'external', -15_000n],
    ['cash', 'distribution', '400', {}, 'withdrawal', 'external', -40_000n],
    ['cash', 'loan payment', '-50', {}, 'contribution', 'external', 5_000n],
    ['cash', 'dividend', '-41.18', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'qualified dividend', '-10', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'non-qualified dividend', '-10', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'long-term capital gain', '-12', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'short-term capital gain', '-2', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'unqualified gain', '-1', { securityId: 's' }, 'dividend', 'income', null],
    ['cash', 'interest', '-4', {}, 'interest', 'income', null],
    ['cash', 'interest receivable', '-4', {}, 'interest', 'income', null],
    ['cash', 'tax', '5', {}, 'tax', 'cost', null],
    ['cash', 'tax withheld', '5', {}, 'tax', 'cost', null],
    ['cash', 'non-resident tax', '1', {}, 'tax', 'cost', null],
    ['cash', 'margin expense', '3', {}, 'fee', 'cost', null],
    ['cash', 'management fee', '9', {}, 'fee', 'cost', null],
    [
      'cash',
      'stock distribution',
      '0',
      { quantity: '3', securityId: 's' },
      'other',
      'internal',
      null,
    ],
    // Neither side of the boundary is knowable from the word: excluded and named.
    ['cash', 'pending credit', '-10', {}, 'other', 'unclassified', null],
    ['fee', 'account fee', '20', {}, 'fee', 'cost', null],
    ['fee', 'management fee', '15', {}, 'fee', 'cost', null],
    ['fee', 'transfer fee', '25', {}, 'fee', 'cost', null],
    ['fee', 'legal fee', '1', {}, 'fee', 'cost', null],
    // In kind: no cash amount, so the flow is valued by the caller.
    [
      'transfer',
      'transfer',
      '0',
      { quantity: '10', securityId: 's' },
      'contribution',
      'external',
      null,
    ],
    [
      'transfer',
      'transfer',
      '0',
      { quantity: '-10', securityId: 's' },
      'withdrawal',
      'external',
      null,
    ],
    ['transfer', 'send', '0', { quantity: '-1', securityId: 's' }, 'withdrawal', 'external', null],
    ['transfer', 'merger', '0', { quantity: '4', securityId: 's' }, 'other', 'internal', null],
    ['transfer', 'spin off', '0', { quantity: '4', securityId: 's' }, 'other', 'internal', null],
    ['transfer', 'split', '0', { quantity: '4', securityId: 's' }, 'split', 'trade', null],
    ['transfer', 'exercise', '0', { quantity: '1', securityId: 's' }, 'other', 'internal', null],
    ['transfer', 'expire', '0', { quantity: '-1', securityId: 's' }, 'other', 'internal', null],
    ['transfer', 'assignment', '0', { quantity: '-1', securityId: 's' }, 'other', 'internal', null],
  ];

  it.each(cases)('%s/%s is %s (%s)', (type, subtype, amount, extra, kind, role, flowMinor) => {
    const classified = classifyActivity(inputOf(type, subtype, amount, extra));
    expect({ kind: classified.kind, role: classified.role }).toEqual({ kind, role });
    expect(classified.flow === null ? null : classified.flow.minor).toBe(flowMinor);
  });

  it('no dividend, interest, fee, tax or trade is ever an external flow', () => {
    for (const [type, subtype, amount, extra] of cases) {
      const classified = classifyActivity(inputOf(type, subtype, amount, extra));
      if (
        [
          'dividend',
          'reinvested_dividend',
          'interest',
          'fee',
          'tax',
          'buy',
          'sell',
          'split',
        ].includes(classified.kind)
      ) {
        expect(classified.role, `${type}/${subtype}`).not.toBe('external');
      }
    }
  });

  it('an in-kind transfer carries what to price, and one with nothing to price carries nothing', () => {
    const priced = classifyActivity(
      inputOf('transfer', 'transfer', '0', { quantity: '-10', securityId: 'vti' }),
    );
    expect(priced.inKind).toEqual({ securityId: 'vti', quantity: '10', direction: 'out' });
    const bare = classifyActivity(inputOf('cash', 'deposit', '0'));
    expect(bare.role).toBe('external');
    expect(bare.inKind).toBeNull();
  });
});

describe('normaliseTransactionType — the stored type is truthful for new rows (WP 10.3)', () => {
  it('stores a fund distribution as DIVIDEND and a margin expense as FEE, not as CASH', () => {
    expect(normaliseTransactionType('cash', 'long-term capital gain')).toBe('DIVIDEND');
    expect(normaliseTransactionType('cash', 'short-term capital gain')).toBe('DIVIDEND');
    expect(normaliseTransactionType('cash', 'unqualified gain')).toBe('DIVIDEND');
    expect(normaliseTransactionType('cash', 'margin expense')).toBe('FEE');
    // Unchanged: the lot engine still sees a contribution-buy as a buy (it opens a lot).
    expect(normaliseTransactionType('buy', 'contribution')).toBe('BUY');
    expect(normaliseTransactionType('buy', 'long-term capital gain reinvestment')).toBe(
      'REINVESTED_DIVIDEND',
    );
    expect(normaliseTransactionType('cash', 'contribution')).toBe('CASH');
  });
});

interface PlaidFixtureTransaction {
  readonly investment_transaction_id: string;
  readonly date: string;
  readonly type: string;
  readonly subtype: string;
  /** JSON numbers, as Plaid sends them; stringified before they become money. */
  readonly amount: unknown;
  readonly quantity: unknown;
  readonly fees: unknown;
  readonly security_id: string | null;
}

describe('the recorded Plaid Sandbox fixture', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../connectors/plaid/test/fixtures/investments.json', import.meta.url),
      'utf8',
    ),
  ) as { investment_transactions: PlaidFixtureTransaction[] };

  const movements: SummaryMovement[] = fixture.investment_transactions.map((row) => {
    const input = inputOf(row.type, row.subtype, String(row.amount), {
      quantity: String(row.quantity),
      securityId: row.security_id,
      fees: row.fees === null ? '0' : String(row.fees),
    });
    return {
      id: row.investment_transaction_id,
      date: DateOnly.parse(row.date),
      input,
      classified: classifyActivity(input),
    };
  });
  const byId = new Map(movements.map((movement) => [movement.id, movement]));

  it('the dividend and the account fee are not flows; the contribution is +$1,000.00', () => {
    expect(byId.get('ivt-0003-dividend')?.classified).toMatchObject({
      kind: 'dividend',
      role: 'income',
    });
    expect(byId.get('ivt-0005-account-fee')?.classified).toMatchObject({
      kind: 'fee',
      role: 'cost',
    });
    expect(byId.get('ivt-0001-buy-vti')?.classified.role).toBe('trade');
    expect(byId.get('ivt-0002-sell-vti')?.classified.role).toBe('trade');

    const { flows, unvalued } = externalFlowsOf(movements, USD);
    expect(unvalued).toEqual([]);
    expect(flows).toEqual([{ date: '2026-05-31', amount: Money.of(100_000n, USD) }]);
  });

  it('the period summary names the dividend, the fee and the sell commission, apart from the contribution', () => {
    const totals = summariseActivity(movements, USD);
    expect(totals.netContributions).toEqual(Money.of(100_000n, USD));
    expect(totals.dividendsAndInterest).toEqual(Money.of(4_118n, USD));
    // The $20.00 account fee plus the $0.65 commission on the sell.
    expect(totals.feesPaid).toEqual(Money.of(2_065n, USD));
    expect(totals.reinvestedDividends).toEqual(Money.zero(USD));
    expect(totals.unclassified).toEqual([]);
    expect(totals.foreignCurrency).toEqual([]);
  });
});

describe('properties: what a flow does to TWR and MWR', () => {
  const START = DateOnly.of(2025, 1, 1);

  /** A plain cash movement, classified through the same function the route uses. */
  function movement(
    id: string,
    date: DateOnlyType,
    plaidSubtype: string,
    plaidAmountMinor: bigint,
  ): SummaryMovement {
    const input: ActivityInput = {
      type: normaliseTransactionType('cash', plaidSubtype),
      subtype: plaidSubtype,
      amount: Money.of(-plaidAmountMinor, USD),
      fees: Money.zero(USD),
      quantity: Quantity.of('0'),
      securityId: plaidSubtype === 'dividend' ? 'vti' : null,
    };
    return { id, date, input, classified: classifyActivity(input) };
  }

  const scenario = fc.record({
    openingCents: fc.integer({ min: 100, max: 1_000_000_000 }),
    amountCents: fc.integer({ min: 1, max: 1_000_000_000 }),
    flowDay: fc.integer({ min: 1, max: 300 }),
    spanDays: fc.integer({ min: 302, max: 800 }),
  });

  /**
   * A dividend yield up to 20% over the period. Bounded because XIRR's bracket
   * is `(-99.99%, 10,000%)` a year (`xirr.ts`), and a "dividend" a hundred
   * times the portfolio is a solver range question, not a flow question.
   */
  const dividendScenario = fc.record({
    openingCents: fc.integer({ min: 10_000, max: 1_000_000_000 }),
    yieldBasisPoints: fc.integer({ min: 1, max: 2_000 }),
    flowDay: fc.integer({ min: 1, max: 300 }),
    spanDays: fc.integer({ min: 302, max: 800 }),
  });

  it('a portfolio with a single contribution and nothing else has TWR 0 and MWR 0', () => {
    fc.assert(
      fc.property(scenario, ({ openingCents, amountCents, flowDay, spanDays }) => {
        const flowDate = DateOnly.addDays(START, flowDay);
        const end = DateOnly.addDays(START, spanDays);
        // Plaid reports a contribution as a negative amount (cash credited).
        const movements = [movement('c', flowDate, 'contribution', -BigInt(amountCents))];
        const { flows } = externalFlowsOf(movements, USD);
        expect(flows).toHaveLength(1);

        const opening = Money.of(BigInt(openingCents), USD);
        const after = Money.of(BigInt(openingCents + amountCents), USD);
        const valuations: DatedValuation[] = [
          { date: START, value: opening },
          { date: flowDate, value: after },
          { date: end, value: after },
        ];
        const twr = timeWeightedReturn({ valuations, flows });
        expect(Number(twr.periodReturn)).toBe(0);

        const mwr = moneyWeightedReturn({
          openingValue: { date: START, value: opening },
          flows,
          closingValue: { date: end, value: after },
        });
        expect(mwr.status).toBe('available');
        if (mwr.status === 'available')
          expect(Math.abs(Number(mwr.periodReturn))).toBeLessThan(1e-8);

        expect(summariseActivity(movements, USD).netContributions).toEqual(
          Money.of(BigInt(amountCents), USD),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('a dividend with no price change raises TWR and MWR, and is not a contribution', () => {
    fc.assert(
      fc.property(dividendScenario, ({ openingCents, yieldBasisPoints, flowDay, spanDays }) => {
        const amountCents = Math.max(1, Math.floor((openingCents * yieldBasisPoints) / 10_000));
        const payDate = DateOnly.addDays(START, flowDay);
        const end = DateOnly.addDays(START, spanDays);
        const movements = [movement('d', payDate, 'dividend', -BigInt(amountCents))];
        const { flows } = externalFlowsOf(movements, USD);
        // The cash stays in the account, so it is in the valuation and in no flow.
        expect(flows).toEqual([]);

        const opening = Money.of(BigInt(openingCents), USD);
        const after = Money.of(BigInt(openingCents + amountCents), USD);
        const valuations: DatedValuation[] = [
          { date: START, value: opening },
          { date: payDate, value: after },
          { date: end, value: after },
        ];
        const twr = timeWeightedReturn({ valuations, flows });
        expect(Number(twr.periodReturn)).toBeGreaterThan(0);
        // Exactly D / V0: nothing else moved.
        expect(Number(twr.periodReturn)).toBeCloseTo(amountCents / openingCents, 8);

        const mwr = moneyWeightedReturn({
          openingValue: { date: START, value: opening },
          flows,
          closingValue: { date: end, value: after },
        });
        expect(mwr.status).toBe('available');
        if (mwr.status === 'available') expect(Number(mwr.periodReturn)).toBeGreaterThan(0);

        const totals = summariseActivity(movements, USD);
        expect(totals.netContributions).toEqual(Money.zero(USD));
        expect(totals.dividendsAndInterest).toEqual(Money.of(BigInt(amountCents), USD));
      }),
      { numRuns: 200 },
    );
  });
});
