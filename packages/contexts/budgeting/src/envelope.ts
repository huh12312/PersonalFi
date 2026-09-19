// SPDX-License-Identifier: MIT
/**
 * The envelope math, transcribed from 07 §1.2–1.8 and pure over `Money`.
 *
 * Nothing in this file touches a database, a clock or a port. That is not
 * tidiness: the invariant this whole work package exists to protect —
 * `Σ available + RTA + future assignments = Σ on-budget balances` — is an
 * arithmetic claim, and an arithmetic claim is only testable at the speed and
 * exhaustiveness a `fast-check` property needs if the arithmetic has no
 * dependencies. `src/envelope.test.ts` runs in the `budgeting` project with no
 * Postgres in the loop for exactly that reason.
 *
 * ## The normative math, quoted
 *
 * 07 §1.2 lines 59–63:
 *
 * ```
 * assigned(c, p)   = Σ budget_entry.amount WHERE category=c AND period=p
 * activity(c, p)   = Σ txn.amount          WHERE category=c AND budget_date ∈ p # outflows negative
 * carryover(c, p)  = rollover_fn(available(c, p-1), c.rollover_policy)
 * available(c, p)  = carryover(c, p) + assigned(c, p) + activity(c, p)
 * ```
 *
 * 07 §1.2 lines 67–71:
 *
 * ```
 * ROLLOVER  (default for envelope):  prev >= 0 ? prev : 0     # negative handled by §1.3
 * RESET     (target-only mode):      0
 * ROLLOVER_ALLOW_NEGATIVE (advanced): prev                    # debt-like categories only
 * ```
 *
 * ## Every number here is a `bigint`
 *
 * `Money` is `{ minor: bigint, currency }` and there is no path in this file
 * that produces one from a `number`. The two places a non-integer legitimately
 * appears are `goalPercent` (`PCT_OF_INCOME`) and the alert `ratio`, and both
 * are decimal **strings**: `Money.multiplyByDecimal` takes a string and refuses
 * a `number` precisely because `0.1 * 3` is the bug that design prevents. The
 * evidence note names every boundary.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { GoalType, RolloverPolicy } from '../schema/index.ts';

/**
 * How a transaction's money actually moved, which 07 §1.3 opens by calling "the
 * distinction most clones get wrong": `CASH` means a depository account is
 * already lighter, `CREDIT` means you borrowed.
 */
export type FundingSource = 'CASH' | 'CREDIT';

/** One transaction as the envelope math sees it. Ordered, signed, already netted. */
export interface EnvelopeTransaction {
  readonly id: string;
  /** Sorted on by the caller; ties break on `id` so a recompute is deterministic. */
  readonly budgetDate: string;
  /** House convention: negative = outflow, positive = inflow. */
  readonly amount: MoneyType;
  readonly funding: FundingSource;
  /** The credit account this hit, for `CREDIT` rows. Null for cash. */
  readonly creditAccountId: string | null;
}

/**
 * `rollover_fn` — 07 §1.2 lines 67–71, verbatim.
 *
 * Total on purpose: a policy this does not recognise is a `TypeScript` error at
 * the call site rather than a silent `0` that loses a user's carryover.
 */
export function rolloverOut(available: MoneyType, policy: RolloverPolicy): MoneyType {
  switch (policy) {
    case 'ROLLOVER':
      return Money.max(available, Money.zero(available.currency));
    case 'RESET':
      return Money.zero(available.currency);
    case 'ROLLOVER_ALLOW_NEGATIVE':
      return available;
  }
}

/**
 * The half `rollover_fn` threw away.
 *
 * `available = rolloverOut + absorbedByRta` is a `CHECK` on the `rollovers`
 * table, so this is not a convenience — it is the other side of a constraint the
 * database will refuse a write without. See that table's header for why the
 * absorbed half is *recorded* rather than subtracted from the next period's RTA:
 * RTA comes from the balance-sheet identity and already reflects it, and
 * applying it again would double-count.
 */
export function absorbedByRta(available: MoneyType, policy: RolloverPolicy): MoneyType {
  return Money.subtract(available, rolloverOut(available, policy));
}

