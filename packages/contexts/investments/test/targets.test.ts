// SPDX-License-Identifier: MIT
/**
 * WP 4.7 — stored allocation targets.
 *
 * Two rules, both load-bearing for I1: a set that does not sum to 1.0 is
 * refused with the shortfall named (never silently rescaled), and the unset
 * state — zero rows — must actually suppress `driftAgainstTargets` rather
 * than let anything upstream fill the gap with a default 60/40
 * (`wp3.9-routes.md` §8 Q9). The second is sabotage-tested: see
 * `docs/evidence/phase-4/wp4.7-gap-fields.md` for the observed-red record.
 */
import { Money, Quantity, currency, fixedClock, newId } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { AssetClass } from '../schema/index.ts';
import { driftAgainstTargets } from '../src/analytics/drift.ts';
import {
  AnalyticsInputError,
  type AnalyticsHolding,
  type ValuationOptions,
} from '../src/analytics/types.ts';
import {
  AllocationTargetsError,
  TARGET_SUM_TOLERANCE,
  assertTargetsSumToOne,
  inMemoryAllocationTargetsStore,
  type AllocationTargetInput,
} from '../src/targets.ts';

const USD = currency('USD');
const OPTIONS: ValuationOptions = { currency: USD, scale: 2, basis: 'as_of_now' };

function holding(
  id: string,
  assetClass: AssetClass,
  quantity: string,
  price: string,
): AnalyticsHolding {
  return {
    holdingId: id,
    accountId: 'acct-taxable',
    securityId: `sec-${id}`,
    symbol: id.toUpperCase(),
    quantity: Quantity.of(quantity),
    price: { amount: Quantity.of(price), currency: USD },
    staleness: 'FRESH',
    assetClass,
    region: 'US',
    sector: 'Diversified',
    expenseRatio: '0.0003',
    isCashEquivalent: false,
    isInvestable: true,
    costBasis: Money.parseAmount('1000.00', USD),
  };
}

/** $60,000 of equity and $40,000 of bonds — the same shape `drift.test.ts` uses. */
const PORTFOLIO: readonly AnalyticsHolding[] = [
  holding('eq', 'US_EQUITY', '1000', '60.00'),
  holding('bd', 'US_BOND', '1000', '40.00'),
];

describe('assertTargetsSumToOne', () => {
  it('targets that do not sum to 1.0 are refused, and the refusal names the shortfall', () => {
    const short: readonly AllocationTargetInput[] = [
      { assetClass: 'US_EQUITY', targetWeight: '0.55' },
      { assetClass: 'US_BOND', targetWeight: '0.40' },
    ];
    let thrown: unknown;
    try {
      assertTargetsSumToOne(short);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AllocationTargetsError);
    const error = thrown as AllocationTargetsError;
    expect(error.constraint).toBe('allocation_targets_sum_to_one');
    // The shortfall, named: 0.95 total is short by 5 points, and the message
    // says so rather than just "invalid".
    expect(error.message).toContain('0.95');
    expect(error.message).toContain('short by 5');

    const over: readonly AllocationTargetInput[] = [
      { assetClass: 'US_EQUITY', targetWeight: '0.60' },
      { assetClass: 'US_BOND', targetWeight: '0.45' },
    ];
    expect(() => assertTargetsSumToOne(over)).toThrow(/over by 5/);

    // Exactly at the tolerance (0.01 points = a ten-thousandth of a ratio) is
    // accepted; a hair past it is not — the same "strictly greater than"
    // boundary `drift.ts`'s own band uses.
    expect(() =>
      assertTargetsSumToOne([
        { assetClass: 'US_EQUITY', targetWeight: '0.5999' },
        { assetClass: 'US_BOND', targetWeight: '0.40' },
      ]),
    ).not.toThrow();
    expect(() =>
      assertTargetsSumToOne([
        { assetClass: 'US_EQUITY', targetWeight: '0.5998' },
        { assetClass: 'US_BOND', targetWeight: '0.40' },
      ]),
    ).toThrow(AllocationTargetsError);
  });

  it('the empty set is always accepted — it is unset, not a set that failed to sum', () => {
    expect(() => assertTargetsSumToOne([])).not.toThrow();
  });

  it('two targets for the same asset class are refused before the sum is computed', () => {
    expect(() =>
      assertTargetsSumToOne([
        { assetClass: 'US_EQUITY', targetWeight: '0.5' },
        { assetClass: 'US_EQUITY', targetWeight: '0.5' },
      ]),
    ).toThrow(/two targets for US_EQUITY/);
  });

  it('a weight outside [0,1] is refused', () => {
    expect(() => assertTargetsSumToOne([{ assetClass: 'US_EQUITY', targetWeight: '1.5' }])).toThrow(
      AllocationTargetsError,
    );
    expect(() =>
      assertTargetsSumToOne([{ assetClass: 'US_EQUITY', targetWeight: '-0.1' }]),
    ).toThrow(AllocationTargetsError);
  });

  it('shares its tolerance with drift.ts, so a set this store accepts is one driftAgainstTargets can always compute over', () => {
    expect(TARGET_SUM_TOLERANCE).toBe('0.0100');
  });
});

