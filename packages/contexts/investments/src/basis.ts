// SPDX-License-Identifier: MIT
/**
 * Unrealised gain, and the one rule that makes this file worth having:
 * **an unknown basis is `unavailable`, never a gain from zero.**
 *
 * 04 §5.5, verbatim: "Cost basis is the weak link. Plaid's cost basis is
 * frequently absent or wrong after an ACATS transfer. … Where basis is unknown,
 * report unrealized gain as *unavailable* rather than computing it from a zero
 * basis." 07 §6.2 says the same for crypto and adds the reason a zero is worse
 * than nothing: it is not conservative, it is a fabricated 100% gain, and it
 * flows into allocation, into the tax estimate and onto the screen looking
 * exactly like a real number.
 *
 * The measured R6 verdict (docs/evidence/phase-3/wp3.5-coinbase.md §1) makes
 * this the *common* case rather than the edge case. Coinbase v3 reports exact
 * fills and nothing else; every deposit, withdrawal, staking reward and
 * transfer arrives from the CSV export or not at all. A Coinbase wallet
 * therefore routinely holds one `BROKER` lot with an exact basis beside three
 * lots with no basis at all, and an engine that averaged the two would report a
 * confident wrong number on the most common account in the app.
 *
 * ## The shape, and why it is a union rather than a flag
 *
 * `UnrealizedGain` is a discriminated union. Not `{ gain: Money; known:
 * boolean }` — the same argument 04 makes about a missing FX rate never
 * defaulting to 1.0: a number with a flag beside it is a number somebody will
 * render without reading the flag, and the failure is invisible because the
 * number looks fine. There is no `Money` to read at all when the answer is
 * unavailable, so the only way to display something is to handle the case.
 *
 * `unavailable` is not a dead end either: it carries `lotIds` and a `reason`,
 * so the UI can say *which* positions need a basis and the user can fix the
 * one that matters instead of being told the portfolio is unknowable.
 *
 * ## Prices come from elsewhere
 *
 * Nothing in this file fetches a price. A market value is
 * `quantity × price`, and WP 3.4 owns where the price came from, how stale it
 * is and which source won. This file takes a `LotPrice` — a decimal string with
 * a currency — and does arithmetic on it. A missing price is its own
 * `unavailable` reason, for the same reason a missing basis is: a portfolio
 * valued at a price nobody has is not valued.
 */
