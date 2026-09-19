// SPDX-License-Identifier: MIT
/**
 * The envelope math of 07 §1.2–1.3, with no database in the loop.
 *
 * The headline test is the dispatch's named one — `available = carryover +
 * assigned + activity for every policy` — and it is a `fast-check` property
 * rather than a table of examples because the claim is universally quantified.
 * An example-based version proves the four cases somebody thought of; this one
 * fails on the fifth.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ROLLOVER_POLICIES, type RolloverPolicy } from '../schema/index.ts';
import { applyCardEffects } from './credit.ts';
import {
  absorbedByRta,
  available,
  neededThisPeriod,
  rolloverOut,
  runEnvelope,
  underfunded,
  type EnvelopeTransaction,
} from './envelope.ts';

const USD = 'USD';
const usd = (minor: bigint): MoneyType => Money.of(minor, USD);
const zero = Money.zero(USD);

/** Minor units, bounded so a sum cannot leave the range a human would check by hand. */
const minor = fc.bigInt({ min: -10_000_000n, max: 10_000_000n });
const amount = minor.map(usd);
const policy = fc.constantFrom<RolloverPolicy>(...ROLLOVER_POLICIES);

function spend(id: string, day: string, minorUnits: bigint, credit = false): EnvelopeTransaction {
  return {
    id,
    budgetDate: day,
    amount: usd(minorUnits),
    funding: credit ? 'CREDIT' : 'CASH',
    creditAccountId: credit ? 'card-1' : null,
  };
}

