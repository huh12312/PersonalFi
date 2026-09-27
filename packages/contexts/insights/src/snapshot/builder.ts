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
 *      `@ctx/planning` is Phase 4, so `goals.list`, `risk.profile` and
 *      `market.watchlist` have no source; `institutions.names` has none by
 *      choice. A granted-but-unsourced scope emits **no key**, exactly like an
 *      ungranted one — never an empty block, because an advisor cannot tell
 *      "empty" from "none" and would happily reason about zero. WP 3.10a moved
 *      `holdings.aggregate`, `holdings.detail`, `liabilities.terms` and
 *      `market.rates` out of that set by landing the four arms below.
 *
 * ## The four Phase 3 arms, and the three reinterpretations they are allowed
 *
 * `#holdingsAggregate`, `#holdingsDetail`, `#liabilitiesTerms` and
 * `#marketRates` implement `wp3.10-advisor-catalog-v2.md` §7.1. Three rules in
 * them are load-bearing enough to state here rather than only at the call site:
 *
 *   * **A `securityId` never crosses.** The ports carry one (the analytics
 *     reports are keyed by security); these arms emit `symbol` and drop it, and
 *     a position with no symbol is dropped entirely rather than crossing as an
 *     id-shaped string. A row that cannot be named cannot be cited either.
 *   * **A target class absent from the portfolio is emitted at weight zero.**
 *     Omitting it makes I1 skip a real drift of the whole target weight,
 *     because it cannot cite a ref that does not resolve — the one known
 *     behavioural gap in I1, closed here rather than in the rule.
 *   * **`percent → ratio` happens exactly once, and fails closed.** FRED
 *     publishes in percent; a series whose units are not percent-per-annum is
 *     **refused**, not converted. This is the only reinterpretation the
 *     snapshot performs on a provider value.
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
import { PERCENT_PER_ANNUM, type InsightsHoldings, type SnapshotPorts } from './ports.ts';
import { createTokeniser, inputDigest, type Tokeniser } from './tokens.ts';

/** How much history each block asks for. Every one is a cap, never a target. */
export const SNAPSHOT_WINDOWS = Object.freeze({
  netWorthTrendMonths: 12,
  cashflowMonths: 24,
  transactionSummaryMonths: 12,
  topMerchants: 32,
  rawTransactionDays: 90,
  rawTransactionRows: 2000,
  /** §7.1: `ConcentrationReport.positions`, top 32 by weight. */
  topPositions: 32,
  /** The schema's own ceilings, restated so the slice and the cap are one number. */
  assetClasses: 32,
  detailPositions: 256,
  lotsPerPosition: 32,
  liabilities: 64,
  marketRates: 16,
});

/**
 * How old an observation may be before `market.rates` calls it stale.
 *
 * WP 3.4 §5.1's ladder for prices, at the granularity a snapshot has: strictly
 * more than 24 h is STALE and exactly 24 h is FRESH, *"which leaves a price
 * taken at yesterday's close still fresh at today's"*. One day, measured
 * between `observedOn` and `asOf` — the builder never reads a clock (08 §4.1),
 * so the composition root resolves the provider's answer into the holder's own
 * zone and this compares two dates.
 */
export const MARKET_RATE_FRESH_DAYS = 1;

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

/**
 * `"4.25"` → `0.0425`. A decimal *point shift*, not a division.
 *
 * The one reinterpretation the snapshot performs on a provider value (§7.1), so
 * it is exact rather than merely close: shifting the point in the string and
 * parsing once gives the nearest double to `0.0425`, which round-trips through
 * `String()` as `"0.0425"`. `Number(text) / 100` does not — it is two
 * roundings, and `23.99 / 100` prints as `0.23990000000000002`, which is the
 * kind of figure a reviewer cannot tell from a bug.
 *
 * `null` for anything that is not a plain decimal literal, and `null` for a
 * result outside `[0,1]`. A rate above 100% or below zero is refused rather
 * than clamped: `unitInterval` would silently turn a 150% APR into 100%, which
 * is a wrong number with no error, and a clamp is exactly the "plausible-looking
 * rate" §7.1 says must fail closed.
 */