export interface AvailableInput {
  readonly carryover: MoneyType;
  readonly assigned: MoneyType;
  readonly activity: MoneyType;
}

/** 07 §1.2 line 62. The whole of it. */
export function available(input: AvailableInput): MoneyType {
  return Money.add(Money.add(input.carryover, input.assigned), input.activity);
}

// ---------------------------------------------------------------------------
// 07 §1.3 — overspending, cash versus credit
// ---------------------------------------------------------------------------

/**
 * What one period of transactions did to one envelope.
 *
 * `cashOverspend + creditOverspend = |min(available, 0)|` always, which is also
 * a `CHECK` on `budget_lines`. That identity is what lets the UI render one
 * number red and the other yellow without re-deriving anything, and what makes a
 * funding rule that loses a cent fail on the first write rather than on the
 * first month-end nobody reconciles.
 */
export interface EnvelopeResult {
  readonly available: MoneyType;
  readonly activity: MoneyType;
  readonly cashActivity: MoneyType;
  readonly creditActivity: MoneyType;
  readonly outflow: MoneyType;
  readonly inflow: MoneyType;
  readonly cashOverspend: MoneyType;
  readonly creditOverspend: MoneyType;
  /**
   * Per credit account: how much envelope money this category moved into that
   * card's `CCP` line, and how much it borrowed with nothing behind it.
   *
   * 07 §1.3: `fundable = min(|txn.amount|, max(0, available(c, p)))` — "only the
   * funded part moves". A category with $30 left that puts $50 on a card funds
   * $30 and borrows $20; it does not fund $50 it does not have.
   */
  readonly cardEffects: readonly CardEffect[];
}

export interface CardEffect {
  readonly creditAccountId: string;
  /** Envelope money that moved into `CCP[card]`. Non-negative. */
  readonly funded: MoneyType;
  /** Borrowed with no envelope behind it. Non-negative. */
  readonly borrowed: MoneyType;
  /** Refunds and other inflows landing on the card. Non-negative. */
  readonly returned: MoneyType;
}

/**
 * Run one period of one envelope, in transaction order.
 *
 * Order matters and is therefore fixed: `(budgetDate, id)`. 07 §1.3's funding
 * rule reads `available(c, p)` *as it stands when the transaction lands*, so two
 * different orderings of the same set genuinely produce different splits between
 * "funded" and "borrowed" — $30 available, a $50 charge and a $40 charge fund
 * $30 then $0 in one order and $30 then $0 in the other, but $30 available with
 * a $50 charge and a $40 refund funds $30 or $50 depending which came first.
 * Sorting here rather than trusting the caller is what stops a recompute from
 * silently disagreeing with the recompute before it.
 *
 * ### Why the credit overspend is clamped at the end
 *
 * A category can borrow $20 in week one and receive a $20 paycheque refund in
 * week three. The running tally has seen a $20 overspend; the closing
 * `available` is $0. Reporting a $20 credit overspend against a $0 shortfall
 * would break `|min(available,0)| = cash + credit` — so the running tally is an
 * upper bound and the final answer is `min(runningCreditOverspend, shortfall)`,
 * with the remainder attributed to cash. Inflows *on the card itself* repay the
 * borrowing directly (07 §1.3's `on_refund`), which is the common case and is
 * handled in the loop rather than by the clamp.
 */
