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
 *      `market.watchlist` has no model and `institutions.names` has no source
 *      by choice. A granted-but-unsourced scope emits **no key**, exactly like
 *      an ungranted one — never an empty block, because an advisor cannot tell
 *      "empty" from "none" and would happily reason about zero. WP 3.10a moved
 *      `holdings.aggregate`, `holdings.detail`, `liabilities.terms` and
 *      `market.rates` out of that set by landing four arms; WP 4.9 moved
 *      `goals.list` and `risk.profile`, and added `plan.projection`, by landing
 *      the three planning arms at the bottom of the class.
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
import {
  DateOnly,
  Money,
  USD,
  isCurrencyCode,
  madMinor,
  medianMinor,
  minorUnitScale,
  type DateOnly as DateOnlyType,
} from '@core/kernel';
import { configHash } from '@core/platform';
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
import {
  PERCENT_PER_ANNUM,
  type InsightsHoldings,
  type InsightsTransaction,
  type SnapshotPorts,
} from './ports.ts';
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
  /** `GoalsListSchema.goals`' own ceiling. */
  goals: 64,
  /**
   * WP 5.7. `transactions.anomalies` and `fees.summary` share one trailing
   * window over `LedgerPort.listTransactions` — 07 S1/S5's "twelve-month
   * norm" and "the last 12 months" of fees. The row cap is sized off
   * `rawTransactionRows`' own ratio (2000 over 90 days) scaled to a year, with
   * headroom: 500/month is generous for a household's transaction volume.
   */
  anomalyWindowMonths: 12,
  anomalyWindowRows: 8000,
  /** A category baseline needs at least this many outflows to mean anything. */
  anomalyMinCategorySample: 5,
  /** `TransactionsAnomaliesSchema.rows`' own ceiling. */
  anomalyMaxRows: 500,
  /** WP 11.1. `RuleCandidatesSchema.merchants`' own ceiling. */
  ruleCandidates: 64,
  /** WP 11.1. `RuleCandidatesSchema.merchants[].transactions`' own ceiling. */
  ruleCandidateTransactions: 8,
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

// ---------------------------------------------------------------------------
// WP 5.7 — transactions.anomalies, fees.summary
// ---------------------------------------------------------------------------

/** 07 S1: ">3 robust deviations". */
const ANOMALY_DEVIATION_THRESHOLD = 3;
/** 09 Q17, 07 S1's ADV-5 reading: a $25 materiality floor, not 07's original $100. */
const ANOMALY_MATERIALITY_FLOOR_MAJOR = 25;
/** 07 S5: "> $250". */
const ANOMALY_NEW_MERCHANT_FLOOR_MAJOR = 250;
/** Mirrors S6's `DUPLICATE_WINDOW_DAYS` (`rules-spending.ts`) for the within-block fold. */
const ANOMALY_DUPLICATE_WINDOW_DAYS = 3;

/** 07's fee taxonomy, the category slugs `@ctx/categorization` actually seeds. */
const FEE_CATEGORY_SLUGS: ReadonlySet<string> = new Set([
  'fees_and_services.atm_fees',
  'fees_and_services.bank_fees',
  'fees_and_services.foreign_fees',
  'fees_and_services.interest_charges',
  'fees_and_services.other_fees',
]);

