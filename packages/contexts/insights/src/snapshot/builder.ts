// SPDX-License-Identifier: MIT
/**
 * `SnapshotBuilder` — the single implementation point for data minimisation.
 *
 * 08 §4.2 asks for one assembler so that "minimisation has exactly one
 * implementation point". This is it, and the shape of the loop is the argument:
 *
 * ```
 * for (const scope of effectiveScopes) { ... }
 * ```
 *
 * It iterates **grants**, not sources. A scope the user never granted has no
 * code path at all — not a branch that skips it, not a key that is deleted
 * afterwards, no path. That is what `'an ungranted scope yields no key in the
 * snapshot'` asserts, and why it is a property of this file's control flow
 * rather than of a filter somewhere downstream.
 *
 * Three ceilings apply before the loop, in this order, and each one is a
 * different question:
 *
 *   1. **May an advisor of this kind hold the scope at all?**
 *      `scopesPermittedForKind` (`scopes.ts`). 08 §4.2 makes `transactions.raw`
 *      and `institutions.names` unreachable for `external`, and a grant row
 *      cannot buy past it — the ceiling is applied to the grant, so the
 *      *request* the advisor receives lists only what it actually got.
 *   2. **Did the user grant it?** The caller's `grantedScopes`, which comes from
 *      `snapshot_grants`.
 *   3. **Is there anything behind it in this phase?** `sourcedInPhase2`.
 *      `@ctx/investments` is Phase 3 and `@ctx/planning` is Phase 4, so
 *      `holdings.*`, `goals.list`, `risk.profile` and `market.watchlist` have no
 *      source. A granted-but-unsourced scope emits **no key**, exactly like an
 *      ungranted one — never an empty block, because an advisor cannot tell
 *      "empty" from "none" and would happily reason about zero.
 *
 * ## Minimisation is read from the catalogue, not written here
 *
 * `roundMonetaryToMinor`, `bucketAmounts`, `tokeniseMerchants` come off the
 * `ScopeDefinition` row. The functions below implement each lever once;
 * *whether* a lever applies to a block is data. Adding a scope is therefore a
 * row in `scopes.ts` plus a builder function, and getting the minimisation wrong
 * is a visible value in a reviewed table rather than a missing call.
 *
 * ## Derived figures obey the scope that sourced them
 *
 * `cash.summary.emergency_fund_months` is cash ÷ monthly expense. The expense
 * half is `cashflow.monthly`'s data, so the field is `null` unless
 * `cashflow.monthly` was *also* granted. Without that rule a user who granted
 * only `cash.summary` would still be telling the advisor their monthly burn,
 * one division later. The same reasoning applies to anything else that crosses
 * block boundaries, and this is the only place in the file that does.
 */
import { DateOnly, Money, minorUnitScale, type DateOnly as DateOnlyType } from '@core/kernel';
import {
  scopeDefinition,
  scopesPermittedForKind,
  SCOPE_CATALOGUE,
  type AdvisorKind,
  type AdvisorScope,
} from '../contract/scopes.ts';
import {
  AMOUNT_BUCKETS,
  type AdvisorSnapshot,
  type AmountBucket,
  type MoneyJson,
} from '../contract/snapshot.ts';
import type { SnapshotPorts } from './ports.ts';
import { createTokeniser, inputDigest, type Tokeniser } from './tokens.ts';

/** How much history each block asks for. Every one is a cap, never a target. */
export const SNAPSHOT_WINDOWS = Object.freeze({
  netWorthTrendMonths: 12,
  cashflowMonths: 24,
  transactionSummaryMonths: 12,
  topMerchants: 32,
  rawTransactionDays: 90,
  rawTransactionRows: 2000,
});

export interface BuildSnapshotInput {
  readonly userId: string;
  readonly kind: AdvisorKind;
  /** What `snapshot_grants` says. The per-kind ceiling is applied on top. */
  readonly grantedScopes: readonly AdvisorScope[];
  /** `todayIn(clock, timeZone)`. The builder never reads a clock. */
  readonly today: DateOnlyType;
  readonly baseCurrency: string;
  /** Per-user, from `deriveTokenKey`. Never a literal in a call site. */
  readonly tokenKey: string;
}

