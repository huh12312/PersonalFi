// SPDX-License-Identifier: MIT
/**
 * How a day that was never observed gets a number, per account class.
 *
 * 04 §5.4 gives the general backfill — `balance(d-1) = balance(d) - Σ txns(d)`
 * — and then takes it away again for one class:
 *
 * > investment accounts cannot be reconstructed that way ... they are rebuilt
 * > from quantity x price with labeled linear interpolation between observations
 *
 * The reason is worth stating because it is not obvious. Transaction
 * subtraction assumes every change in the balance is a transaction. For a
 * checking account that is true by construction: money only moves in or out. For
 * a brokerage account it is false on most days — the balance moved because the
 * market moved, and no transaction exists to subtract. Running the cash path
 * over a brokerage account therefore produces a history in which the portfolio
 * never changed value except on the days something was bought, which is a
 * confident, smooth, completely fictitious line.
 *
 * So the policy is a *table*, `INTERPOLATION_POLICY`, and the cash path
 * (`backfillByTransactionSubtraction`) refuses by name when handed an account
 * whose policy is not its own. `'an investment account is never backfilled by
 * the transaction-subtraction path'` tests both halves: the direct refusal, and
 * a whole snapshot run over a recording port that fails if
 * `transactionsTotalOn` is so much as *called* for an investment account.
 */
import { DateOnly, Quantity, parseDateOnly } from '@core/kernel';
import type { AccountKind, HoldingObservation } from './ports.ts';

/** Raised when a reconstruction is attempted by a path that cannot be honest about it. */
export class InterpolationRefused extends Error {
  override readonly name = 'InterpolationRefused';
  readonly accountKind: AccountKind;
  readonly attemptedMethod: InterpolationMethod;

  constructor(accountKind: AccountKind, attemptedMethod: InterpolationMethod, why: string) {
    super(
      `a ${accountKind} account may not be reconstructed by ${attemptedMethod}: ${why} ` +
        `(04 §5.4). The policy for this class is ${INTERPOLATION_POLICY[accountKind]}.`,
    );
    this.accountKind = accountKind;
    this.attemptedMethod = attemptedMethod;
  }
}

export const INTERPOLATION_METHODS = [
  'transaction_subtraction',
  'quantity_times_price',
  'carry_forward',
] as const;
export type InterpolationMethod = (typeof INTERPOLATION_METHODS)[number];

/**
 * One row per account class, and no `default:` anywhere that reads it.
 *
 *   * **cash / credit / loan** — every balance change is a transaction, so
 *     04 §5.4's subtraction is exact rather than approximate. A credit card and
 *     a mortgage are included for the same reason a checking account is: a
 *     statement balance moves when a charge posts or a payment lands, and
 *     interest accrual is itself a posted transaction.
 *   * **investment** — rebuilt from quantity x price. Never subtraction.
 *   * **manual_asset** — a house, a car, a painting. There are no transactions
 *     to subtract and no market to price it against; the user's last stated
 *     value stands until they state another. Carrying it forward is not a guess,
 *     it is the only claim anybody has made.
 *   * **other** — carried forward for the same reason, conservatively: an
 *     account class we cannot name is one we should not invent a method for.
 */
export const INTERPOLATION_POLICY: Readonly<Record<AccountKind, InterpolationMethod>> =
  Object.freeze({
    cash: 'transaction_subtraction',
    credit: 'transaction_subtraction',
    loan: 'transaction_subtraction',
    investment: 'quantity_times_price',
    manual_asset: 'carry_forward',
    other: 'carry_forward',
  });

export function methodFor(kind: AccountKind): InterpolationMethod {
  return INTERPOLATION_POLICY[kind];
}

/**
 * 04 §5.4's backfill, one day at a time: `balance(d-1) = balance(d) - Σ txns(d)`.
 *
 * Walks *backwards* from a known observation to an earlier target date, peeling
 * off each day's transactions as it goes. Stepping rather than summing the whole
 * window in one go is what makes it usable for a series — the caller gets every
 * intermediate day, and the calendar spine has one for each.
 *
 * @throws {InterpolationRefused} for any account class whose policy is not
 *   `transaction_subtraction`. This is the guard the §5 test sabotages.
 */
