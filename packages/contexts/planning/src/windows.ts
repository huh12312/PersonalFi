// SPDX-License-Identifier: MIT
/**
 * The arithmetic under revealed behaviour (WP 4.3): trailing windows, exact
 * rational scaling, and the one-off detector — all over `bigint` minor units.
 *
 * Nothing here knows what a contribution or a budget line is. `src/revealed.ts`
 * decides *what* is observed; this file decides *how much history that is*,
 * *what it annualises to*, and *which single observation is a one-off*. Keeping
 * the two apart is what lets `test/revealed.test.ts` sabotage the one-off rule
 * or the history minimum without touching the derivation around it.
 *
 * ## No `number` touches an amount
 *
 * D3, and `scripts/check-numeric-boundaries.ts` enforces it syntactically. The
 * only `number`s below are month counts, day counts and peer counts — cardinals
 * and durations, which the check exempts by name. Every amount is a `bigint`,
 * every threshold a decimal *string* parsed to an exact rational, and every
 * division rounds **once**, half-even, at the end.
 *
 * ## `twiceMedian` now delegates to `@core/kernel` (WP 5.14)
 *
 * This file used to carry its own bigint median because `@ctx/recurring`'s
 * `medianMinor` (`packages/contexts/recurring/src/stats.ts`) could not be
 * imported — another context, no boundary arrow, and the wrong rounding mode:
 * `recurring`'s rounds half-even to a whole minor unit, where the one-off test
 * below needs the *exact* median of an even count (it compares against
 * `2 × median`, never a rounded one). `packages/kernel/src/stats.ts` now
 * carries `twiceMedianMinor` for exactly this shape, importable by every
 * context including this one; `twiceMedian` below is a thin, behaviour-
 * preserving wrapper over it, proven equal to the pre-WP-5.14 implementation
 * by `test/stats-kernel-parity.test.ts`.
 */
import { DateOnly, twiceMedianMinor } from '@core/kernel';

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The most months a window may span. Ten years is already more than any caller asks for. */
export const MAX_WINDOW_MONTHS = 120;

/**
 * A trailing window of whole calendar months.
 *
 * `to` is the last day of the last **complete** month on or before `asOf`: if
 * `asOf` is itself a month end that month is in, otherwise the month in progress
 * is not. Half a month of spending annualised is a number that looks exactly
 * like a right one, so an incomplete month is never part of a window.
 */
export interface TrailingWindow {
  readonly asOf: DateOnly;
  /** Inclusive; always the first of a month. */
  readonly from: DateOnly;
  /** Inclusive; always the last day of a month. */
  readonly to: DateOnly;
  readonly months: number;
  /** `to − from + 1`: 365 or 366 for a twelve-month window. */
  readonly days: number;
}

export function trailingWindow(asOf: DateOnly, months: number): TrailingWindow {
  if (!Number.isSafeInteger(months) || months < 1 || months > MAX_WINDOW_MONTHS) {
    throw new RangeError(
      `a trailing window is 1 to ${String(MAX_WINDOW_MONTHS)} whole months, got ${String(months)}`,
    );
  }
  const to =
    DateOnly.compare(asOf, DateOnly.endOfMonth(asOf)) === 0
      ? asOf
      : DateOnly.addDays(DateOnly.startOfMonth(asOf), -1);
  const from = DateOnly.addMonths(DateOnly.startOfMonth(to), -(months - 1));
  return Object.freeze({
    asOf,
    from,
    to,
    months,
    days: DateOnly.differenceInDays(from, to) + 1,
  });
}

/** The first of every month from `from`'s month through `to`'s month, oldest first. */
export function monthStarts(from: DateOnly, to: DateOnly): DateOnly[] {
  const starts: DateOnly[] = [];
  let cursor = DateOnly.startOfMonth(from);
  while (DateOnly.compare(cursor, to) <= 0) {
    starts.push(cursor);
    cursor = DateOnly.addMonths(cursor, 1);
  }
  return starts;
}