export interface BuiltSnapshot {
  readonly snapshot: AdvisorSnapshot;
  /** The grant after the per-kind ceiling. What the request declares. */
  readonly grantedScopes: readonly AdvisorScope[];
  /** The scopes that actually produced a key. A subset of the above. */
  readonly emittedScopes: readonly AdvisorScope[];
  /** `sha256:` over the canonical JSON of `snapshot`. */
  readonly inputDigest: string;
}

// ---------------------------------------------------------------------------
// The minimisation levers
// ---------------------------------------------------------------------------

/**
 * Round to a multiple of `step` minor units, half-even.
 *
 * Half-even because docs/CONVENTIONS.md says so and because a net-worth trend
 * rounded half-up drifts visibly upward over twelve points — a chart that
 * slopes because of its rounding is worse than one with no chart.
 */
export function roundToMultiple(minor: bigint, step: bigint): bigint {
  if (step <= 1n) return minor;
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const quotient = magnitude / step;
  const remainder = magnitude % step;
  const twice = remainder * 2n;
  let rounded = quotient;
  if (twice > step) rounded += 1n;
  else if (twice === step && quotient % 2n === 1n) rounded += 1n;
  const result = rounded * step;
  return negative ? -result : result;
}

/** `Money` → the wire's `{ minor, currency }`, rounded per the scope. */
function moneyJson(amount: Money, roundTo = 1): MoneyJson {
  return {
    minor: roundToMultiple(amount.minor, BigInt(Math.max(1, Math.trunc(roundTo)))).toString(),
    currency: amount.currency,
  };
}

/**
 * 03 §8.3's bands, in major units and on the magnitude.
 *
 * The sign is carried separately (`direction`), because a band is about size
 * and `-45.00` and `45.00` are the same size. The ladder is exhaustive by
 * construction: the last rung has no upper bound.
 */
export function bucketOf(amount: Money): AmountBucket {
  const scale = 10n ** BigInt(minorUnitScale(amount.currency));
  const magnitude = amount.minor < 0n ? -amount.minor : amount.minor;
  const major = magnitude / scale;
  if (major < 10n) return AMOUNT_BUCKETS[0];
  if (major < 50n) return AMOUNT_BUCKETS[1];
  if (major < 200n) return AMOUNT_BUCKETS[2];
  if (major < 1000n) return AMOUNT_BUCKETS[3];
  if (major < 5000n) return AMOUNT_BUCKETS[4];
  return AMOUNT_BUCKETS[5];
}

/** `YYYY-MM-DD` → `YYYY-MM`. The `monthGranularityOnly` lever. */
export function monthOf(date: DateOnlyType): string {
  return date.slice(0, 7);
}