/** 07: "interest charges are the D family's" — the one non-avoidable type. */
const NON_AVOIDABLE_FEE_SLUGS: ReadonlySet<string> = new Set([
  'fees_and_services.interest_charges',
]);

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
  /**
   * `transactions.anomalies` and `fees.summary` are two grants over one
   * `listTransactions` window — the same reasoning `#holdingsOnce` states for
   * the two holdings blocks, over the same port method `transactions.raw`
   * already calls with a different window.
   */
  transactionsWindow?: Promise<readonly InsightsTransaction[]>;
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
      case 'goals.list':
        return this.#goalsList(input);
      case 'risk.profile':
        return this.#riskProfile(input);
      case 'plan.projection':
        return this.#planProjection(input);
      case 'transactions.anomalies':
        return this.#transactionsAnomalies(input, tokeniser, memo);
      case 'fees.summary':
        return this.#feesSummary(input, tokeniser, granted, memo);
      case 'categorization.rule_candidates':
        return this.#ruleCandidates(input, tokeniser);
      default:
        // Every remaining scope has `sourcedInPhase2: false` and is filtered
        // out before this is reached. The `null` is the second line of defence
        // rather than the first: a scope whose row said it was sourced and
        // whose builder does not exist must emit no key, not throw in a worker.
        return null;
    }
  }

  /**
   * WP 11.1: `categorization.rule_candidates`, over `CategorizationPort`.
   *
   * A pass-through with the scope's levers applied and nothing decided: the
   * merchant is tokenised for every kind (D22), the category and each
   * transaction cross as their uuid for an in-process advisor and a token
   * otherwise (`tokens.ts`' table — moot today, since an `external` advisor
   * never reaches this arm), and both lists are capped at the schema's own
   * ceilings. A pair with no transaction behind it cannot be cited and is
   * dropped rather than crossing uncitable. Sorted here, not trusted from the
   * port, so the block — and the digest over it — is the same on two runs
   * whatever order a reader happened to return.
   */
  async #ruleCandidates(input: BuildSnapshotInput, tokeniser: Tokeniser): Promise<unknown> {
    const port = this.#ports.categorization;
    if (port === undefined) return null;
    const candidates = await port.listRuleCandidates({ userId: input.userId });
    const rows = candidates
      .filter(
        (candidate) =>
          Number.isInteger(candidate.confirmations) &&
          candidate.confirmations > 0 &&
          candidate.transactionIds.length > 0 &&
          candidate.categorySlug.length > 0,
      )
      .map((candidate) => ({
        merchant_ref: tokeniser.merchant(candidate.merchantId),
        category_ref: tokeniser.ref('category', candidate.categoryId),
        category_slug: candidate.categorySlug,
        confirmations: candidate.confirmations,
        covered_by_rule: candidate.coveredByRule,
        locked_default: candidate.lockedDefault,
        transactions: candidate.transactionIds
          .slice(0, SNAPSHOT_WINDOWS.ruleCandidateTransactions)
          .map((id) => ({ transaction_ref: tokeniser.ref('transaction', id) })),
      }))
      .sort(
        (left, right) =>
          right.confirmations - left.confirmations ||
          left.merchant_ref.localeCompare(right.merchant_ref) ||
          left.category_slug.localeCompare(right.category_slug),
      )
      .slice(0, SNAPSHOT_WINDOWS.ruleCandidates);
    if (rows.length === 0) return null;
    return { merchants: rows };
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

  /**
   * The trailing window `transactions.anomalies` and `fees.summary` share.
   *
   * One promise, awaited twice — `#holdingsOnce`'s pattern, for the same
   * reason: a refresh landing between the two grants' reads would otherwise
   * let a snapshot disagree with itself about what "the last twelve months"
   * contained.
   */
  #transactionsWindow(
    input: BuildSnapshotInput,
    memo: BuildMemo,
  ): Promise<readonly InsightsTransaction[]> {
    memo.transactionsWindow ??= this.#ports.ledger.listTransactions({
      userId: input.userId,
      from: DateOnly.addMonths(input.today, -SNAPSHOT_WINDOWS.anomalyWindowMonths),
      to: input.today,
      limit: SNAPSHOT_WINDOWS.anomalyWindowRows,
    });
    return memo.transactionsWindow;
  }

  /**
   * `transactions.anomalies` — 07 S1 and S5, WP 5.7.
   *
   * The threshold is applied **here**, in-process, the `idle_cash` precedent
   * (`snapshot.ts:382`): a candidate's category median and MAD are computed
   * over the whole trailing population, but only a row that already clears
   * `>3 robust deviations and the $25 floor` (S1) or `a first-time charge over
   * $250` (S5) is ever placed in `rows` — the unflagged population that
   * produced the baseline never crosses.
   *
   * Every amount below is an outflow's *magnitude* — `-row.amount.minor` —
   * because a robust baseline is about how large a charge is, and the sign is
   * already implied by the scope (this block carries no `direction`, unlike
   * `transactions.raw`).
   */
  async #transactionsAnomalies(
    input: BuildSnapshotInput,
    tokeniser: Tokeniser,
    memo: BuildMemo,
  ): Promise<unknown> {
    const rows = await this.#transactionsWindow(input, memo);
    const outflows = rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.amount.minor < 0n);
    if (outflows.length === 0) return null;

    // The same fallback `belowFloor` (`policy/alert-budget.ts`) uses: every
    // real currency this app supports has a known minor-unit scale, and this
    // runs over data already stored under `input.baseCurrency`, so the
    // fallback changes the answer only for a code that should never have
    // reached here.
    const code = isCurrencyCode(input.baseCurrency) ? input.baseCurrency : USD;
    const scale = 10n ** BigInt(minorUnitScale(code));
    const materialityFloorMinor = BigInt(ANOMALY_MATERIALITY_FLOOR_MAJOR) * scale;
    const newMerchantFloorMinor = BigInt(ANOMALY_NEW_MERCHANT_FLOOR_MAJOR) * scale;

    // One category baseline per slug with enough of a population to mean
    // anything. `@core/kernel`'s exact bigint median and MAD — never a float
    // until the display-only multiple below, which is a ratio like `weight`
    // or `confidence` and never re-enters a `*_minor` figure.
    const magnitudesByCategory = new Map<string, bigint[]>();
    for (const { row } of outflows) {
      if (row.categorySlug === null) continue;
      const magnitudes = magnitudesByCategory.get(row.categorySlug) ?? [];
      magnitudes.push(-row.amount.minor);
      magnitudesByCategory.set(row.categorySlug, magnitudes);
    }
    const baselines = new Map<string, { readonly median: bigint; readonly mad: bigint }>();
    for (const [slug, magnitudes] of magnitudesByCategory) {
      if (magnitudes.length < SNAPSHOT_WINDOWS.anomalyMinCategorySample) continue;
      baselines.set(slug, { median: medianMinor(magnitudes), mad: madMinor(magnitudes) });
    }

    // The earliest-dated outflow per merchant in the window — S5's "never
    // seen" reads as "not seen in what this window can see" (09 §6 Q17's
    // honest limitation, stated once here rather than per row).
    const earliestByMerchant = new Map<string, { readonly index: number; readonly date: string }>();
    for (const entry of outflows) {
      const merchantId = entry.row.merchantId;
      if (merchantId === null) continue;
      const existing = earliestByMerchant.get(merchantId);
      if (existing === undefined || entry.row.date < existing.date) {
        earliestByMerchant.set(merchantId, { index: entry.index, date: entry.row.date });
      }
    }

    interface Candidate {
      readonly row: InsightsTransaction;
      readonly baselineMedian: bigint | null;
      readonly baselineMad: bigint | null;
      readonly deviationMultiple: number | null;
      readonly firstSeenMerchant: boolean;
      readonly s1Flag: boolean;
      readonly s5Flag: boolean;
    }

    const candidates: Candidate[] = [];
    for (const entry of outflows) {
      const { row } = entry;
      const magnitude = -row.amount.minor;
      const baseline = row.categorySlug === null ? undefined : baselines.get(row.categorySlug);

      let baselineMedian: bigint | null = null;
      let baselineMad: bigint | null = null;
      let deviationMultiple: number | null = null;
      let s1Flag = false;
      if (baseline !== undefined) {
        baselineMedian = baseline.median;
        baselineMad = baseline.mad;
        const deviation =
          magnitude < baseline.median ? baseline.median - magnitude : magnitude - baseline.median;
        // Cross-multiplied against the threshold rather than divided, so the
        // comparison stays exact bigint arithmetic (`windows.ts`'s own
        // technique): `deviation > 3 × mad`, never `deviation / mad > 3`.
        s1Flag =
          deviation > BigInt(ANOMALY_DEVIATION_THRESHOLD) * baseline.mad &&
          deviation > materialityFloorMinor;
        // The multiple is presentation only, computed once at this boundary.
        // Undefined when the category's MAD is exactly zero (every peer
        // identical); `s1Flag` above never divided by it, so the flag itself
        // is exact regardless.
        deviationMultiple = baseline.mad === 0n ? null : Number(deviation) / Number(baseline.mad);
      }

      const firstSeenMerchant =
        row.merchantId !== null && earliestByMerchant.get(row.merchantId)?.index === entry.index;
      const s5Flag = firstSeenMerchant && magnitude > newMerchantFloorMinor;

      candidates.push({
        row,
        baselineMedian,
        baselineMad,
        deviationMultiple,
        firstSeenMerchant,
        s1Flag,
        s5Flag,
      });
    }

    const flagged = candidates.filter((candidate) => candidate.s1Flag || candidate.s5Flag);
    if (flagged.length === 0) return null;

    // Stable order: date, then id — never the map's insertion order, so two
    // builds of the same data produce the same digest.
    const sorted = [...flagged].sort((a, b) =>
      a.row.date === b.row.date
        ? a.row.id.localeCompare(b.row.id)
        : a.row.date < b.row.date
          ? -1
          : 1,
    );
    const refs = sorted.map((candidate) => tokeniser.ref('transaction', candidate.row.id));

    // 09 NOT-5's *other* case: not the same id posting (D10 already keeps
    // that to one row, and one insight key), but two flagged rows that look
    // like the same charge seen twice — same merchant, same exact amount,
    // days apart. The later one is folded rather than counted as a second,
    // independent anomaly.
    const duplicateOf: (string | null)[] = sorted.map(() => null);
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      if (current === undefined) continue;
      for (let j = 0; j < i; j += 1) {
        const earlier = sorted[j];
        if (earlier === undefined) continue;
        if (current.row.merchantId === null || current.row.merchantId !== earlier.row.merchantId) {
          continue;
        }
        if (current.row.amount.minor !== earlier.row.amount.minor) continue;
        const gap = Math.abs(DateOnly.differenceInDays(current.row.date, earlier.row.date));
        if (gap > ANOMALY_DUPLICATE_WINDOW_DAYS) continue;
        duplicateOf[i] = refs[j] ?? null;
        break;
      }
    }

    return {
      as_of: input.today,
      currency: code,
      window_months: SNAPSHOT_WINDOWS.anomalyWindowMonths,
      materiality_floor: moneyJson(Money.of(materialityFloorMinor, code)),
      deviation_threshold: ANOMALY_DEVIATION_THRESHOLD,
      new_merchant_floor: moneyJson(Money.of(newMerchantFloorMinor, code)),
      rows: sorted.slice(0, SNAPSHOT_WINDOWS.anomalyMaxRows).map((candidate, index) => ({
        transaction_ref: refs[index] as string,
        date: candidate.row.date,
        category_slug: candidate.row.categorySlug,
        merchant_ref:
          candidate.row.merchantId === null ? null : tokeniser.merchant(candidate.row.merchantId),
        amount: moneyJson(candidate.row.amount),
        baseline_median:
          candidate.baselineMedian === null
            ? null
            : moneyJson(Money.of(candidate.baselineMedian, code)),
        baseline_mad:
          candidate.baselineMad === null ? null : moneyJson(Money.of(candidate.baselineMad, code)),
        deviation_multiple: candidate.deviationMultiple,
        first_seen_merchant: candidate.firstSeenMerchant,
        duplicate_of: duplicateOf[index] ?? null,
        fee_type:
          candidate.row.categorySlug !== null && FEE_CATEGORY_SLUGS.has(candidate.row.categorySlug)
            ? candidate.row.categorySlug
            : null,
      })),
    };
  }

  /**
   * `fees.summary` — S7's fuller successor, WP 5.7.
   *
   * By type and by account over the same trailing window `transactions.anomalies`
   * reads, classified once here so `builtin.spending.fee_hunter` only sums and
   * picks. `expense_ratio_drag` obeys the cross-scope rule
   * `cash.summary.emergency_fund_months` states first: present only when
   * `holdings.detail` was *also* granted, and carried from that block's own
   * `annual_fee_cost` rather than recomputed.
   */
  async #feesSummary(
    input: BuildSnapshotInput,
    tokeniser: Tokeniser,
    granted: readonly AdvisorScope[],
    memo: BuildMemo,
  ): Promise<unknown> {
    const rows = await this.#transactionsWindow(input, memo);
    const feeRows = rows.filter(
      (row) =>
        row.categorySlug !== null &&
        FEE_CATEGORY_SLUGS.has(row.categorySlug) &&
        row.amount.minor < 0n,
    );

    let expenseRatioDrag: MoneyJson | null = null;
    if (granted.includes('holdings.detail')) {
      const holdings = await this.#holdingsOnce(input, memo);
      if (holdings !== null && holdings.currency === input.baseCurrency) {
        let total: Money | null = null;
        for (const position of holdings.positions) {
          if (position.annualFeeCost === null) continue;
          total =
            total === null ? position.annualFeeCost : Money.add(total, position.annualFeeCost);
        }
        expenseRatioDrag = total === null ? null : moneyJson(total);
      }
    }

    if (feeRows.length === 0 && expenseRatioDrag === null) return null;

    const byType = new Map<string, { count: number; total: Money }>();
    for (const row of feeRows) {
      const slug = row.categorySlug as string;
      const bucket = byType.get(slug) ?? { count: 0, total: Money.zero(input.baseCurrency) };
      bucket.count += 1;
      bucket.total = Money.add(bucket.total, Money.absolute(row.amount));
      byType.set(slug, bucket);
    }

    const byAccount = new Map<string, { count: number; total: Money }>();
    for (const row of feeRows) {
      if (row.accountId === undefined) continue;
      const ref = tokeniser.ref('account', row.accountId);
      const bucket = byAccount.get(ref) ?? { count: 0, total: Money.zero(input.baseCurrency) };
      bucket.count += 1;
      bucket.total = Money.add(bucket.total, Money.absolute(row.amount));
      byAccount.set(ref, bucket);
    }

    return {
      as_of: input.today,
      currency: input.baseCurrency,
      window_months: SNAPSHOT_WINDOWS.anomalyWindowMonths,
      by_type: [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, bucket]) => ({
          type,
          avoidable: !NON_AVOIDABLE_FEE_SLUGS.has(type),
          count: bucket.count,
          total: moneyJson(bucket.total),
        })),
      by_account: [...byAccount.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([account_ref, bucket]) => ({
          account_ref,
          count: bucket.count,
          total: moneyJson(bucket.total),
        })),
      expense_ratio_drag: expenseRatioDrag,
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

  // -------------------------------------------------------------------------
  // WP 4.9 — the three planning arms
  // -------------------------------------------------------------------------

  /**
   * `goals.list` — one row per active goal whose pace WP 4.6 could evaluate.
   *
   * Two minimisation duties live here and nowhere else:
   *
   *   * **The goal id never crosses**, for any advisor kind. `goal_ref` is a
   *     `GOAL_` pseudonym (`goalRef` below), so "no ids cross" holds for a
   *     built-in exactly as for a sidecar. An in-app link back to a goal is the
   *     UI's job from the insight key, not the advisor's from an id.
   *   * **A row the contract cannot hold honestly is dropped, not repaired.**
   *     A name outside 1–96 characters, a negative month count, a ratio that is
   *     not a decimal, or amounts in a second currency: each is a port bug, and
   *     a repaired row would be a goal the holder never set.
   *
   * `progress` is the 1.0.0 field and is a JSON number in `[0,1]`; a goal
   * funded past its target reads `1`, which is what "progress" means. The
   * exact ratio is not lost — `pace.status` says on or off track from the
   * unrounded amounts.
   */
  async #goalsList(input: BuildSnapshotInput): Promise<unknown> {
    const planning = this.#ports.planning;
    if (planning === undefined) return null;
    const goals = await planning.goals({ userId: input.userId, asOf: input.today });
    if (goals === null) return null;

    const rows: unknown[] = [];
    for (const goal of goals) {
      const name = goal.name.trim();
      if (name.length === 0 || name.length > 96) continue;
      if (!Number.isInteger(goal.monthsRemaining) || goal.monthsRemaining < 0) continue;
      if (!DECIMAL_STRING.test(goal.fundedRatio)) continue;
      const currency = goal.target.currency;
      if (goal.requiredMonthly.currency !== currency || goal.plannedMonthly.currency !== currency) {
        continue;
      }
      rows.push({
        goal_ref: goalRef(input.tokenKey, goal.id),
        name,
        target: moneyJson(goal.target),
        horizon_months: goal.monthsRemaining,
        progress: ratio(Number(goal.fundedRatio)),
        pace: {
          status: goal.status,
          required_monthly: moneyJson(goal.requiredMonthly),
          planned_monthly: moneyJson(goal.plannedMonthly),
        },
      });
      if (rows.length >= SNAPSHOT_WINDOWS.goals) break;
    }
    if (rows.length === 0) return null;
    return { goals: rows };
  }

  /**
   * `risk.profile` — the four fields the contract carries, or no key.
   *
   * WP 4.1's note for this arm: a holder who declined to give an income has
   * `taxBracketBand: null`, and the contract's band is a **required** string.
   * The block is therefore absent for that holder rather than carrying a band
   * nobody derived (`wp4.1-goals.md` §10, "For WP 4.9"). Omitting a *field*
   * would need the contract to make it optional, which is not additive for a
   * reader that already relies on it.
   */
  async #riskProfile(input: BuildSnapshotInput): Promise<unknown> {
    const planning = this.#ports.planning;
    if (planning === undefined) return null;
    const profile = await planning.riskProfile({ userId: input.userId });
    if (profile === null) return null;
    const band = profile.taxBracketBand;
    if (band === null || band.length === 0 || band.length > 16) return null;
    if (profile.tolerance.length === 0 || profile.tolerance.length > 32) return null;
    if (!Number.isInteger(profile.horizonYears)) return null;
    if (profile.horizonYears < 0 || profile.horizonYears > 100) return null;
    return {
      tolerance: profile.tolerance,
      horizon_years: profile.horizonYears,
      tax_bracket_band: band,
      liquidity_need: profile.liquidityNeed,
    };
  }

  /**
   * `plan.projection` — the newest baseline run, with no balance in it.
   *
   * The port has already reduced dates to years and balances to shares (see
   * `InsightsPlanProjection`). What the builder owns is the one lever the
   * scope row pulls — **the terminal band is rounded to $1,000** — and the
   * fail-closed shape check: a core field that is not what the contract says
   * drops the whole block, and an optional sub-block that is not drops only
   * itself. A success probability that is not a decimal string is refused
   * outright; there is no path here that turns one into a float.
   */
  async #planProjection(input: BuildSnapshotInput): Promise<unknown> {
    const planning = this.#ports.planning;
    if (planning === undefined) return null;
    const read = await planning.projection({ userId: input.userId, asOf: input.today });
    if (read === null) return null;

    const rounding = scopeDefinition('plan.projection').minimisation.roundMonetaryToMinor;
    if (!DECIMAL_STRING.test(read.successProbability)) return null;
    if (!DECIMAL_STRING.test(read.successTarget)) return null;
    if (!isYear(read.asOfYear) || !isYear(read.terminal.calendarYear)) return null;
    if (!isAge(read.ages.current) || !isAge(read.ages.retirement)) return null;
    if (!isAge(read.ages.planEnd) || !isAge(read.terminal.age)) return null;
    if (!Number.isInteger(read.paths) || read.paths < 1 || read.paths > 1_000_000) return null;
    const bands = [read.terminal.p5, read.terminal.p50, read.terminal.p95];
    if (bands.some((band) => band !== null && band.currency !== read.currency)) return null;

    const savings = read.savingsRate;
    const rmd = read.rmd;
    const social = read.socialSecurity;
    const rails = read.guardrail;
    return {
      as_of_year: read.asOfYear,
      currency: read.currency,
      method: read.method,
      paths: read.paths,
      assumptions_version: read.assumptionsVersion,
      stale: read.stale,
      success_probability: read.successProbability,
      success_target: read.successTarget,
      terminal: {
        age: read.terminal.age,
        calendar_year: read.terminal.calendarYear,
        p5: read.terminal.p5 === null ? null : moneyJson(read.terminal.p5, rounding),
        p50: moneyJson(read.terminal.p50, rounding),
        p95: read.terminal.p95 === null ? null : moneyJson(read.terminal.p95, rounding),
      },
      ages: {
        current: read.ages.current,
        retirement: read.ages.retirement,
        plan_end: read.ages.planEnd,
      },
      ...(savings !== null &&
      DECIMAL_STRING.test(savings.plan) &&
      DECIMAL_STRING.test(savings.observed)
        ? {
            savings_rate: {
              plan: savings.plan,
              observed: savings.observed,
              plan_source: savings.planSource,
            },
          }
        : {}),
      ...(rmd !== null &&
      isAge(rmd.startAge) &&
      isYear(rmd.startYear) &&
      DECIMAL_STRING.test(rmd.taxDeferredShare)
        ? {
            rmd: {
              start_age: rmd.startAge,
              start_year: rmd.startYear,
              tax_deferred_share: rmd.taxDeferredShare,
            },
          }
        : {}),
      ...(social !== null &&
      isAge(social.claimAgeYears) &&
      Number.isInteger(social.claimAgeMonths) &&
      social.claimAgeMonths >= 0 &&
      social.claimAgeMonths <= 11 &&
      DECIMAL_STRING.test(social.claimFactor) &&
      DECIMAL_STRING.test(social.factorAt70)
        ? {
            social_security: {
              claim_age_years: social.claimAgeYears,
              claim_age_months: social.claimAgeMonths,
              claim_factor: social.claimFactor,
              factor_at_70: social.factorAt70,
            },
          }
        : {}),
      ...(rails !== null &&
      [rails.withdrawalRate, rails.referenceRate, rails.lower, rails.upper].every((text) =>
        DECIMAL_STRING.test(text),
      )
        ? {
            guardrail: {
              withdrawal_rate: rails.withdrawalRate,
              reference_rate: rails.referenceRate,
              lower: rails.lower,
              upper: rails.upper,
              position: rails.position,
            },
          }
        : {}),
    };
  }
}

/** The contract's `decimalString`: non-negative, at most six places. Never a float. */
const DECIMAL_STRING = /^\d{1,6}(\.\d{1,6})?$/u;

function isYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2200;
}

function isAge(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 130;
}

/**
 * A goal's pseudonym: `GOAL_<12 hex>`, for **every** advisor kind.
 *
 * The same keyed construction `tokens.ts` uses for its always-tokenised
 * domains (`merchant`, `liability`) — label, per-user key, domain, id, 48 bits
 * kept — with the domain `goal`. It lives here rather than as a `TokenDomain`
 * because `snapshot/tokens.ts` was outside WP 4.9's ownership; moving it there
 * (one `PREFIX` entry and one `ALWAYS_TOKENISED` member, identical output) is
 * recorded for the orchestrator, and must travel with the `@core/secretbox`
 * swap `tokens.ts`' header carries, since both change the same construction.
 */
export function goalRef(tokenKey: string, goalId: string): string {
  const digest = configHash({
    label: 'personalfi/v1|advisor-token',
    key: tokenKey,
    domain: 'goal',
    id: goalId,
  });
  return `GOAL_${digest.slice(0, 12)}`;
}