/**
 * The part of a window the ledger actually saw.
 *
 * `historyStart` is the earliest row the reader holds. The first month counted
 * is the first *whole* month on or after it — a month whose first half predates
 * the link is a half month, and a half month of contributions divided by one
 * month is a rate off by a factor of two.
 */
export interface ObservedSpan {
  /** `null` when nothing in the window was observed at all. */
  readonly from: DateOnly | null;
  readonly to: DateOnly;
  readonly monthsObserved: number;
}

export function observedSpan(window: TrailingWindow, historyStart: DateOnly | null): ObservedSpan {
  if (historyStart === null) return { from: null, to: window.to, monthsObserved: 0 };
  const firstWhole =
    DateOnly.day(historyStart) === 1
      ? historyStart
      : DateOnly.addMonths(DateOnly.startOfMonth(historyStart), 1);
  const from = DateOnly.compare(firstWhole, window.from) > 0 ? firstWhole : window.from;
  if (DateOnly.compare(from, window.to) > 0) {
    return { from: null, to: window.to, monthsObserved: 0 };
  }
  return { from, to: window.to, monthsObserved: monthStarts(from, window.to).length };
}

/**
 * How many of the window's calendar months are covered on every single day by
 * the given half-open `[start, end)` spans. A budget period straddling a month
 * boundary covers neither month on its own.
 */
export function monthsFullyCovered(
  window: TrailingWindow,
  spans: readonly { readonly startDate: DateOnly; readonly endDate: DateOnly }[],
): number {
  const covered = new Set<number>();
  for (const span of spans) {
    const first = DateOnly.toEpochDay(span.startDate);
    const end = DateOnly.toEpochDay(span.endDate);
    for (let epochDay = first; epochDay < end; epochDay += 1) covered.add(epochDay);
  }
  let whole = 0;
  for (const start of monthStarts(window.from, window.to)) {
    const first = DateOnly.toEpochDay(start);
    const last = DateOnly.toEpochDay(DateOnly.endOfMonth(start));
    let all = true;
    for (let epochDay = first; epochDay <= last && all; epochDay += 1) {
      all = covered.has(epochDay);
    }
    if (all) whole += 1;
  }
  return whole;
}

// ---------------------------------------------------------------------------
// Exact rationals
// ---------------------------------------------------------------------------

/** `numerator / denominator`, rounded half-even to an integer. `denominator > 0`. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('divideHalfEven: denominator must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  if (remainder === 0n) return quotient;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = numerator < 0n ? quotient - 1n : quotient + 1n;
  if (twice > denominator) return away;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : away;
}

/**
 * `numerator / denominator` as a plain decimal string with exactly `places`
 * decimals, rounded once, half-even. The shape every rate in this context
 * takes (D3: a rate is a decimal string, never a float).
 */
export function ratioToDecimal(numerator: bigint, denominator: bigint, places: number): string {
  if (!Number.isSafeInteger(places) || places < 0 || places > 18) {
    throw new RangeError(`ratioToDecimal: places must be 0..18, got ${String(places)}`);
  }
  const scaled = divideHalfEven(numerator * 10n ** BigInt(places), denominator);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const body =
    places === 0 ? digits : `${digits.slice(0, digits.length - places)}.${digits.slice(-places)}`;
  return negative ? `-${body}` : body;
}

/** A non-negative exact rational: a threshold parsed from its decimal string. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** The canonical decimal it was parsed from, for naming it in an explanation. */
  readonly text: string;
}

const THRESHOLD_PATTERN = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/**
 * Parse a threshold (`'4'`, `'2.5'`) to an exact rational. Takes `unknown` and
 * refuses a `number` before looking at it — `k = 3` arriving as a JSON number is
 * a refusal, not a value that happened to survive (the WP 4.1
 * `parseEscalationPct` precedent).
 */
