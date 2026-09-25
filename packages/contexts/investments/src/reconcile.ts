// SPDX-License-Identifier: MIT
/**
 * Holdings reconcile to balances — the v0.5 rung clause with no test until
 * this file (docs/evidence/phase-3/wp3.14-quality.md §1's "Holdings reconcile
 * to balances" row and §8 item 5).
 *
 * `holdings.institution_value_minor` (`lots-store.ts`, written by
 * `upsertHolding` around line 337) is the institution's own assertion of what
 * a position is worth, timestamped by `as_of_date` — never a number we
 * computed. This file answers the question nothing else in the package asks:
 * does that assertion agree with what our own engine would compute —
 * `quantity × the latest known price` — using the exact arithmetic
 * `basis.ts`'s `marketValueOf` already uses for a gain calculation? No new
 * arithmetic is added here; the point is to run the existing, audited
 * rounding (`marketValueOf`'s single half-even round into minor units, 04
 * §2.3) a second time, independently, and compare the two numbers.
 *
 * ## The tolerance rule
 *
 * **One minor unit (one cent, for a 2-decimal currency) per holding.**
 * `marketValueOf` rounds `quantity × price` half-even into minor units
 * exactly once; an institution's own statement value is somebody else's
 * independent rounding of the same real-valued quantity, at the same scale.
 * Two correct roundings of the same real number can differ by at most one
 * unit in the last place — that is what "rounding" means — so one minor unit
 * is not a fudge factor, it is the largest disagreement two honest roundings
 * of the same true value can produce. Anything larger did not come from
 * rounding: a stale price, a wrong quantity, a corporate action neither side
 * applied, or a genuine data error. That is `tolerance_breach`, and it
 * carries both values and the signed difference so the difference itself is
 * diagnostic (a difference that is an exact multiple of the price is a
 * quantity bug; a difference proportional to the position is a stale-price
 * bug).
 *
 * A holding with no resolvable price is never silently folded into
 * `reconciled` at the institution's value (that would prove nothing) or into
 * `tolerance_breach` (that would report a spurious 100%-of-value
 * disagreement). It is its own state, `no_price` — exactly the way 04 §5.5
 * and this package's own `basis.ts` treat a missing input as its own state
 * rather than a zero standing in for one.
 *
 * ## Sabotage record
 *
 * See `docs/evidence/phase-3/wp3.14-quality.md` §10 for the exact mutations
 * applied to this file and reverted, and the test output each produced:
 * widening the tolerance to an effectively infinite bound (every
 * `tolerance_breach` fixture silently reclassified as `reconciled`), and
 * dropping the price term from the computed value (every `reconciled`
 * fixture silently reclassified as `tolerance_breach`).
 */
import type { CurrencyCode, Money as MoneyType } from '@core/kernel';
import { marketValueOf, type LotPrice } from './basis.ts';
import type { Holding } from './holdings.ts';

/** One holding's reconciliation outcome. Three states, never a boolean. */
export const HOLDING_RECONCILIATION_STATUSES = [
  'reconciled',
  'tolerance_breach',
  'no_price',
] as const;
export type HoldingReconciliationStatus = (typeof HOLDING_RECONCILIATION_STATUSES)[number];

/**
 * One minor unit — the largest gap two independent, correct half-even
 * roundings of the same real-valued `quantity × price` can produce. See the
 * file header for why this is the rule rather than a percentage or a
 * round-numbered fudge factor.
 */
export const DEFAULT_RECONCILE_TOLERANCE_MINOR = 1n;

export type HoldingReconciliation =
  | {
      readonly accountId: string;
      readonly securityId: string;
      readonly status: 'reconciled' | 'tolerance_breach';
      readonly institutionValue: MoneyType;
      readonly computedValue: MoneyType;
      /** `computedValue.minor - institutionValue.minor`. Signed, so the direction is legible. */
      readonly differenceMinor: bigint;
    }
  | {
      readonly accountId: string;
      readonly securityId: string;
      readonly status: 'no_price';
      readonly institutionValue: MoneyType;
      readonly computedValue: null;
      readonly differenceMinor: null;
    };

/**
 * One holding against one price. Pure: no I/O, no clock — the caller looked
 * up the latest price (`PriceReader.price`, WP 3.4) and hands it over as a
 * `LotPrice`, exactly as `unrealizedGainOf` does in `basis.ts`.
 *
 * `price === null` is the honest "we have no price for this security", not a
 * caller error — a fresh install or a delisted security reaches this exactly
 * as often as a priced holding does, and `no_price` is the answer for it,
 * never a silent pass.
 */
export function reconcileHolding(
  holding: Holding,
  price: LotPrice | null,
  scale: number,
  toleranceMinor: bigint = DEFAULT_RECONCILE_TOLERANCE_MINOR,
): HoldingReconciliation {
  if (price === null) {
    return {
      accountId: holding.accountId,
      securityId: holding.securityId,
      status: 'no_price',
      institutionValue: holding.institutionValue,
      computedValue: null,
      differenceMinor: null,
    };
  }
  if (price.currency !== holding.institutionValue.currency) {
    // The same convention `Money.add` states in docs/CONVENTIONS.md: a
    // mismatched currency throws rather than being coerced. A caller handing
    // this function a CAD price for a USD holding has a bug upstream of
    // reconciliation, not a reconciliation outcome to report.
    throw new RangeError(
      `reconcileHolding: institution value is ${holding.institutionValue.currency} but the ` +
        `price is ${price.currency}, for account ${holding.accountId} security ` +
        `${holding.securityId} — reconciliation never coerces a currency`,
    );
  }

  const computedValue = marketValueOf(holding.quantity, price, scale);
  const differenceMinor = computedValue.minor - holding.institutionValue.minor;
  const absoluteDifference = differenceMinor < 0n ? -differenceMinor : differenceMinor;

  return {
    accountId: holding.accountId,
    securityId: holding.securityId,
    status: absoluteDifference <= toleranceMinor ? 'reconciled' : 'tolerance_breach',
    institutionValue: holding.institutionValue,
    computedValue,
    differenceMinor,
  };
}

/**
 * Every holding against its own latest price. `priceOf`/`scaleOf` are
 * caller-supplied lookups rather than a store handle, so this stays pure and
 * is callable equally from a unit test with hand-built fixtures and from a
 * route wiring a real `PriceReader` and `@core/kernel`'s `minorUnitScale`.
 */
export function reconcileHoldings(
  holdings: readonly Holding[],
  priceOf: (holding: Holding) => LotPrice | null,
  scaleOf: (currency: CurrencyCode) => number,
  toleranceMinor: bigint = DEFAULT_RECONCILE_TOLERANCE_MINOR,
): readonly HoldingReconciliation[] {
  return holdings.map((holding) =>
    reconcileHolding(
      holding,
      priceOf(holding),
      scaleOf(holding.institutionValue.currency),
      toleranceMinor,
    ),
  );
}