export function runEnvelope(
  opening: MoneyType,
  transactions: readonly EnvelopeTransaction[],
): EnvelopeResult {
  const code = opening.currency;
  const zero = Money.zero(code);

  const ordered = [...transactions].sort((a, b) =>
    a.budgetDate === b.budgetDate
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.budgetDate < b.budgetDate
        ? -1
        : 1,
  );

  let running = opening;
  let activity = zero;
  let cashActivity = zero;
  let creditActivity = zero;
  let outflow = zero;
  let inflow = zero;
  let borrowedRunning = zero;

  const cards = new Map<string, { funded: MoneyType; borrowed: MoneyType; returned: MoneyType }>();
  const cardOf = (id: string) => {
    const existing = cards.get(id);
    if (existing !== undefined) return existing;
    const fresh = { funded: zero, borrowed: zero, returned: zero };
    cards.set(id, fresh);
    return fresh;
  };

  for (const transaction of ordered) {
    const amount = transaction.amount;
    const magnitude = Money.absolute(amount);
    activity = Money.add(activity, amount);

    if (Money.isNegative(amount)) outflow = Money.add(outflow, magnitude);
    else inflow = Money.add(inflow, magnitude);

    if (transaction.funding === 'CASH') {
      cashActivity = Money.add(cashActivity, amount);
      running = Money.add(running, amount);
      continue;
    }

    creditActivity = Money.add(creditActivity, amount);
    const card = cardOf(transaction.creditAccountId ?? '');

    if (Money.isNegative(amount)) {
      // 07 §1.3: `fundable = min(|txn.amount|, max(0, available(c, p)))`.
      const headroom = Money.max(running, zero);
      const fundable = Money.min(magnitude, headroom);
      const borrowed = Money.subtract(magnitude, fundable);
      card.funded = Money.add(card.funded, fundable);
      card.borrowed = Money.add(card.borrowed, borrowed);
      borrowedRunning = Money.add(borrowedRunning, borrowed);
      running = Money.subtract(running, magnitude);
      continue;
    }

    // 07 §1.3 `on_refund`, category side: the envelope gets the money back, and
    // whatever it had borrowed is repaid first. Repaying here rather than
    // leaving it to the closing clamp is load-bearing — a category that borrows
    // $100, is refunded $100, and *then* overspends $50 in cash has a $50 **cash**
    // shortfall and must render red. Carrying the stale $100 of borrowing to the
    // clamp would attribute that $50 to credit and render it yellow, which tells
    // the user no cash has left the building when it has.
    //
    // The card side is deliberately not adjusted here: `returned` is reported
    // raw and `applyCardEffects` decides how much comes back out of `CCP[card]`
    // and how much retires unfunded debt, because only that layer knows what the
    // CCP envelope actually holds across periods.
    borrowedRunning = Money.subtract(borrowedRunning, Money.min(magnitude, borrowedRunning));
    card.returned = Money.add(card.returned, magnitude);
    running = Money.add(running, amount);
  }

  const shortfall = Money.absolute(Money.min(running, zero));
  const creditOverspend = Money.min(borrowedRunning, shortfall);
  const cashOverspend = Money.subtract(shortfall, creditOverspend);

  return {
    available: running,
    activity,
    cashActivity,
    creditActivity,
    outflow,
    inflow,
    cashOverspend,
    creditOverspend,
    cardEffects: [...cards.entries()].map(([creditAccountId, effect]) => ({
      creditAccountId,
      funded: effect.funded,
      borrowed: effect.borrowed,
      returned: effect.returned,
    })),
  };
}

// ---------------------------------------------------------------------------
// 07 §1.8 — sinking funds and goals
// ---------------------------------------------------------------------------

export interface GoalInput {
  readonly goalType: GoalType;
  readonly goalAmount: MoneyType | null;
  /** `TARGET_BY_DATE` only. Whole periods left including this one; `>= 1`. */
  readonly periodsRemainingInclusive: number;
  /** `PCT_OF_INCOME` only. A decimal **string**, `'0.1500'`, never a number. */
  readonly goalPercent: string | null;
  /** On-budget inflows landing in this period. `PCT_OF_INCOME`'s denominator. */
  readonly periodIncome: MoneyType;
  /** `carryover(c, p)` — what arrived before anyone assigned anything. */
  readonly carryover: MoneyType;
  /** `activity(c, p)` so far, signed. */
  readonly activity: MoneyType;
  /** Scheduled inflows 07 §1.8 subtracts from a `TARGET_BY_DATE` requirement. */
  readonly scheduledInflows: MoneyType;
  readonly currency: string;
}

