// SPDX-License-Identifier: MIT
/**
 * The aggregate: one day, every account, four independent totals.
 *
 * This is the function the §5 exit criterion reconciles against a hand
 * computation — `'net worth reconciles to a hand computation across every
 * account type including a manual asset and a liability'`. It is deliberately
 * pure over its ports: no clock of its own beyond the date it is handed, no
 * database handle, no knowledge of `net_worth_daily`. `src/store.ts` persists
 * what it returns and `src/seal.ts` decides when that becomes history.
 *
 * ## The four booleans are summed four times, never derived from each other
 *
 * 07 §4.1 names `on_budget`, `in_net_worth`, `is_liquid` and `is_investable`
 * and says they are independent. The temptation — and the bug — is to write
 * `liquid = assets - investments`, which is true for the account roster you
 * happen to have in front of you and false the moment somebody adds a money
 * market fund or an off-budget cash account. So each total below is its own
 * filtered sum over its own flag, and `'the four account booleans are
 * independent'` is a property test over all sixteen combinations rather than an
 * example.
 *
 * `assets_minor` and `liabilities_minor` are the `in_net_worth` denominator
 * split by the account's *side*, which is a property of the account and never of
 * the sign of its balance. An overdrawn checking account is an asset account
 * with a negative contribution; an overpaid credit card is a liability account
 * with a positive one. Both keep their side.
 *
 * ## Which accounts get a number, and which get counted instead
 *
 * An account in net worth that cannot be valued at all — no balance ever
 * reported, no priced holding — is **not** zero. It is counted in
 * `accountsUnvalued` and left out of every total, because "net worth is $X
 * across 9 of 11 accounts" and "net worth is $X" are different claims and the
 * UI has to be able to tell them apart. A zero would make them the same claim,
 * and the wrong one.
 *
 * ## FX
 *
 * Every account is converted through `src/fx.ts` even when its currency already
 * *is* the base currency: the identity conversion goes through the same code
 * path, records `fxRate: '1'` with a date, and so leaves a breakdown in which
 * every entry has the same shape. A `null` fxRate for domestic accounts would be
 * a second case for every reader downstream to get wrong.
 */
import { Quantity, parseDateOnly } from '@core/kernel';
import { convertToBase } from './fx.ts';
import {
  INTERPOLATION_POLICY,
  interpolateQuantity,
  backfillByTransactionSubtraction,
  type InterpolationMethod,
} from './interpolate.ts';
import type { AccountFlags, PlanningAccount, SnapshotPorts } from './ports.ts';

/** How an account's native amount for the day was arrived at. */
export type ValuationMethod =
  'observed' | 'transaction_subtraction' | 'quantity_times_price' | 'carry_forward';

/**
 * One account's line in the day's breakdown.
 *
 * The first ten fields are exactly what `net_worth_breakdown_is_well_formed`
 * (migration 0017) requires, in the JSON shape it requires: minor units and the
 * rate as **strings**, because a JSON number silently rounds a BIGINT past 2^53
 * and D3 does not stop being true at the serialisation boundary. The rest is
 * provenance the CHECK does not police but an audit needs.
 */
export interface BreakdownEntry {
  readonly accountId: string;
  readonly currency: string;
  readonly nativeMinor: string;
  readonly baseMinor: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly onBudget: boolean;
  readonly inNetWorth: boolean;
  readonly isLiquid: boolean;
  readonly isInvestable: boolean;
  /** `asset` or `liability`, as the account was classified that day. */
  readonly side: 'asset' | 'liability';
  readonly kind: string;
  readonly valuation: ValuationMethod;
  /** 08 §3.7: this account's number rests on a price the clock or the ladder calls stale. */
  readonly stalePrice: boolean;
  /** For an interpolated investment position: the observations it sits between. */
  readonly between?: readonly string[];
}

/** An in-net-worth account that could not be valued, and the honest reason. */
export interface UnvaluedAccount {
  readonly accountId: string;
  readonly reason: 'no_balance' | 'no_priced_holding' | 'no_earlier_observation';
}

/** The whole day, ready for `net_worth_daily`. */
export interface NetWorthSnapshot {
  readonly asOfDate: string;
  readonly baseCurrency: string;
  readonly assetsMinor: bigint;
  readonly liabilitiesMinor: bigint;
  readonly netWorthMinor: bigint;
  readonly liquidMinor: bigint;
  readonly investableMinor: bigint;
  readonly onBudgetMinor: bigint;
  readonly breakdown: readonly BreakdownEntry[];
  readonly source: 'observed' | 'interpolated';
  readonly stalePrice: boolean;
  readonly accountsCounted: number;
  readonly accountsUnvalued: number;
  readonly unvalued: readonly UnvaluedAccount[];
}

export interface ComputeInput {
  readonly userId: string;
  readonly asOfDate: string;
  readonly baseCurrency: string;
}

/**
 * Compute one day.
 *
 * @throws {FxRateUnavailable} — propagated from `src/fx.ts`, never caught here.
 *   A day missing one account's conversion is not written at all; 08 §6.6's
 *   manual-rate affordance is the intended resolution and a 1.0 is not.
 * @throws {InterpolationRefused} when an account class is reconstructed by a
 *   path that cannot be honest about it (04 §5.4).
 */