export function percentStringToRatio(text: string): number | null {
  if (!/^-?\d+(\.\d+)?$/u.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = digits.split('.');
  // Shift left two places: the last two integer digits become the leading
  // fraction digits. Padding first makes `"4.25"` and `"0.04"` one code path.
  const padded = whole.padStart(3, '0');
  const shifted = `${padded.slice(0, -2)}.${padded.slice(-2)}${fraction}`;
  const value = Number(`${negative ? '-' : ''}${shifted}`);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * What one `build()` has already read.
 *
 * `holdings.aggregate` and `holdings.detail` are two grants over one valuation.
 * Reading twice would double the price lookups and — worse — could answer twice
 * differently if a refresh landed between them, putting a `by_asset_class`
 * weight and a `positions[]` market value in the same snapshot that do not
 * reconcile. One promise, awaited twice.
 */
interface BuildMemo {
  holdings?: Promise<InsightsHoldings | null>;
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
    const memo: BuildMemo = {};

    for (const scope of grantedScopes) {
      const definition = scopeDefinition(scope);
      if (!definition.sourcedInPhase2) continue;
      const block = await this.#blockFor(scope, input, tokeniser, grantedScopes, memo);
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
    memo: BuildMemo,
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
      case 'holdings.aggregate':
        return this.#holdingsAggregate(input, memo);
      case 'holdings.detail':
        return this.#holdingsDetail(input, memo);
      case 'liabilities.terms':
        return this.#liabilitiesTerms(input, tokeniser);
      case 'market.rates':
        return this.#marketRates(input);
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
    const excludedCurrencies = new Set<string>();
    for (const account of open) {
      const converted = await this.#convertToBase(account.balance, code, input.today);
      if (converted === null) {
        excludedCurrencies.add(account.balance.currency);
        continue;
      }
      if (converted.minor >= 0n) assets = Money.add(assets, converted);
      else liabilities = Money.add(liabilities, Money.absolute(converted));
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
      ...(excludedCurrencies.size > 0
        ? { excluded_currencies: [...excludedCurrencies].sort() }
        : {}),
    };
  }

  /**
   * `account.balance` → `baseCurrency`, or `null` when it cannot be done
   * honestly.
   *
   * Same currency needs no port at all. A different currency with no `fx`
   * port wired, or an `fx` port that has no rate for the pair, both answer
   * `null` — **never a fabricated par rate** (the same rule
   * `@ctx/investments/src/fx.ts` states for the ledger). The caller's job is to
   * exclude the account from the total and name its currency, not to throw:
   * see `FxPort`'s header in `ports.ts` for why a snapshot degrades here
   * instead of raising `CurrencyMismatchError` out of `build()` (G3-13).
   */
  async #convertToBase(
    amount: Money,
    baseCurrency: string,
    asOf: BuildSnapshotInput['today'],
  ): Promise<Money | null> {
    if (amount.currency === baseCurrency) return amount;
    if (this.#ports.fx === undefined) return null;
    return this.#ports.fx.convert({ amount, toCurrency: baseCurrency, asOf });
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
    const excludedCurrencies = new Set<string>();

    // Balance-weighted, and weighted by the accounts that actually declare an
    // APY: averaging a `null` as zero would report a cash position as earning
    // less than it does, which is the direction that produces bad advice.
    // Both the total and the weighting use the *converted* balance — weighting
    // by a raw minor-unit figure across currencies would blend a CAD cent with
    // a USD cent as if the two were the same size.
    let weighted = 0;
    let weightBase = 0n;
    for (const account of accounts) {
      const converted = await this.#convertToBase(account.balance, code, input.today);
      if (converted === null) {
        excludedCurrencies.add(account.balance.currency);
        continue;
      }
      total = Money.add(total, converted);
      if (account.apy === null || converted.minor <= 0n) continue;
      weighted += account.apy * Number(converted.minor);
      weightBase += converted.minor;
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
      ...(excludedCurrencies.size > 0
        ? { excluded_currencies: [...excludedCurrencies].sort() }
        : {}),
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

  // -------------------------------------------------------------------------
  // WP 3.10a — the four Phase 3 arms (wp3.10-advisor-catalog-v2.md §7.1)
  // -------------------------------------------------------------------------

  /** One valuation per `build()`. See `BuildMemo`. */
  #holdingsOnce(input: BuildSnapshotInput, memo: BuildMemo): Promise<InsightsHoldings | null> {
    memo.holdings ??= this.#ports.investments.holdings({
      userId: input.userId,
      asOf: input.today,
    });
    return memo.holdings;
  }

  /**
   * `holdings.aggregate` — weights, and nothing per account.
   *
   * Two §7.1 duties are implemented here and nowhere else:
   *
   *   * **`securityId` and `holdingCount` are dropped**, and `symbol` is the
   *     only name a position crosses under. A position with no ticker is
   *     dropped whole rather than given a placeholder: the schema's `symbol` is
   *     `min(1)`, an advisor cannot cite what it cannot name, and a synthesised
   *     `"UNKNOWN"` would collide every unnamed holding into one row.
   *   * **A target asset class absent from the portfolio is emitted at weight
   *     zero.** Without the row, I1 cannot cite a `by_asset_class` ref for a
   *     class the holder targets and owns none of, so it skips a drift of the
   *     entire target weight — the largest drift there is. The zero-weight row
   *     is the fix, and it belongs here rather than in the rule because a
   *     second rule reading the same block would otherwise need the same
   *     special case.
   */
  async #holdingsAggregate(input: BuildSnapshotInput, memo: BuildMemo): Promise<unknown> {
    const holdings = await this.#holdingsOnce(input, memo);
    if (holdings === null) return null;
    const { aggregate } = holdings;

    const present = new Set(aggregate.byAssetClass.map((slice) => slice.assetClass));
    const zeroWeightTargets = aggregate.targets
      .filter((target) => !present.has(target.assetClass))
      .map((target) => ({
        asset_class: target.assetClass,
        weight: 0,
        value: { minor: '0', currency: holdings.currency },
      }));

    const byAssetClass = [
      ...aggregate.byAssetClass.map((slice) => ({
        asset_class: slice.assetClass,
        weight: ratio(slice.weight),
        value: moneyJson(slice.value),
      })),
      ...zeroWeightTargets,
    ].slice(0, SNAPSHOT_WINDOWS.assetClasses);

    return {
      as_of: input.today,
      currency: holdings.currency,
      investable_total: moneyJson(aggregate.investableTotal),
      // Required, never omitted (07 §4.3): it is I1's own self-suppression
      // input, and a rule that could not see the coverage would state a drift
      // over a portfolio that is 18% unclassified anyway.
      unclassified_pct: ratio(aggregate.unclassifiedPct),
      by_asset_class: byAssetClass,
      top_positions: aggregate.positions
        .filter((position) => position.symbol !== null)
        .slice(0, SNAPSHOT_WINDOWS.topPositions)
        .map((position) => ({
          symbol: position.symbol as string,
          weight: ratio(position.weight),
          value: moneyJson(position.value),
          asset_class: position.assetClass,
          employer_stock: position.employerStock,
          is_crypto: position.isCrypto,
        })),
      // Empty when unset. §8 Q9: an unset target never becomes an implied
      // 60/40, so I1 withholds on an empty list rather than inventing a
      // benchmark to drift from.
      target_allocation: aggregate.targets
        .slice(0, SNAPSHOT_WINDOWS.assetClasses)
        .map((target) => ({
          asset_class: target.assetClass,
          weight: ratio(target.weight),
        })),
      account_type_mix: Object.fromEntries(
        Object.entries(aggregate.accountTypeMix).map(([key, weight]) => [key, ratio(weight)]),
      ),
      // Spread rather than `: undefined`. Both blocks are `.optional()` and the
      // rule the whole snapshot rests on is that absence means "none" — an
      // explicit `undefined` key is absent to `JSON.stringify` and present to
      // `Object.keys`, which is two answers to one question.
      ...(aggregate.idleCash === null
        ? {}
        : {
            idle_cash: {
              total: moneyJson(aggregate.idleCash.total),
              floor: moneyJson(aggregate.idleCash.floor),
              min_days: aggregate.idleCash.minDays,
              longest_idle_days: aggregate.idleCash.longestIdleDays,
            },
          }),
      ...(aggregate.cryptoCustody === null
        ? {}
        : {
            crypto_custody: {
              exchange_value: moneyJson(aggregate.cryptoCustody.exchangeValue),
              self_custody_value: moneyJson(aggregate.cryptoCustody.selfCustodyValue),
              unknown_value: moneyJson(aggregate.cryptoCustody.unknownValue),
            },
          }),
    };
  }

  /**
   * `holdings.detail` — one row per position, as ages and classes.
   *
   * Everything that would identify *where* a position sits is already absent
   * from the port type; what this arm owns is the pair of rules that cannot be
   * expressed as an absent field:
   *
   *   * **`cost_basis` and `unrealized` are `null` together.** An unknown basis
   *     is not a zero one (04 §5.5) — a zero would make the unrealised gain
   *     wrong by the whole position, and X6's entire subject is the difference.
   *   * **A lot crosses as an age**, never as an open date. The port converts,
   *     because the subtraction needs the date; this arm is where a future
   *     `opened_date` would have to be added to leak one, and there is nowhere
   *     in the schema to put it.
   */
  async #holdingsDetail(input: BuildSnapshotInput, memo: BuildMemo): Promise<unknown> {
    const holdings = await this.#holdingsOnce(input, memo);
    if (holdings === null) return null;
    if (holdings.positions.length === 0) return null;

    const named = holdings.positions.filter((position) => position.symbol !== null);
    if (named.length === 0) return null;

    return {
      as_of: input.today,
      currency: holdings.currency,
      positions: named.slice(0, SNAPSHOT_WINDOWS.detailPositions).map((position) => {
        // Stated once, here, rather than trusted of the adapter: the pairing is
        // the contract's own invariant and a port that broke it would otherwise
        // produce a schema-valid block claiming a gain over an unknown basis.
        const basisKnown = position.costBasis !== null;
        return {
          symbol: position.symbol as string,
          asset_class: position.assetClass,
          account_type: position.accountType,
          quantity: position.quantity,
          cost_basis: position.costBasis === null ? null : moneyJson(position.costBasis),
          market_value: moneyJson(position.marketValue),
          unrealized:
            !basisKnown || position.unrealized === null ? null : moneyJson(position.unrealized),
          oldest_lot_days: position.oldestLotDays,
          basis_known: basisKnown,
          is_crypto: position.isCrypto,
          is_stablecoin: position.isStablecoin,
          employer_stock: position.employerStock,
          expense_ratio: position.expenseRatio === null ? null : ratio(position.expenseRatio),
          peer_expense_ratio:
            position.peerExpenseRatio === null ? null : ratio(position.peerExpenseRatio),
          annual_fee_cost:
            position.annualFeeCost === null ? null : moneyJson(position.annualFeeCost),
          high_fee: position.highFee,
          lots: position.lots.slice(0, SNAPSHOT_WINDOWS.lotsPerPosition).map((lot) => ({
            opened_days: lot.openedDays,
            quantity: lot.quantity,
            cost_basis: lot.costBasis === null ? null : moneyJson(lot.costBasis),
            market_value: moneyJson(lot.marketValue),
            unrealized:
              lot.costBasis === null || lot.unrealized === null ? null : moneyJson(lot.unrealized),
            long_term: lot.longTerm,
          })),
        };
      }),
    };
  }

  /**
   * `liabilities.terms` — the APR / limit / statement block the D family needed.
   *
   * `liability_ref` is minted by the existing tokeniser, in the `liability`
   * domain, which is always pseudonymised for every advisor kind — see
   * `tokens.ts`' header for why this block and not `cash.summary`.
   */
  async #liabilitiesTerms(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const read = await this.#ports.investments.liabilities({
      userId: input.userId,
      asOf: input.today,
    });
    if (read === null || read.liabilities.length === 0) return null;

    return {
      as_of: input.today,
      currency: read.currency,
      liabilities: read.liabilities.slice(0, SNAPSHOT_WINDOWS.liabilities).map((liability) => ({
        liability_ref: tokeniser.ref('liability', liability.id),
        kind: liability.kind,
        apr: liability.apr === null ? null : ratio(liability.apr),
        promo_apr: liability.promoApr === null ? null : ratio(liability.promoApr),
        promo_apr_end_date: liability.promoAprEndDate,
        credit_limit: liability.creditLimit === null ? null : moneyJson(liability.creditLimit),
        statement_balance:
          liability.statementBalance === null ? null : moneyJson(liability.statementBalance),
        current_balance: moneyJson(liability.currentBalance),
        minimum_payment:
          liability.minimumPayment === null ? null : moneyJson(liability.minimumPayment),
        payment_due_date: liability.paymentDueDate,
        last_payment_date: liability.lastPaymentDate,
        last_payment_amount:
          liability.lastPaymentAmount === null ? null : moneyJson(liability.lastPaymentAmount),
        minimum_only_months: liability.minimumOnlyMonths,
      })),
    };
  }

  /**
   * `market.rates` — a dated, attributed, converted rate.
   *
   * The three duties §7.1 gives the builder and no rule:
   *
   *   1. **Convert to a ratio and record what was converted from**, refusing
   *      any series whose units are not percent-per-annum. A basis-point or
   *      index series turned into a "rate" is a plausible-looking number with
   *      nothing behind it, so the refusal drops the row — and a block whose
   *      every row was refused emits no key at all rather than an empty
   *      `rates: []`, which an advisor would read as "the market pays nothing".
   *   2. **Compute `stale`**, never read it. See `MARKET_RATE_FRESH_DAYS`.
   *   3. **Carry the attribution verbatim.** 01 §4.3 makes the sentence a
   *      licence condition and a paraphrase of a licence condition is a new
   *      licence condition, so it is copied, not templated. A block with no
   *      attribution emits no key: a rate a surface cannot lawfully print is
   *      worse than no rate.
   */
  async #marketRates(input: BuildSnapshotInput): Promise<unknown> {
    const read = await this.#ports.marketData.rates({
      userId: input.userId,
      asOf: input.today,
    });
    if (read === null) return null;
    if (read.attribution.length === 0) return null;

    const rates: unknown[] = [];
    for (const observation of read.observations) {
      if (observation.units !== PERCENT_PER_ANNUM) continue;
      const rate = percentStringToRatio(observation.value);
      if (rate === null) continue;
      rates.push({
        series_id: observation.seriesId,
        kind: observation.kind,
        observation_date: observation.observationDate,
        rate,
        // What we converted *from*, so the conversion is auditable rather than
        // inferable from the size of the number.
        units: observation.units,
        stale:
          DateOnly.differenceInDays(observation.observedOn, input.today) > MARKET_RATE_FRESH_DAYS,
      });
      if (rates.length >= SNAPSHOT_WINDOWS.marketRates) break;
    }
    if (rates.length === 0) return null;

    return {
      as_of: input.today,
      attribution: read.attribution,
      attribution_url: read.attributionUrl,
      rates,
    };
  }
}