describe('envelope math (07 §1.2)', () => {
  it('available = carryover + assigned + activity for every policy', () => {
    fc.assert(
      fc.property(amount, amount, amount, policy, (previous, assigned, activity, rolloverPolicy) => {
        // carryover(c, p) = rollover_fn(available(c, p-1), policy)  — 07 §1.2 line 61
        const carryover = rolloverOut(previous, rolloverPolicy);

        // available(c, p) = carryover + assigned + activity          — 07 §1.2 line 62
        const expected = available({ carryover, assigned, activity });

        // The same period run through the transaction-ordered engine must agree
        // with the closed form. That is the whole point: `runEnvelope` exists to
        // produce the cash/credit *split*, and it must not, in doing so, produce
        // a different `available`.
        const engine = runEnvelope(Money.add(carryover, assigned), [
          spend('t1', '2026-03-10', activity.minor),
        ]);

        expect(engine.available.minor).toBe(expected.minor);
        expect(engine.available.currency).toBe(USD);

        // And the policy's two halves account for every cent of the period
        // before it — `available = rolloverOut + absorbedByRta` is a CHECK on
        // `rollovers`, so a violation here is a row Postgres would refuse.
        expect(
          Money.add(rolloverOut(previous, rolloverPolicy), absorbedByRta(previous, rolloverPolicy))
            .minor,
        ).toBe(previous.minor);
      }),
      { numRuns: 500 },
    );
  });

  it('rollover_fn is exactly 07 §1.2 lines 67-71', () => {
    expect(rolloverOut(usd(5_000n), 'ROLLOVER').minor).toBe(5_000n);
    expect(rolloverOut(usd(-5_000n), 'ROLLOVER').minor).toBe(0n);
    expect(rolloverOut(usd(5_000n), 'RESET').minor).toBe(0n);
    expect(rolloverOut(usd(-5_000n), 'RESET').minor).toBe(0n);
    expect(rolloverOut(usd(5_000n), 'ROLLOVER_ALLOW_NEGATIVE').minor).toBe(5_000n);
    expect(rolloverOut(usd(-5_000n), 'ROLLOVER_ALLOW_NEGATIVE').minor).toBe(-5_000n);
  });

  it('|min(available, 0)| = cashOverspend + creditOverspend, always', () => {
    fc.assert(
      fc.property(
        amount,
        fc.array(fc.tuple(minor, fc.boolean()), { maxLength: 12 }),
        (opening, rows) => {
          const result = runEnvelope(
            opening,
            rows.map(([value, credit], index) =>
              spend(`t${index}`, `2026-03-${String((index % 28) + 1).padStart(2, '0')}`, value, credit),
            ),
          );
          const shortfall = Money.absolute(Money.min(result.available, zero));
          expect(Money.add(result.cashOverspend, result.creditOverspend).minor).toBe(
            shortfall.minor,
          );
          // Both halves are magnitudes: the `CHECK`s on `budget_lines` refuse a
          // negative, so producing one here would be a write that cannot land.
          expect(result.cashOverspend.minor >= 0n).toBe(true);
          expect(result.creditOverspend.minor >= 0n).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('cash versus credit overspending (07 §1.3)', () => {
  it('a cash overspend is red: the whole shortfall is cash', () => {
    const result = runEnvelope(usd(8_000n), [spend('t1', '2026-03-02', -10_000n)]);
    expect(result.available.minor).toBe(-2_000n);
    expect(result.cashOverspend.minor).toBe(2_000n);
    expect(result.creditOverspend.minor).toBe(0n);
  });

  it('a credit overspend is yellow: no cash has left the building', () => {
    const result = runEnvelope(usd(3_000n), [spend('t1', '2026-03-02', -5_000n, true)]);
    expect(result.available.minor).toBe(-2_000n);
    expect(result.cashOverspend.minor).toBe(0n);
    expect(result.creditOverspend.minor).toBe(2_000n);
    // 07 §1.3: `fundable = min(|amt|, max(0, available))` — $30 available funds
    // $30 of a $50 charge and borrows $20. It does not fund $50 it never had.
    expect(result.cardEffects[0]?.funded.minor).toBe(3_000n);
    expect(result.cardEffects[0]?.borrowed.minor).toBe(2_000n);
  });

  it('a refund repays borrowing before a later cash overspend is coloured', () => {
    // Borrow $100, get it all back, then overspend $50 in cash. The $50 is cash
    // gone — red — and reporting it as credit would tell the user nothing had
    // actually left their account.
    const result = runEnvelope(zero, [
      spend('t1', '2026-03-01', -10_000n, true),
      spend('t2', '2026-03-05', 10_000n, true),
      spend('t3', '2026-03-09', -5_000n),
    ]);
    expect(result.available.minor).toBe(-5_000n);
    expect(result.cashOverspend.minor).toBe(5_000n);
    expect(result.creditOverspend.minor).toBe(0n);
  });

  it('order is fixed on (budgetDate, id) so two recomputes agree', () => {
    const rows = [
      spend('b', '2026-03-05', -5_000n, true),
      spend('a', '2026-03-05', -5_000n, true),
      spend('c', '2026-03-01', 6_000n),
    ];
    const first = runEnvelope(zero, rows);
    const second = runEnvelope(zero, [...rows].reverse());
    expect(first.creditOverspend.minor).toBe(second.creditOverspend.minor);
    expect(first.cardEffects[0]?.funded.minor).toBe(second.cardEffects[0]?.funded.minor);
  });
});

describe('the credit-card payment envelope (07 §1.3, identity II)', () => {
  it('owed = available(CCP) + unfundedDebt after a partly funded charge', () => {
    // $30 in the envelope, $50 on the card: $30 is earmarked, $20 is borrowed.
    const envelope = runEnvelope(usd(3_000n), [spend('t1', '2026-03-02', -5_000n, true)]);
    const card = applyCardEffects({
      opening: { creditAccountId: 'card-1', available: zero, unfundedDebt: zero },
      assigned: zero,
      effects: envelope.cardEffects,
      payments: zero,
    });
    expect(card.available.minor).toBe(3_000n);
    expect(card.unfundedDebt.minor).toBe(2_000n);
    expect(Money.add(card.available, card.unfundedDebt).minor).toBe(5_000n);
  });

  it('a refund bigger than the envelope retires unfunded debt (extends §1.3)', () => {
    // Owed $100, nothing earmarked. A $100 refund clears the card, so identity
    // II demands the unfunded debt goes with it — §1.3's `min(...)` clamp alone
    // would leave $100 of debt against a $0 balance.
    const card = applyCardEffects({
      opening: { creditAccountId: 'card-1', available: zero, unfundedDebt: usd(10_000n) },
      assigned: zero,
      effects: [
        { creditAccountId: 'card-1', funded: zero, borrowed: zero, returned: usd(10_000n) },
      ],
      payments: zero,
    });
    expect(card.available.minor).toBe(0n);
    expect(card.unfundedDebt.minor).toBe(0n);
  });

  it('a payment bigger than the envelope drives it negative, and that is correct', () => {
    // Owed $100, $80 earmarked, $20 borrowed. Pay the statement in full: the
    // card is clear, and the CCP envelope is -$20 — the honest record that $20
    // of some other envelope's money went to the bank.
    const card = applyCardEffects({
      opening: { creditAccountId: 'card-1', available: usd(8_000n), unfundedDebt: usd(2_000n) },
      assigned: zero,
      effects: [],
      payments: usd(10_000n),
    });
    expect(card.available.minor).toBe(-2_000n);
    expect(card.unfundedDebt.minor).toBe(2_000n);
    expect(Money.add(card.available, card.unfundedDebt).minor).toBe(0n);
  });
});

describe('goals (07 §1.8)', () => {
  const base = {
    goalAmount: null,
    periodsRemainingInclusive: 1,
    goalPercent: null,
    periodIncome: zero,
    carryover: zero,
    activity: zero,
    scheduledInflows: zero,
    currency: USD,
  } as const;

  it('TARGET_BY_DATE is 07 §1.8 line 221 and rounds up, never down', () => {
    // $1,000 target, $100 held, 3 periods left: 900 / 3 = exactly $300.
    expect(
      neededThisPeriod({
        ...base,
        goalType: 'TARGET_BY_DATE',
        goalAmount: usd(100_000n),
        carryover: usd(10_000n),
        periodsRemainingInclusive: 3,
      }).minor,
    ).toBe(30_000n);

    // $100 over 3 periods is $33.34/$33.33/$33.33 if you allocate, but a *goal*
    // is "how much per period" and 3 x $33.33 is $99.99 — a cent short on the
    // target date, every time, for the life of the goal. Round up.
    expect(
      neededThisPeriod({
        ...base,
        goalType: 'TARGET_BY_DATE',
        goalAmount: usd(10_000n),
        periodsRemainingInclusive: 3,
      }).minor,
    ).toBe(3_334n);
  });

  it('TARGET_BY_DATE subtracts scheduled inflows, and never goes negative', () => {
    expect(
      neededThisPeriod({
        ...base,
        goalType: 'TARGET_BY_DATE',
        goalAmount: usd(100_000n),
        scheduledInflows: usd(200_000n),
        periodsRemainingInclusive: 2,
      }).minor,
    ).toBe(0n);
  });

  it('MINIMUM_BALANCE tops up after spending; REFILL_UP_TO refills to a ceiling', () => {
    // Arrived with $120, spent $80 this period, floor/ceiling $400.
    const shared = { ...base, goalAmount: usd(40_000n), carryover: usd(12_000n), activity: usd(-8_000n) };
    // Floor: the envelope holds $40, so $360 is needed to stand it back up.
    expect(neededThisPeriod({ ...shared, goalType: 'MINIMUM_BALANCE' }).minor).toBe(36_000n);
    // Ceiling: refill what arrived, ignoring the month's spending. $280.
    expect(neededThisPeriod({ ...shared, goalType: 'REFILL_UP_TO' }).minor).toBe(28_000n);
  });

  it('PCT_OF_INCOME multiplies by a decimal string and never by a number', () => {
    // 0.15 x $1,234.56 = $185.184, which `0.15 * 123456` gets wrong in binary
    // floating point (185.18399999999997). Banker's rounding lands it on $185.18.
    expect(
      neededThisPeriod({
        ...base,
        goalType: 'PCT_OF_INCOME',
        goalPercent: '0.1500',
        periodIncome: usd(123_456n),
      }).minor,
    ).toBe(18_518n);
  });

  it('MONTHLY_TARGET is the target, and NONE is nothing', () => {
    expect(neededThisPeriod({ ...base, goalType: 'MONTHLY_TARGET', goalAmount: usd(5_000n) }).minor)
      .toBe(5_000n);
    expect(neededThisPeriod({ ...base, goalType: 'NONE' }).minor).toBe(0n);
  });

  it('underfunded is max(0, needed - assigned) — 07 §1.8 line 224', () => {
    expect(underfunded(usd(5_000n), usd(2_000n)).minor).toBe(3_000n);
    expect(underfunded(usd(5_000n), usd(9_000n)).minor).toBe(0n);
  });
});