export async function computeNetWorth(
  ports: SnapshotPorts,
  input: ComputeInput,
): Promise<NetWorthSnapshot> {
  const baseCurrency = input.baseCurrency.trim().toUpperCase();
  // Parse for its side effect: a malformed date must fail here, with the date in
  // the message, rather than three layers down inside a port's SQL.
  parseDateOnly(input.asOfDate);

  const accounts = await ports.balances.accounts(input.userId, input.asOfDate);

  const breakdown: BreakdownEntry[] = [];
  const unvalued: UnvaluedAccount[] = [];

  for (const account of accounts) {
    if (isClosedBy(account, input.asOfDate)) continue;

    const valued = await valueAccount(ports, account, input);
    if (valued === null) {
      // Only an account that was *supposed* to count is a hole worth reporting.
      // An excluded account with no balance is not missing; it is excluded.
      if (account.flags.inNetWorth) {
        unvalued.push({ accountId: account.accountId, reason: reasonFor(account) });
      }
      continue;
    }

    const converted = await convertToBase(ports.fx, {
      nativeMinor: valued.nativeMinor,
      currency: account.currency,
      baseCurrency,
      date: input.asOfDate,
    });

    breakdown.push({
      accountId: account.accountId,
      currency: converted.currency,
      nativeMinor: converted.nativeMinor.toString(),
      baseMinor: converted.baseMinor.toString(),
      fxRate: converted.fxRate,
      fxRateDate: converted.fxRateDate,
      onBudget: account.flags.onBudget,
      inNetWorth: account.flags.inNetWorth,
      isLiquid: account.flags.isLiquid,
      isInvestable: account.flags.isInvestable,
      side: account.side,
      kind: account.kind,
      valuation: valued.valuation,
      stalePrice: valued.stalePrice,
      ...(valued.between === undefined ? {} : { between: valued.between }),
    });
  }

  // Sorted by account id so that two runs over the same facts produce the same
  // JSONB byte-for-byte. The seal's byte-identity test would otherwise be a test
  // of `Map` iteration order, which is a property of the runtime and not of this
  // system.
  breakdown.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

  const sumWhere = (predicate: (entry: BreakdownEntry) => boolean): bigint =>
    breakdown.reduce(
      (total, entry) => (predicate(entry) ? total + BigInt(entry.baseMinor) : total),
      0n,
    );

  const assetsMinor = sumWhere((entry) => entry.inNetWorth && entry.side === 'asset');
  // Negated, so that `net = assets - liabilities` holds with a liability's
  // signed contribution stored as the negative number it is.
  const liabilitiesMinor = -sumWhere((entry) => entry.inNetWorth && entry.side === 'liability');

  return {
    asOfDate: input.asOfDate,
    baseCurrency,
    assetsMinor,
    liabilitiesMinor,
    netWorthMinor: assetsMinor - liabilitiesMinor,
    // Four filters, four flags, no arithmetic between them (07 §4.1).
    liquidMinor: sumWhere((entry) => entry.isLiquid),
    investableMinor: sumWhere((entry) => entry.isInvestable),
    onBudgetMinor: sumWhere((entry) => entry.onBudget),
    breakdown,
    source: breakdown.every((entry) => entry.valuation === 'observed')
      ? 'observed'
      : 'interpolated',
    stalePrice: breakdown.some((entry) => entry.stalePrice),
    accountsCounted: breakdown.length,
    accountsUnvalued: unvalued.length,
    unvalued,
  };
}

// ---------------------------------------------------------------------------

interface ValuedAccount {
  readonly nativeMinor: bigint;
  readonly valuation: ValuationMethod;
  readonly stalePrice: boolean;
  readonly between?: readonly string[];
}

/**
 * One account's native amount for the day, by the method its class allows.
 *
 * The `switch` is over `INTERPOLATION_POLICY[kind]` rather than over `kind`
 * itself, deliberately: the policy table is the single statement of 04 §5.4's
 * rule, and a new account class therefore has to declare a method there before
 * it can be valued at all, instead of silently falling into whichever branch
 * came last.
 */