/**
 * Divide `amount` by `parts`, rounding **away from zero**.
 *
 * `Money.allocate` splits a known total into shares that sum back to it; that is
 * not this operation. A `TARGET_BY_DATE` goal needs "how much per period, such
 * that `parts` of them reach the target" — and rounding that down leaves the
 * envelope one cent short on the target date, every time, for the whole life of
 * the goal. Rounding up over-funds the last period by at most `parts - 1` minor
 * units, which the user sees as the goal completing a day early rather than as a
 * sinking fund that never quite arrives.
 */
function divideRoundingUp(amount: MoneyType, parts: number): MoneyType {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`periodsRemainingInclusive must be a positive integer, got ${parts}`);
  }
  const divisor = BigInt(parts);
  const negative = amount.minor < 0n;
  const magnitude = negative ? -amount.minor : amount.minor;
  const share = (magnitude + divisor - 1n) / divisor;
  return Money.of(negative ? -share : share, amount.currency);
}

/**
 * `needed_this_period(c, p)` for all six goal types of 07 §1.8.
 *
 * The memo gives one of the six normatively (`TARGET_BY_DATE`, lines 221–222)
 * and names the other five. The five definitions below are this work package's,
 * chosen so that no two of them collapse into each other, and they are called
 * out as ours rather than as the memo's in
 * `docs/evidence/phase-2/wp2.1-budgeting.md` §1.4.
 */
export function neededThisPeriod(input: GoalInput): MoneyType {
  const zero = Money.zero(input.currency);
  const atLeastZero = (value: MoneyType) => Money.max(value, zero);

  switch (input.goalType) {
    case 'NONE':
      return zero;

    // "Put this much in, every period." The simplest goal and the one the
    // 50/30/20 generator writes.
    case 'MONTHLY_TARGET':
      return input.goalAmount ?? zero;

    // 07 §1.8 lines 221–222, verbatim:
    //   max(0, (target_amount - available(c,p) - scheduled_inflows) / periods_remaining_inclusive)
    // `available(c,p)` here is what the envelope holds *before* this period's
    // assignment — carryover plus activity — because the whole question the goal
    // answers is "how much must I assign".
    case 'TARGET_BY_DATE': {
      const target = input.goalAmount ?? zero;
      const held = Money.add(input.carryover, input.activity);
      const gap = atLeastZero(Money.subtract(Money.subtract(target, held), input.scheduledInflows));
      return divideRoundingUp(gap, Math.max(1, input.periodsRemainingInclusive));
    }

    // A floor maintained *after* spending: top the envelope back up to the
    // minimum given what this period has already taken out of it. An emergency
    // fund you keep at $1,000 and spent $200 from needs $200.
    case 'MINIMUM_BALANCE': {
      const target = input.goalAmount ?? zero;
      const held = Money.add(input.carryover, input.activity);
      return atLeastZero(Money.subtract(target, held));
    }

    // Refill to a ceiling at the *start* of the period, ignoring what happens
    // during it: a $400 grocery envelope that arrives holding $120 needs $280,
    // whether or not this period's shopping has happened yet. This is what
    // distinguishes it from MINIMUM_BALANCE, which would keep asking for more as
    // the month's spending lands.
    case 'REFILL_UP_TO': {
      const target = input.goalAmount ?? zero;
      return atLeastZero(Money.subtract(target, input.carryover));
    }

    // A share of what actually came in. `goalPercent` is a decimal string all
    // the way from `NUMERIC(7,4)` to `Money.multiplyByDecimal`; it never becomes
    // a `number`, so `0.15` of $1,234.56 is exact and not 185.18399999999997.
    case 'PCT_OF_INCOME': {
      if (input.goalPercent === null) return zero;
      return atLeastZero(
        Money.multiplyByDecimal(atLeastZero(input.periodIncome), input.goalPercent, 'half-even'),
      );
    }
  }
}

/** 07 §1.8 line 224: `underfunded(c, p) = max(0, needed_this_period - assigned)`. */
export function underfunded(needed: MoneyType, assigned: MoneyType): MoneyType {
  return Money.max(Money.subtract(needed, assigned), Money.zero(needed.currency));
}