import {
  Money,
  Quantity,
  type CurrencyCode,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import {
  remainingBasisOf,
  isOpen,
  type Lot,
  UNKNOWN_BASIS_WARNING,
} from './lots.ts';

/** Why a gain could not be stated. Codes, so a UI can branch without parsing prose. */
export const UNAVAILABLE_REASONS = [
  'basis_unknown',
  'price_unknown',
  'currency_mismatch',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * A unit price, as WP 3.4 will hand it over: a decimal string, never a float.
 *
 * `NUMERIC(20,10)` in the database. Multiplied by an 18-decimal quantity and
 * then summed across a portfolio, which is precisely where a float's error
 * compounds where nobody looks (the Phase 3 risk table's first row).
 */
export interface LotPrice {
  readonly amount: QuantityType;
  readonly currency: CurrencyCode;
}

export type Valuation =
  | {
      readonly status: 'available';
      readonly marketValue: MoneyType;
      readonly costBasis: MoneyType;
      readonly gain: MoneyType;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: UnavailableReason;
      /** The lots that caused it, so the UI can name them. Empty when the price is missing. */
      readonly lotIds: readonly string[];
      /** The text 07 §6.2 requires to be *visible*. */
      readonly warning: string;
      /**
       * What the position is worth, which is knowable even when the gain is
       * not. Reporting a market value beside an unavailable gain is the honest
       * middle: the user can see the position, just not what it cost.
       */
      readonly marketValue: MoneyType | null;
    };

/** The alias the exit test and the rest of the context use. */
export type UnrealizedGain = Valuation;

export const PRICE_UNKNOWN_WARNING =
  'No price is available for this security, so its market value and gain are unavailable.';

/**
 * Market value of one lot's remaining quantity at `price`.
 *
 * `Money` is integer minor units, so the multiplication happens in decimal and
 * is rounded once, at the end, half-even — never per-share and never through a
 * float. `minorUnitScale` comes from the currency rather than being assumed to
 * be 2, which is the JPY bug 04 §2.3 names.
 */
export function marketValueOf(
  quantity: QuantityType,
  price: LotPrice,
  scale: number,
): MoneyType {
  const gross = Quantity.multiply(quantity, price.amount);
  const shifted = Quantity.multiply(gross, '1' + '0'.repeat(scale));
  // One rounding, at the boundary into minor units, and it is explicit and
  // audited — 04 §2.3's rule for the only legal float-free conversion.
  return Money.of(roundHalfEven(Quantity.toDatabaseString(shifted)), price.currency);
}

/** Round a plain decimal string to a whole number, half-even. No `number` involved. */
function roundHalfEven(text: string): bigint {
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [wholePart = '0', fractionPart = ''] = digits.split('.');
  let whole = BigInt(wholePart);
  const fraction = fractionPart.replace(/0+$/, '');
  if (fraction.length > 0) {
    const half = '5'.padEnd(fraction.length, '0');
    const comparison = compareDigits(fraction, half);
    const roundUp = comparison > 0 || (comparison === 0 && whole % 2n === 1n);
    if (roundUp) whole += 1n;
  }
  return negative ? -whole : whole;
}

function compareDigits(a: string, b: string): -1 | 0 | 1 {
  const width = Math.max(a.length, b.length);
  const left = a.padEnd(width, '0');
  const right = b.padEnd(width, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Total cost basis of a set of lots, or `unavailable`.
 *
 * One lot without a basis makes the whole total unavailable. That is stricter
 * than summing what is known, and deliberately so: a total that silently omits
 * three of five lots is *smaller* than the truth and indistinguishable from a
 * correct total, which is how an "unrealised gain" becomes a number nobody can
 * reconcile to a statement.
 */
export function costBasisOf(
  lots: readonly Lot[],
  currency: CurrencyCode,
): { readonly status: 'available'; readonly amount: MoneyType } | {
  readonly status: 'unavailable';
  readonly lotIds: readonly string[];
} {
  const open = lots.filter(isOpen);
  const unknown = open.filter((lot) => lot.basis === null).map((lot) => lot.id);
  if (unknown.length > 0) return { status: 'unavailable', lotIds: unknown };
  let total = Money.zero(currency);
  for (const lot of open) {
    const remaining = remainingBasisOf(lot);
    if (remaining === null) return { status: 'unavailable', lotIds: [lot.id] };
    if (remaining.currency !== currency) {
      return { status: 'unavailable', lotIds: [lot.id] };
    }
    total = Money.add(total, remaining);
  }
  return { status: 'available', amount: total };
}

export interface UnrealizedOptions {
  /** Minor-unit scale of `price.currency`. Passed in so this file needs no currency table. */
  readonly scale: number;
}

/**
 * Unrealised gain across a set of lots at one price.
 *
 * The order of the checks matters and is the point of the function:
 *
 *   1. no price → `price_unknown`, and there is no market value either;
 *   2. any lot without a basis → `basis_unknown`, **with** the market value,
 *      because the position's *worth* is knowable even when its cost is not;
 *   3. otherwise → a real `gain`, which is `marketValue − costBasis`.
 *
 * Step 2 is the one 04 §5.5 is about. There is no branch that reaches step 3
 * with a `null` basis in the set, and the sabotage that proves it
 * (`coalesce`-ing the null to `Money.zero`) is recorded in the evidence note.
 */
export function unrealizedGainOf(
  lots: readonly Lot[],
  price: LotPrice | null,
  options: UnrealizedOptions,
): UnrealizedGain {
  const open = lots.filter(isOpen);
  const currency = price?.currency ?? open[0]?.currency;

  if (price === null || currency === undefined) {
    return {
      status: 'unavailable',
      reason: 'price_unknown',
      lotIds: open.map((lot) => lot.id),
      warning: PRICE_UNKNOWN_WARNING,
      marketValue: null,
    };
  }

  const quantity = open.reduce(
    (total, lot) => Quantity.add(total, lot.quantityRemaining),
    Quantity.zero,
  );
  const marketValue = marketValueOf(quantity, price, options.scale);

  const basis = costBasisOf(open, currency);
  if (basis.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: 'basis_unknown',
      lotIds: basis.lotIds,
      warning: UNKNOWN_BASIS_WARNING,
      marketValue,
    };
  }

  return {
    status: 'available',
    marketValue,
    costBasis: basis.amount,
    gain: Money.subtract(marketValue, basis.amount),
  };
}

/**
 * Whether a set of lots can state a gain at all, ignoring the price.
 *
 * Exists so a caller that has not yet fetched a price can still tell the user
 * "we are missing a basis for two of your positions" — which is the actionable
 * half of `unavailable`, and the half a boolean `known` flag would flatten.
 */
export function lotsWithoutBasis(lots: readonly Lot[]): readonly string[] {
  return lots.filter(isOpen).filter((lot) => lot.basis === null).map((lot) => lot.id);
}