/** A ratio clamped into `[0,1]`, because the schema's `unitInterval` is. */
function ratio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export class SnapshotBuilder {
  readonly #ports: SnapshotPorts;

  constructor(ports: SnapshotPorts) {
    this.#ports = ports;
  }

  /**
   * The effective grant: what the user granted, kept only where the kind
   * permits it and a source exists. Sorted into catalogue order so two runs
   * with the same grant produce the same list and the same digest.
   */
  static effectiveScopes(
    kind: AdvisorKind,
    granted: readonly AdvisorScope[],
  ): readonly AdvisorScope[] {
    const permitted = new Set(scopesPermittedForKind(kind));
    const requested = new Set(granted);
    return SCOPE_CATALOGUE.filter(
      (definition) => requested.has(definition.scope) && permitted.has(definition.scope),
    ).map((definition) => definition.scope);
  }

  async build(input: BuildSnapshotInput): Promise<BuiltSnapshot> {
    const grantedScopes = SnapshotBuilder.effectiveScopes(input.kind, input.grantedScopes);
    const tokeniser = createTokeniser({
      key: input.tokenKey,
      // Only an `external` advisor gets everything pseudonymised. An in-process
      // advisor's evidence has to link back into the app, and a token we would
      // then have to reverse is a token with a reversal table — which is the
      // thing a pseudonym is supposed to not have.
      tokeniseEverything: input.kind === 'external',
    });

    const snapshot: Record<string, unknown> = {};
    const emitted: AdvisorScope[] = [];

    for (const scope of grantedScopes) {
      const definition = scopeDefinition(scope);
      if (!definition.sourcedInPhase2) continue;
      const block = await this.#blockFor(scope, input, tokeniser, grantedScopes);
      if (block === null) continue;
      snapshot[definition.key] = block;
      emitted.push(scope);
    }

    return {
      snapshot: snapshot as AdvisorSnapshot,
      grantedScopes,
      emittedScopes: emitted,
      inputDigest: inputDigest(snapshot),
    };
  }

  /**
   * One block, or `null` when there is nothing behind it.
   *
   * `null` and "not granted" are deliberately the same outcome — no key. A
   * fresh install with no transactions produces a snapshot of `{}`, every
   * advisor sees no data rather than zeroes, and 07 §3's "every rule degrades
   * gracefully when no budget exists" needs nothing from the rules to be true.
   */
  async #blockFor(
    scope: AdvisorScope,
    input: BuildSnapshotInput,
    tokeniser: Tokeniser,
    granted: readonly AdvisorScope[],
  ): Promise<unknown> {
    switch (scope) {
      case 'networth.summary':
        return this.#netWorth(input);
      case 'cash.summary':
        return this.#cash(input, tokeniser, granted);
      case 'cashflow.monthly':
        return this.#cashflow(input, tokeniser);
      case 'budgets.status':
        return this.#budgets(input, tokeniser);
      case 'recurring.list':
        return this.#recurring(input, tokeniser);
      case 'transactions.summary':
        return this.#transactionSummary(input, tokeniser);
      case 'transactions.raw':
        return this.#transactionsRaw(input, tokeniser);
      default:
        // Every remaining scope has `sourcedInPhase2: false` and is filtered
        // out before this is reached. The `null` is the second line of defence
        // rather than the first: a scope whose row said it was sourced and
        // whose builder does not exist must emit no key, not throw in a worker.
        return null;
    }
  }

  async #netWorth(input: BuildSnapshotInput): Promise<unknown> {
    const rounding = scopeDefinition('networth.summary').minimisation.roundMonetaryToMinor;
    const accounts = await this.#ports.ledger.listAccounts({ userId: input.userId });
    const open = accounts.filter((account) => !account.closed);
    if (open.length === 0) return null;

    const code = input.baseCurrency;
    let assets = Money.zero(code);
    let liabilities = Money.zero(code);
    for (const account of open) {
      if (account.balance.minor >= 0n) assets = Money.add(assets, account.balance);
      else liabilities = Money.add(liabilities, Money.absolute(account.balance));
    }

    const trend = await this.#ports.ledger.netWorthTrend({
      userId: input.userId,
      months: SNAPSHOT_WINDOWS.netWorthTrendMonths,
    });

    return {
      as_of: input.today,
      assets: moneyJson(assets, rounding),
      liabilities: moneyJson(liabilities, rounding),
      net_worth: moneyJson(Money.subtract(assets, liabilities), rounding),
      trend: trend
        .slice(-SNAPSHOT_WINDOWS.netWorthTrendMonths)
        .map((point) => ({ month: point.month, net_worth: moneyJson(point.netWorth, rounding) })),
    };
  }

  async #cash(
    input: BuildSnapshotInput,
    tokeniser: Tokeniser,
    granted: readonly AdvisorScope[],
  ): Promise<unknown> {
    const accounts = (await this.#ports.ledger.listAccounts({ userId: input.userId })).filter(
      (account) => account.isCash && !account.closed,
    );
    if (accounts.length === 0) return null;

    const code = input.baseCurrency;
    let total = Money.zero(code);
    for (const account of accounts) total = Money.add(total, account.balance);

    // Balance-weighted, and weighted by the accounts that actually declare an
    // APY: averaging a `null` as zero would report a cash position as earning
    // less than it does, which is the direction that produces bad advice.
    let weighted = 0;
    let weightBase = 0n;
    for (const account of accounts) {
      if (account.apy === null || account.balance.minor <= 0n) continue;
      weighted += account.apy * Number(account.balance.minor);
      weightBase += account.balance.minor;
    }
    const blendedApy = weightBase === 0n ? 0 : ratio(weighted / Number(weightBase));

    // See the header: the expense half of this ratio is `cashflow.monthly`'s
    // data, so the field exists only when that scope was granted too.
    let emergencyFundMonths: number | null = null;
    if (granted.includes('cashflow.monthly')) {
      const months = await this.#ports.ledger.monthlyCashflow({
        userId: input.userId,
        months: 6,
      });
      const expenses = months.filter((month) => month.expense.minor > 0n);
      if (expenses.length > 0 && total.minor > 0n) {
        let sum = 0n;
        for (const month of expenses) sum += month.expense.minor;
        const average = sum / BigInt(expenses.length);
        emergencyFundMonths =
          average === 0n
            ? null
            : Math.min(600, Math.round((Number(total.minor) / Number(average)) * 10) / 10);
      }
    }

    return {
      as_of: input.today,
      total: moneyJson(total),
      account_count: accounts.length,
      blended_apy: blendedApy,
      emergency_fund_months: emergencyFundMonths,
      accounts: accounts.slice(0, 64).map((account) => ({
        account_ref: tokeniser.ref('account', account.id),
        type: account.type,
        balance: moneyJson(account.balance),
        apy: account.apy === null ? null : ratio(account.apy),
      })),
    };
  }

  async #cashflow(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const months = await this.#ports.ledger.monthlyCashflow({
      userId: input.userId,
      months: SNAPSHOT_WINDOWS.cashflowMonths,
    });
    const window = months.slice(-SNAPSHOT_WINDOWS.cashflowMonths);
    const first = window[0];
    const last = window[window.length - 1];
    if (first === undefined || last === undefined) return null;

    return {
      from_month: first.month,
      to_month: last.month,
      currency: input.baseCurrency,
      months: window.map((month) => ({
        month: month.month,
        income: moneyJson(month.income),
        expense: moneyJson(month.expense),
        net: moneyJson(Money.subtract(month.income, month.expense)),
        by_category: month.byCategory.slice(0, 128).map((row) => ({
          category_ref: tokeniser.ref('category', row.categoryId),
          category_slug: row.slug,
          amount: moneyJson(row.amount),
        })),
      })),
    };
  }

  async #budgets(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const period = await this.#ports.budget.currentPeriod({
      userId: input.userId,
      today: input.today,
    });
    if (period === null) return null;

    // The fraction of the period elapsed, for a pace comparison. Computed from
    // calendar dates in the budget's own zone — the period boundaries are dates,
    // not instants, which is exactly why a DST boundary is uninteresting here.
    const span = DateOnly.differenceInDays(period.startDate, period.endDate);
    const done = DateOnly.differenceInDays(period.startDate, input.today);
    const elapsed = span <= 0 ? 0 : ratio(done / span);

    return {
      period_start: period.startDate,
      period_end: period.endDate,
      period_kind: period.kind,
      currency: period.currency,
      ready_to_assign: moneyJson(period.readyToAssign),
      elapsed,
      lines: period.lines.slice(0, 256).map((line) => ({
        line_ref: tokeniser.ref('budget_line', line.id),
        category_ref: line.categoryId === null ? null : tokeniser.ref('category', line.categoryId),
        category_slug: line.categorySlug,
        kind: line.kind,
        assigned: moneyJson(line.assigned),
        activity: moneyJson(line.activity),
        available: moneyJson(line.available),
        cash_overspend: moneyJson(line.cashOverspend),
        credit_overspend: moneyJson(line.creditOverspend),
        needed_this_period: moneyJson(line.neededThisPeriod),
        underfunded: moneyJson(line.underfunded),
      })),
    };
  }

  async #recurring(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const streams = await this.#ports.recurring.listStreams({ userId: input.userId });
    if (streams.length === 0) return null;

    return {
      as_of: input.today,
      currency: input.baseCurrency,
      streams: streams.slice(0, 512).map((stream) => ({
        series_ref: tokeniser.ref('series', stream.id),
        // Always a token, for every kind. D22.
        merchant_ref: tokeniser.merchant(stream.merchantId),
        cadence: stream.cadence,
        type: stream.type,
        status: stream.status,
        user_confirmed: stream.userConfirmed,
        confidence: ratio(stream.confidence),
        typical_amount: moneyJson(stream.typicalAmount),
        observed_min: moneyJson(stream.observedMin),
        observed_max: moneyJson(stream.observedMax),
        next_due_date: stream.nextDueDate,
        first_seen: stream.firstSeen,
        last_seen: stream.lastSeen,
        periods_per_year: stream.periodsPerYear,
        eligible_for_impact: stream.eligibleForImpact,
        price_changes: stream.priceChanges.slice(0, 12).map((change) => ({
          effective_date: change.effectiveDate,
          direction: change.direction,
          previous_amount: moneyJson(change.previousAmount),
          new_amount: moneyJson(change.newAmount),
          annual_impact: moneyJson(change.annualImpact),
        })),
      })),
    };
  }

  async #transactionSummary(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const months = SNAPSHOT_WINDOWS.transactionSummaryMonths;
    const [categories, merchants] = await Promise.all([
      this.#ports.ledger.categorySpend({ userId: input.userId, months }),
      this.#ports.ledger.topMerchants({
        userId: input.userId,
        months,
        limit: SNAPSHOT_WINDOWS.topMerchants,
      }),
    ]);
    if (categories.length === 0 && merchants.length === 0) return null;

    // `monthGranularityOnly`: the window is stated in months and no date finer
    // than a month appears anywhere in the block.
    const to = monthOf(input.today);
    const from = monthOf(DateOnly.addMonths(input.today, -(months - 1)));

    return {
      from_month: from,
      to_month: to,
      currency: input.baseCurrency,
      by_category: categories.slice(0, 128).map((row) => ({
        category_ref: tokeniser.ref('category', row.categoryId),
        category_slug: row.slug,
        count: row.count,
        total: moneyJson(row.total),
      })),
      top_merchants: merchants.slice(0, 64).map((row) => ({
        merchant_ref: tokeniser.merchant(row.merchantId),
        count: row.count,
        total: moneyJson(row.total),
      })),
    };
  }

  async #transactionsRaw(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const from = DateOnly.addDays(input.today, -SNAPSHOT_WINDOWS.rawTransactionDays);
    const rows = await this.#ports.ledger.listTransactions({
      userId: input.userId,
      from,
      to: input.today,
      limit: SNAPSHOT_WINDOWS.rawTransactionRows,
    });
    if (rows.length === 0) return null;

    return {
      from_date: from,
      to_date: input.today,
      currency: input.baseCurrency,
      rows: rows.slice(0, SNAPSHOT_WINDOWS.rawTransactionRows).map((row) => ({
        transaction_ref: tokeniser.ref('transaction', row.id),
        date: row.date,
        merchant_ref: row.merchantId === null ? null : tokeniser.merchant(row.merchantId),
        category_slug: row.categorySlug,
        // The whole reason this scope is sensitivity 9: exact amounts across
        // enough rows are a fingerprint (03 §8.3), so a band crosses and the
        // figure does not.
        amount_bucket: bucketOf(row.amount),
        direction: row.amount.minor < 0n ? 'outflow' : 'inflow',
      })),
    };
  }
}