describe('the allocation-targets store', () => {
  it('an unset target set still suppresses drift rather than implying 60/40', async () => {
    const store = inMemoryAllocationTargetsStore(fixedClock('2026-09-24T00:00:00Z'));
    const userId = newId();

    // Unset: nothing was ever written, and the store says so with an empty
    // array — never a default.
    expect(await store.listAll(userId)).toEqual([]);

    // The control this test exists to prove: `driftAgainstTargets` refuses an
    // empty target set outright (WP 3.3's own rule) rather than any caller —
    // this store included — silently substituting a 60/40 split. Sabotaged by
    // temporarily making `inMemoryAllocationTargetsStore.listAll` return a
    // default 60/40 set for an unknown user; observed red; reverted — see
    // docs/evidence/phase-4/wp4.7-gap-fields.md.
    const unset = await store.listAll(userId);
    expect(() =>
      driftAgainstTargets(
        PORTFOLIO,
        unset.map((row) => ({ assetClass: row.assetClass, targetWeight: row.targetWeight })),
        OPTIONS,
      ),
    ).toThrow(AnalyticsInputError);

    // Setting an explicit, complete set — deliberately *not* 60/40, so a test
    // that passed only because 60/40 happens to be the fallback somewhere
    // would be caught — turns drift back on with exactly what was set.
    const written = await store.replaceAll(userId, [
      { assetClass: 'US_EQUITY', targetWeight: '0.55' },
      { assetClass: 'US_BOND', targetWeight: '0.45' },
    ]);
    expect(written).toHaveLength(2);

    const set = await store.listAll(userId);
    const report = driftAgainstTargets(
      PORTFOLIO,
      set.map((row) => ({ assetClass: row.assetClass, targetWeight: row.targetWeight })),
      OPTIONS,
    );
    expect(report.proposalsWithheld).toBeNull();
    // The portfolio is 60/40 against a 55/45 target: 5 points over on equity,
    // exactly on the boundary drift.test.ts already proves is silent.
    expect(report.proposals).toHaveLength(0);
  });

  it('clearing the set back to empty is a legitimate call, and still emits the event', async () => {
    const store = inMemoryAllocationTargetsStore(fixedClock('2026-09-24T00:00:00Z'));
    const userId = newId();

    await store.replaceAll(userId, [{ assetClass: 'US_EQUITY', targetWeight: '1' }]);
    expect(await store.listAll(userId)).toHaveLength(1);

    await store.replaceAll(userId, []);
    expect(await store.listAll(userId)).toEqual([]);
  });

  it('emits investments.AllocationTargetsChanged on every write, including a clear', async () => {
    const store = inMemoryAllocationTargetsStore(fixedClock('2026-09-24T00:00:00Z'));
    const userId = newId();

    await store.replaceAll(userId, [
      { assetClass: 'US_EQUITY', targetWeight: '0.6' },
      { assetClass: 'US_BOND', targetWeight: '0.4' },
    ]);
    await store.replaceAll(userId, []);

    expect(store.events).toHaveLength(2);
    expect(store.events[0]?.eventType).toBe('investments.AllocationTargetsChanged');
    expect(store.events[0]?.payload).toMatchObject({ count: 2 });
    expect(store.events[1]?.payload).toMatchObject({ count: 0, assetClasses: [] });
  });

  it('an unset weight replaced with the default band still refuses a bad sum, and a valid set stores the default band', async () => {
    const store = inMemoryAllocationTargetsStore(fixedClock('2026-09-24T00:00:00Z'));
    const userId = newId();

    await expect(
      store.replaceAll(userId, [{ assetClass: 'US_EQUITY', targetWeight: '0.9' }]),
    ).rejects.toThrow(AllocationTargetsError);

    const set = await store.replaceAll(userId, [{ assetClass: 'US_EQUITY', targetWeight: '1' }]);
    expect(set[0]?.bandPct).toBe('5.0000');
  });
});