export function parseThreshold(what: string, value: unknown): Rational {
  if (typeof value !== 'string') {
    throw new RangeError(`${what} must be a decimal string, got ${typeof value}`);
  }
  const match = THRESHOLD_PATTERN.exec(value.trim());
  if (match === null) {
    throw new RangeError(`${what} ${JSON.stringify(value)} is not a non-negative plain decimal`);
  }
  const integer = BigInt(match[1] ?? '0').toString();
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return Object.freeze({
    numerator: BigInt(`${integer}${fraction}`),
    denominator: 10n ** BigInt(fraction.length),
    text: fraction === '' ? integer : `${integer}.${fraction}`,
  });
}

/** `⌊√n⌋` for `n ≥ 0`, by Newton's method on integers. Display only — no test compares a root. */
export function integerSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('integerSqrt: negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Twice the median — exact for even counts, where the median itself is a
 * half. Delegates to `@core/kernel`'s `twiceMedianMinor` (WP 5.14); the
 * `RangeError` on empty input is this module's own and preserved exactly.
 */
export function twiceMedian(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError('twiceMedian: empty');
  return twiceMedianMinor(values);
}

// ---------------------------------------------------------------------------
// The one-off detector
// ---------------------------------------------------------------------------

/**
 * The thresholds. Both are parameters, both have defaults in
 * `REVEALED_DEFAULTS` (`src/revealed.ts`).
 *
 *   * `medianMultiple` (`m`, default 4): the candidate exceeds `m ×` the median
 *     of its peers.
 *   * `sigma` (`k`, default 3): the candidate exceeds its peers' mean by more
 *     than `k` population standard deviations.
 *   * `minimumPeers` (default 3): with fewer peers than this there is no
 *     distribution to be an outlier *from*, and nothing is excluded — the
 *     caller reports `too_few_peers` rather than guessing.
 */
export interface OneOffThresholds {
  readonly medianMultiple: Rational;
  readonly sigma: Rational;
  readonly minimumPeers: number;
}

/**
 * **The rule: an observation is a one-off when it clears BOTH thresholds
 * against its peers — every other surviving observation in its own series —
 * and the test is repeated, largest first, until nothing clears.**
 *
 * The dispatch writes "more than `k` standard deviations above the trailing
 * distribution, *or* exceeding a stated multiple of the median". Each half
 * alone fails on data this derivation will see, which is why they are a
 * conjunction here:
 *
 *   * **σ alone, with the candidate in the distribution, cannot fire on small
 *     samples.** A single outlier inflates the σ it is measured against; by
 *     Samuelson's inequality no point among `n` can sit more than `√(n − 1)`
 *     population standard deviations from their mean, so with ten or fewer
 *     observations nothing is ever more than 3σ out. Twelve monthly $500
 *     transfers plus one $40,000 house deposit is `n = 13` and z = √12 ≈ 3.46
 *     — the maximum possible, a pass that four fewer months of data would lose.
 *   * **σ alone, leave-one-out, fires on noise.** Twelve identical $500
 *     payroll deferrals have σ = 0, so the thirteenth at $520 after a raise is
 *     infinitely many σ out. A raise is not a one-off.
 *   * **The median multiple alone ignores spread.** A holder whose monthly
 *     transfers genuinely run $200–$1,500 would have every month above $1,200
 *     struck as a one-off at `m = 4` from a $300 median.
 *
 * Together, leave-one-out: the median multiple is the magnitude test (robust,
 * meaningful at `n = 4`), and σ is the "is this unlike its peers" test — which
 * the $520 raise clears and the median multiple stops. Setting `k = '0'`
 * degenerates to the median test alone and `m = '0'` to the σ test alone, so
 * either reading of the dispatch is one parameter away.
 *
 * **Largest first, repeated**, so two one-offs cannot mask each other: a $40k
 * and a $30k in the same year each inflate the other's peer σ, and testing both
 * against the same peers passes neither. Only the maximum is tested each round:
 * a smaller value's peers include the larger one, which can only raise the
 * median it must clear by `m×`, so when the maximum fails the median test
 * everything below it fails too; when the maximum fails only the σ test the
 * loop stops there by rule, which errs in the conservative direction — a real
 * observation kept, never a real one struck.
 *
 * Both tests are exact integer inequalities, never a float compare:
 *
 *     x > m·median          ⇔  2·x·m_den > m_num · (2·median)
 *     x − μ > k·σ           ⇔  d > 0  ∧  d²·k_den² > k_num²·V
 *         where  d = n′·x − S,  V = n′·Q − S²,
 *                S = Σ peers,   Q = Σ peers²,   n′ = peer count
 *
 * (`V / n′²` is the population variance of the peers; multiplying the σ test
 * through by `n′` removes every division.)
 */
export interface OneOffEvidence {
  readonly peerCount: number;
  /** `2 × median(peers)`, exact. */
  readonly peerTwiceMedian: bigint;
  readonly peerSum: bigint;
  /** `n′·Q − S²` — `n′²` times the population variance. */
  readonly peerScaledVariance: bigint;
  /** `n′·x − S` — `n′` times the distance above the peer mean. */
  readonly scaledDeviation: bigint;
}

export interface OneOffVerdict<T> {
  readonly kept: readonly T[];
  readonly excluded: readonly { readonly item: T; readonly evidence: OneOffEvidence }[];
  /** `false` when the series never had `minimumPeers` peers to be judged against. */
  readonly judged: boolean;
}

function peerEvidence(candidate: bigint, peers: readonly bigint[]): OneOffEvidence {
  let sum = 0n;
  let squares = 0n;
  for (const value of peers) {
    sum += value;
    squares += value * value;
  }
  const count = BigInt(peers.length);
  return {
    peerCount: peers.length,
    peerTwiceMedian: twiceMedian(peers),
    peerSum: sum,
    peerScaledVariance: count * squares - sum * sum,
    scaledDeviation: count * candidate - sum,
  };
}

/** The two exact inequalities, conjoined. Exported so a test can state them independently. */
export function clearsOneOffThresholds(
  candidate: bigint,
  evidence: OneOffEvidence,
  thresholds: OneOffThresholds,
): boolean {
  const { medianMultiple: m, sigma: k } = thresholds;
  const aboveMedianMultiple =
    2n * candidate * m.denominator > m.numerator * evidence.peerTwiceMedian;
  const d = evidence.scaledDeviation;
  const aboveSigma =
    d > 0n &&
    d * d * k.denominator * k.denominator > k.numerator * k.numerator * evidence.peerScaledVariance;
  return aboveMedianMultiple && aboveSigma;
}

/**
 * Split one series into what is kept and what is a one-off.
 *
 * `order` breaks ties among equal amounts so the choice of *which* of two
 * identical maxima is tested first — and therefore named — never depends on
 * input order.
 */
export function separateOneOffs<T>(
  items: readonly T[],
  minorOf: (item: T) => bigint,
  order: (a: T, b: T) => number,
  thresholds: OneOffThresholds,
): OneOffVerdict<T> {
  const remaining = [...items].sort((a, b) => {
    const left = minorOf(a);
    const right = minorOf(b);
    if (left !== right) return left > right ? -1 : 1;
    return order(a, b);
  });
  const excluded: { item: T; evidence: OneOffEvidence }[] = [];
  const judged = remaining.length - 1 >= thresholds.minimumPeers;
  while (remaining.length - 1 >= thresholds.minimumPeers) {
    const candidate = remaining[0] as T;
    const peers = remaining.slice(1).map(minorOf);
    const evidence = peerEvidence(minorOf(candidate), peers);
    if (!clearsOneOffThresholds(minorOf(candidate), evidence, thresholds)) break;
    excluded.push({ item: candidate, evidence });
    remaining.shift();
  }
  return { kept: remaining.sort(order), excluded, judged };
}