async function valueAccount(
  ports: SnapshotPorts,
  account: PlanningAccount,
  input: ComputeInput,
): Promise<ValuedAccount | null> {
  const method: InterpolationMethod = INTERPOLATION_POLICY[account.kind];

  if (method === 'quantity_times_price') {
    return valueByQuantityTimesPrice(ports, account, input);
  }

  const observation = await ports.balances.balanceOnOrBefore(
    input.userId,
    account.accountId,
    input.asOfDate,
  );
  if (observation === null) return null;

  if (observation.date === input.asOfDate) {
    return { nativeMinor: observation.currentMinor, valuation: 'observed', stalePrice: false };
  }

  if (method === 'carry_forward') {
    // A manual asset: the user's last stated value stands. `interpolated` at the
    // row level, because the day was not observed — the label is about the day,
    // not about how much confidence the number deserves.
    return { nativeMinor: observation.currentMinor, valuation: 'carry_forward', stalePrice: false };
  }

  // The observation is *later* than the day we want whenever the ledger has
  // nothing older, which is the ordinary case when a provider backfills 90 days
  // of transactions and one current balance. That is exactly 04 §5.4's backfill.
  const knownIsAfter = observation.date > input.asOfDate;
  if (!knownIsAfter) {
    // An older observation and no newer one: nothing to subtract our way back
    // through, so carrying it forward is the only honest answer for a cash
    // account too. Labelled as what it is rather than as `observed`.
    return { nativeMinor: observation.currentMinor, valuation: 'carry_forward', stalePrice: false };
  }

  const nativeMinor = await backfillByTransactionSubtraction(
    {
      kind: account.kind,
      userId: input.userId,
      accountId: account.accountId,
      knownDate: observation.date,
      knownMinor: observation.currentMinor,
      targetDate: input.asOfDate,
    },
    (userId, accountId, date) => ports.balances.transactionsTotalOn(userId, accountId, date),
  );
  return { nativeMinor, valuation: 'transaction_subtraction', stalePrice: false };
}

/**
 * An investment account: Σ over positions of quantity x price (04 §5.4).
 *
 * Note what this function never touches: `transactionsTotalOn`. The recording
 * port in `test/interpolation.test.ts` fails the run if it is called for an
 * investment account, which is a stronger claim than "the policy table says so"
 * — a policy table can be consulted and then ignored.
 *
 * A position with no price at all contributes nothing and makes the account
 * unvalued only if *no* position could be priced; a partially priced account is
 * valued on what could be priced and flagged. 08 §3.7 requires the day to seal
 * either way.
 */
async function valueByQuantityTimesPrice(
  ports: SnapshotPorts,
  account: PlanningAccount,
  input: ComputeInput,
): Promise<ValuedAccount | null> {
  const positions = await ports.holdings.positionsOnOrBefore(
    input.userId,
    account.accountId,
    input.asOfDate,
  );
  if (positions.length === 0) return null;

  let totalMinor = 0n;
  let stalePrice = false;
  let priced = 0;
  let anyInterpolated = false;
  const between = new Set<string>();

  for (const position of positions) {
    const bracket = await ports.holdings.bracketingObservations(
      input.userId,
      account.accountId,
      position.securityId,
      input.asOfDate,
    );
    const quantity = interpolateQuantity(input.asOfDate, bracket.before, bracket.after);
    if (quantity === null) continue;
    if (quantity.label !== 'observed') {
      anyInterpolated = true;
      for (const day of quantity.between) between.add(day);
    }

    const quote = await ports.prices.price(position.securityId, input.asOfDate, account.currency);
    if (quote === null) continue;

    // 08 §3.7's two independent staleness signals. `rung === 'last_known'` means
    // the ladder had no observation for the day and carried one forward;
    // `staleness === 'STALE'` means 07 §6.1's 24-hour clock rule fired. Either
    // one flags the day; neither one stops it sealing.
    if (quote.staleness === 'STALE' || quote.rung === 'last_known' || quote.carriedForward) {
      stalePrice = true;
    }

    // quantity x close, in minor units of the account's currency. Exact decimal
    // throughout: `Quantity.multiply` is decimal.js, and the single rounding to
    // minor units happens once, at the end, rather than per position.
    const value = Quantity.multiply(Quantity.of(quantity.quantity), Quantity.of(quote.close));
    totalMinor += toMinorUnits(value);
    priced += 1;
  }

  if (priced === 0) return null;

  return {
    nativeMinor: totalMinor,
    valuation: anyInterpolated ? 'quantity_times_price' : 'observed',
    stalePrice,
    ...(between.size === 0 ? {} : { between: [...between].sort() }),
  };
}

/**
 * A decimal major-unit string to minor units, half-up away from zero.
 *
 * Two-decimal minor units: every currency this app handles today is
 * `minorUnitScale` 2, and a security priced in a zero-decimal currency would
 * need the account's currency scale threading through the ports, which is a
 * change worth making when there is one rather than a parameter nobody passes.
 * The rounding is applied once per position rather than once per share, which is
 * where a naive implementation loses a cent per lot.
 */
function toMinorUnits(major: string): bigint {
  const negative = major.startsWith('-');
  const digits = negative ? major.slice(1) : major;
  const [whole = '0', fraction = ''] = digits.split('.');
  const padded = `${fraction}00`.slice(0, 3);
  const scaled = BigInt(whole) * 1000n + BigInt(padded === '' ? '0' : padded);
  const rounded = (scaled + 5n) / 10n;
  return negative ? -rounded : rounded;
}

function isClosedBy(account: PlanningAccount, asOfDate: string): boolean {
  if (account.closedAt === null) return false;
  return account.closedAt.toISOString().slice(0, 10) <= asOfDate;
}

function reasonFor(account: PlanningAccount): UnvaluedAccount['reason'] {
  return INTERPOLATION_POLICY[account.kind] === 'quantity_times_price'
    ? 'no_priced_holding'
    : 'no_balance';
}

/** Re-exported so a caller can talk about the flags without a second import. */
export type { AccountFlags };