export async function backfillByTransactionSubtraction(
  input: {
    readonly kind: AccountKind;
    readonly userId: string;
    readonly accountId: string;
    /** The observation to walk back from. */
    readonly knownDate: string;
    readonly knownMinor: bigint;
    /** The earlier date wanted. Must not be after `knownDate`. */
    readonly targetDate: string;
  },
  transactionsTotalOn: (userId: string, accountId: string, date: string) => Promise<bigint>,
): Promise<bigint> {
  if (INTERPOLATION_POLICY[input.kind] !== 'transaction_subtraction') {
    throw new InterpolationRefused(
      input.kind,
      'transaction_subtraction',
      'its balance moves for reasons no transaction records, so subtracting transactions ' +
        'would produce a flat line through a moving market and label it observed',
    );
  }

  const known = parseDateOnly(input.knownDate);
  const target = parseDateOnly(input.targetDate);
  if (DateOnly.isAfter(target, known)) {
    throw new InterpolationRefused(
      input.kind,
      'transaction_subtraction',
      `the target date ${input.targetDate} is after the known observation ${input.knownDate}; ` +
        'this path only ever walks backwards, because a future balance is a projection ' +
        'and projections are not snapshots',
    );
  }

  let minor = input.knownMinor;
  // Peel off the transactions of `knownDate`, then of the day before, and so on
  // down to — but not including — `targetDate`: the balance *on* the target day
  // is the one after that day's transactions have posted.
  for (let day = known; DateOnly.isAfter(day, target); day = DateOnly.addDays(day, -1)) {
    minor -= await transactionsTotalOn(input.userId, input.accountId, day);
  }
  return minor;
}

/** A quantity, and an honest word for where it came from. */
export interface InterpolatedQuantity {
  readonly quantity: string;
  readonly label: 'observed' | 'interpolated' | 'carried_forward';
  /** The observations the answer rests on, for the evidence trail. */
  readonly between: readonly string[];
}

/**
 * 04 §5.4's *labelled* linear interpolation between two holdings observations.
 *
 * Three cases, three labels, and the label is never omitted:
 *
 *   * an observation on the day itself → `observed`;
 *   * observations either side → `interpolated`, straight-line on the share
 *     count between them;
 *   * only an earlier observation → `carried_forward`, because a position you
 *     have not been told about is a position you still hold.
 *
 * Interpolating the *quantity* and then pricing it — rather than interpolating
 * the *value* — is the difference between "we think you held 12.4 shares" and
 * "we think your account was worth $X". The first can be checked against a
 * statement; the second cannot be checked against anything.
 */
export function interpolateQuantity(
  date: string,
  before: HoldingObservation | null,
  after: HoldingObservation | null,
): InterpolatedQuantity | null {
  if (before !== null && before.asOfDate === date) {
    return { quantity: before.quantity, label: 'observed', between: [before.asOfDate] };
  }
  if (before === null) {
    // Nothing before the date. An *after*-only observation is deliberately not
    // extrapolated backwards: "you held 10 shares on the 20th" says nothing
    // about the 10th, and a position the user had not opened yet would be
    // invented out of a later fact.
    return null;
  }
  if (after === null) {
    return { quantity: before.quantity, label: 'carried_forward', between: [before.asOfDate] };
  }

  const start = parseDateOnly(before.asOfDate);
  const end = parseDateOnly(after.asOfDate);
  const at = parseDateOnly(date);
  const span = DateOnly.differenceInDays(start, end);
  if (span <= 0) {
    return { quantity: before.quantity, label: 'carried_forward', between: [before.asOfDate] };
  }

  const elapsed = DateOnly.differenceInDays(start, at);
  // q(t) = q0 + (q1 - q0) * elapsed / span, in exact decimal. `Quantity` is
  // decimal.js underneath, so no share count is ever an IEEE-754 double — D3
  // again, and a fractional crypto position is where it would first show.
  const from = Quantity.of(before.quantity);
  const delta = Quantity.subtract(Quantity.of(after.quantity), from);
  const fraction = Quantity.divide(Quantity.of(String(elapsed)), Quantity.of(String(span)));
  const quantity = Quantity.add(from, Quantity.multiply(delta, fraction));

  return {
    quantity,
    label: 'interpolated',
    between: [before.asOfDate, after.asOfDate],
  };
}
