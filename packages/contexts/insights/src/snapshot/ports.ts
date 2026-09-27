// SPDX-License-Identifier: MIT
/**
 * The five read ports the snapshot is built from — and the reason there are
 * five of them and not one.
 *
 * `personalfi/layer-imports` forbids one context importing another, so insights
 * reaches the ledger, the budget and the recurring streams through ports that
 * `apps/api/src/domain.ts` implements over each context's published readers.
 * That much is the same arrangement `@ctx/budgeting` and `@ctx/recurring`
 * already use. What is different here is *why the shape matters*.
 *
 * ## Minimisation starts at the port, not at the mapper
 *
 * 08 §4.2 makes `SnapshotBuilder` "the single implementation point" for data
 * minimisation. A port that returned `@ctx/ledger`'s own row type would put an
 * institution name, an account mask and a raw descriptor one property access
 * away from the emitter, and the only thing standing between them and an
 * external advisor would be a mapper remembering not to copy them.
 *
 * So these interfaces carry **only what a snapshot block can hold**. There is no
 * `institutionName` on `InsightsAccount`, no `descriptor` on
 * `InsightsTransaction`, no `name` on `InsightsBudgetLine`. Adding one would be
 * a visible diff in this file *and* in `contract/snapshot.ts`, reviewed twice,
 * rather than a field that leaks because it was already in scope. `builder.ts`
 * then does the second half — rounding, bucketing, tokenising — and
 * `test/snapshot-scopes.test.ts` asserts the outcome.
 *
 * ## Ports are read-only, with no writes anywhere
 *
 * None of the five has a write method. Insights proposes; it does not act
 * (08 §4.1), and the absence of a write path is what makes that structural
 * rather than a promise. The same reasoning as `@ctx/recurring`'s `LedgerPort`,
 * one level up: a port with a write is a port somebody can be tempted to widen.
 *
 * ## The fakes live here, not in `test/`
 *
 * `inMemoryLedgerPort`, `inMemoryBudgetPort` and `inMemoryRecurringPort` are in
 * `src/` on purpose. The Phase 2 gate's standard is that an independent
 * reviewer re-runs the load-bearing proofs; a fake they have to re-implement is
 * a fake that will differ from this one in whichever direction makes the proof
 * pass. `inMemoryInvestmentsPort` and `inMemoryMarketDataPort` join them.
 *
 * ## WP 3.10a — the two Phase 3 ports, and the one id they deliberately carry
 *
 * `InvestmentsPort` and `MarketDataPort` are the readers
 * `docs/evidence/phase-3/wp3.10-advisor-catalog-v2.md` §7.1 specified and
 * neither WP 3.9 nor WP 3.10 could own. They follow the minimisation rule at
 * the top of this file with **one stated exception**: `InsightsSecurityPosition`
 * and `InsightsPosition` carry a `securityId`, and `InsightsLiability` carries
 * an account `id`.
 *
 * That is the same arrangement `InsightsAccount.id` already has, and for the
 * same reason: the analytics reports these mirror are *keyed* by security, and
 * a port that dropped the key would be doing the aggregation itself, in the
 * composition root, where nothing tests it. What §7.1 asks for is that the
 * **builder** drops it — "a `securityId` never crosses (`symbol` only)" — and a
 * drop is only reviewable if there was something to drop. `builder.ts` is
 * therefore the one place the decision is made, and
 * `test/snapshot-scopes.test.ts` is where it is asserted from the outside.
 */
import { Money, type DateOnly } from '@core/kernel';
import type { AccountTaxTreatment, LiabilityKind, MarketRateKind } from '../contract/snapshot.ts';

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** The account roles the cash block distinguishes. Everything else is `other`. */
export const CASH_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'money_market',
  'cash_management',
  'other',
] as const;
export type CashAccountType = (typeof CASH_ACCOUNT_TYPES)[number];

/**
 * One account, as much of it as any snapshot block may see.
 *
 * `id` is here because a `builtin` or `local_model` advisor's evidence has to
 * be clickable back to the account in the app; `builder.ts` decides whether the
 * id or a token crosses, based on the advisor's kind, and it is the only place
 * that decision is made.
 */
export interface InsightsAccount {
  readonly id: string;
  readonly type: CashAccountType;
  /** `true` for a cash-like depository account: the `cash.summary` population. */
  readonly isCash: boolean;
  /** Counts toward assets when positive, liabilities when negative. */
  readonly balance: Money;
  /** A ratio, never a percentage. `0.0425` is 4.25%. `null` when unknown. */
  readonly apy: number | null;
  readonly closed: boolean;
}

export interface MonthlyCashflowRow {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly income: Money;
  /** A positive figure: what left, not a negative net. */
  readonly expense: Money;
  readonly byCategory: readonly {
    readonly categoryId: string;
    /** The taxonomy slug (`food.dining`), never a user-written name. */
    readonly slug: string;
    readonly amount: Money;
  }[];
}

export interface CategorySpendRow {
  readonly categoryId: string;
  readonly slug: string;
  readonly count: number;
  readonly total: Money;
}

export interface MerchantSpendRow {
  readonly merchantId: string;
  readonly count: number;
  readonly total: Money;
}

/**
 * One transaction, for `transactions.raw` only — the most sensitive scope there
 * is, never granted to an `external` advisor.
 *
 * No descriptor, no payee text, no account name, and the amount is a `Money`
 * that `builder.ts` immediately turns into a band. It arrives exact because the
 * *bucketing* is a minimisation rule and rules live in the builder; a port that
 * bucketed would put the rule in the composition root, where nothing tests it.
 */
export interface InsightsTransaction {
  readonly id: string;
  readonly date: DateOnly;
  readonly merchantId: string | null;
  readonly categorySlug: string | null;
  readonly amount: Money;
}

export interface LedgerPort {
  /** Every open account, for `networth.summary` and `cash.summary`. */
  listAccounts(input: { readonly userId: string }): Promise<readonly InsightsAccount[]>;
  /**
   * Net worth at each month end, oldest first, for the trend line.
   *
   * A port method rather than a fold over balances, because "what was net worth
   * in March?" needs history the current balance does not carry, and a snapshot
   * builder that tried to reconstruct it would be re-implementing a read model
   * that belongs to the ledger.
   */
  netWorthTrend(input: {
    readonly userId: string;
    readonly months: number;
  }): Promise<readonly { readonly month: string; readonly netWorth: Money }[]>;
  /** Income/expense by month by category, newest month last. */
  monthlyCashflow(input: {
    readonly userId: string;
    readonly months: number;
  }): Promise<readonly MonthlyCashflowRow[]>;
  /** Counts and sums by category over a window, for `transactions.summary`. */
  categorySpend(input: {
    readonly userId: string;
    readonly months: number;
  }): Promise<readonly CategorySpendRow[]>;
  /** Top merchants by spend over the same window. */
  topMerchants(input: {
    readonly userId: string;
    readonly months: number;
    readonly limit: number;
  }): Promise<readonly MerchantSpendRow[]>;
  /** Individual rows, for `transactions.raw`. Bounded by the caller. */
  listTransactions(input: {
    readonly userId: string;
    readonly from: DateOnly;
    readonly to: DateOnly;
    readonly limit: number;
  }): Promise<readonly InsightsTransaction[]>;
}

// ---------------------------------------------------------------------------
// Budgeting
// ---------------------------------------------------------------------------

export interface InsightsBudgetLine {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categorySlug: string | null;
  readonly kind: string;
  readonly assigned: Money;
  readonly activity: Money;
  readonly available: Money;
  /** 07 §1.3's red half: cash has already left a depository account. */
  readonly cashOverspend: Money;
  /** 07 §1.3's yellow half: borrowed on a card; no cash has moved. */
  readonly creditOverspend: Money;
  readonly neededThisPeriod: Money;
  readonly underfunded: Money;
}

export interface InsightsBudgetPeriod {
  readonly startDate: DateOnly;
  /** **Exclusive**, as everywhere in `@ctx/budgeting`. */
  readonly endDate: DateOnly;
  readonly kind: string;
  readonly currency: string;
  readonly readyToAssign: Money;
  readonly lines: readonly InsightsBudgetLine[];
}

export interface BudgetPort {
  /**
   * The period containing `today`, or `null` when no budget exists.
   *
   * `null` is a first-class answer and not an error: 07 §3 requires every rule
   * to degrade gracefully with no budget, and the mechanism for that is the
   * `budgets.status` block being **absent** rather than empty — an advisor
   * cannot tell an empty budget from no budget and would reason about zero.
   */
  currentPeriod(input: {
    readonly userId: string;
    readonly today: DateOnly;
  }): Promise<InsightsBudgetPeriod | null>;
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

export interface InsightsPriceChange {
  readonly effectiveDate: DateOnly;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly previousAmount: Money;
  readonly newAmount: Money;
  readonly annualImpact: Money;
}

export interface InsightsRecurringStream {
  readonly id: string;
  readonly merchantId: string;
  readonly cadence: string;
  readonly type: string;
  readonly status: string;
  readonly userConfirmed: boolean;
  readonly confidence: number;
  readonly typicalAmount: Money;
  readonly observedMin: Money;
  readonly observedMax: Money;
  readonly nextDueDate: DateOnly | null;
  readonly firstSeen: DateOnly;
  readonly lastSeen: DateOnly;
  readonly periodsPerYear: number;
  /** 07 §2.4: an EARLY_DETECTION stream never drives a $-impact insight. */
  readonly eligibleForImpact: boolean;
  readonly priceChanges: readonly InsightsPriceChange[];
}

export interface RecurringPort {
  listStreams(input: { readonly userId: string }): Promise<readonly InsightsRecurringStream[]>;
}

// ---------------------------------------------------------------------------
// Investments — WP 3.10a
// ---------------------------------------------------------------------------

/** One `AllocationReport.slice`, with `holdingIds` already gone. */
export interface InsightsAssetClassSlice {
  /** `US_EQUITY`, `CRYPTO`, `UNCLASSIFIED`. The classifier's own vocabulary. */
  readonly assetClass: string;
  readonly value: Money;
  /** A ratio in `[0,1]`, never a percentage. */
  readonly weight: number;
}

/**
 * One security-level position, summed across accounts.
 *
 * `ConcentrationReport.positions`, minus `holdingCount` — which is an account
 * count wearing a different name and so is account linkage — and plus the three
 * booleans the aggregate block reasons about. The `securityId` is here to be
 * dropped; see the header.
 */
export interface InsightsSecurityPosition {
  readonly securityId: string;
  /** `null` for a security with no ticker. Such a row never crosses. */
  readonly symbol: string | null;
  readonly value: Money;
  readonly weight: number;
  readonly assetClass: string;
  /** I5. The account holder's own tag — this app never infers an employer. */
  readonly employerStock: boolean;
  readonly isCrypto: boolean;
}

/** `IdleCashReport`, already aggregated. No per-account row, ever. */
export interface InsightsIdleCash {
  readonly total: Money;
  readonly floor: Money;
  readonly minDays: number;
  readonly longestIdleDays: number;
}

/** X2's split. A value per custody class, with no wallet, venue or address. */
export interface InsightsCryptoCustody {
  readonly exchangeValue: Money;
  readonly selfCustodyValue: Money;
  readonly unknownValue: Money;
}

export interface InsightsAllocationTarget {
  readonly assetClass: string;
  readonly weight: number;
}

/**
 * One tax lot as an **age**, not a date.
 *
 * The conversion to days happens in the adapter because `asOf − openDate`
 * needs the open date, and the whole point of this type is that the open date
 * stops here.
 */
export interface InsightsLot {
  readonly openedDays: number;
  /** A decimal string at the kernel's quantity scale. Never a float (D3). */
  readonly quantity: string;
  /** `null` and `unrealized` `null` together. An unknown basis is not a zero one. */
  readonly costBasis: Money | null;
  readonly marketValue: Money;
  readonly unrealized: Money | null;
  readonly longTerm: boolean;
}

/**
 * One position for `holdings.detail`, grouped by security **and tax treatment**.
 *
 * Not by security alone: the same ETF in a taxable account and in an IRA is two
 * rows, because I6 only speaks about taxable lots and a merged row would make a
 * tax-deferred loss look harvestable. Grouping by the *class* rather than by the
 * account keeps 08 §4.2's "no account id in `holdings.detail`" structural.
 */
export interface InsightsPosition {
  readonly securityId: string;
  readonly symbol: string | null;
  readonly assetClass: string;
  readonly accountType: AccountTaxTreatment;
  readonly quantity: string;
  readonly costBasis: Money | null;
  readonly marketValue: Money;
  readonly unrealized: Money | null;
  readonly oldestLotDays: number;
  readonly isCrypto: boolean;
  readonly isStablecoin: boolean;
  readonly employerStock: boolean;
  /** A ratio: `0.0014` is 0.14%. `null` when unknown — never `0`. */
  readonly expenseRatio: number | null;
  readonly peerExpenseRatio: number | null;
  /** `FeeRow.annualCost`, rounded once upstream. Carried, never re-derived. */
  readonly annualFeeCost: Money | null;
  readonly highFee: boolean;
  readonly lots: readonly InsightsLot[];
}

/** Everything `holdings.aggregate` projects, and nothing per account. */
export interface InsightsHoldingsAggregate {
  readonly investableTotal: Money;
  /** 07 §4.3's mandatory number. Present even when it is zero. */
  readonly unclassifiedPct: number;
  readonly byAssetClass: readonly InsightsAssetClassSlice[];
  readonly positions: readonly InsightsSecurityPosition[];
  /** Empty when the holder has set none. §8 Q9: never a default 60/40. */
  readonly targets: readonly InsightsAllocationTarget[];
  /** Value by account tax treatment ÷ total. A class, never an account. */
  readonly accountTypeMix: Readonly<Record<string, number>>;
  /** `null` when no dwell history exists to measure idleness against. */
  readonly idleCash: InsightsIdleCash | null;
  /** `null` when the holder owns no crypto. */
  readonly cryptoCustody: InsightsCryptoCustody | null;
}

/**
 * One read, two blocks.
 *
 * `holdings.aggregate` and `holdings.detail` are two grants over one valuation,
 * and valuing a portfolio twice in one snapshot could answer twice differently
 * if a price refresh landed in between. The builder memoises this call for the
 * life of one `build()` so the two blocks cannot disagree.
 */
export interface InsightsHoldings {
  readonly currency: string;
  readonly aggregate: InsightsHoldingsAggregate;
  readonly positions: readonly InsightsPosition[];
}

/**
 * One liability's terms.
 *
 * `id` is the account id and it exists so the builder can mint a
 * `liability_ref` from it. It is the only identifier in the type: no provider
 * id, no institution name, no lender, no mask — the scope row's `drops` column
 * lists all four and there is nowhere here to put any of them.
 */
export interface InsightsLiability {
  readonly id: string;
  readonly kind: LiabilityKind;
  /** A ratio: `0.2399` is 23.99% APR. `null` when the provider gave none. */
  readonly apr: number | null;
  readonly promoApr: number | null;
  readonly promoAprEndDate: DateOnly | null;
  readonly creditLimit: Money | null;
  readonly statementBalance: Money | null;
  readonly currentBalance: Money;
  readonly minimumPayment: Money | null;
  readonly paymentDueDate: DateOnly | null;
  readonly lastPaymentDate: DateOnly | null;
  readonly lastPaymentAmount: Money | null;
  /** D3's trigger. `null` when there is not enough history to count. */
  readonly minimumOnlyMonths: number | null;
}

export interface InsightsLiabilities {
  readonly currency: string;
  readonly liabilities: readonly InsightsLiability[];
}

export interface InvestmentsPort {
  /**
   * The valued portfolio at `asOf`, or `null`.
   *
   * `null` when `module.investments` is off or the holder has no positions —
   * and `null` is a first-class answer, not an error. The builder turns it into
   * **no key**, because an advisor cannot tell an empty portfolio from no
   * portfolio and would reason about zero.
   */
  holdings(input: {
    readonly userId: string;
    readonly asOf: DateOnly;
  }): Promise<InsightsHoldings | null>;
  /** The liability terms at `asOf`, or `null` when there are none. */
  liabilities(input: {
    readonly userId: string;
    readonly asOf: DateOnly;
  }): Promise<InsightsLiabilities | null>;
}

// ---------------------------------------------------------------------------
// Market data — WP 3.10a
// ---------------------------------------------------------------------------

/**
 * The units string the builder will accept, and the only one.
 *
 * §7.1: *"Refuse any series whose units are not percent-per-annum rather than
 * converting a basis-point or index series into a plausible-looking rate — that
 * is the one reinterpretation in the whole snapshot and it must fail closed."*
 * A constant rather than a literal in two files, so the refusal and the thing
 * refused cannot drift apart.
 */
export const PERCENT_PER_ANNUM = 'percent_per_annum';

export interface InsightsMarketRateObservation {
  /** The FRED series id. Evidence, not identity. */
  readonly seriesId: string;
  /** The join key. A rule selects by this, never by `seriesId`. */
  readonly kind: MarketRateKind;
  readonly observationDate: DateOnly;
  /**
   * The figure **as the provider published it**, in `units`, as a decimal
   * string. Not converted here: §7.1 gives the conversion to the builder so
   * there is one divide-by-100 in the system and one place to get it wrong.
   */
  readonly value: string;
  readonly units: string;
  /**
   * The date the provider answered, in the account holder's zone.
   *
   * WP 3.4 §5.1's ladder is about when *we* were told, not about when the
   * market last printed — a series that only prints on business days is not
   * stale on a Monday. `stale` is computed from this against `asOf`, in the
   * builder, and is never stored.
   */
  readonly observedOn: DateOnly;
}

export interface InsightsMarketRates {
  /** `ATTRIBUTIONS.fred.text`, verbatim, ® included. Never a paraphrase. */
  readonly attribution: string;
  readonly attributionUrl: string | null;
  readonly observations: readonly InsightsMarketRateObservation[];
}

export interface MarketDataPort {
  /**
   * The tracked series at `asOf`, or `null`.
   *
   * `null` when no provider key is configured — feature detection, not a
   * hardcoded rate. WP 2.7 is explicit that "a hardcoded 4% would be a numeral
   * nothing could account for", so the absence of a key is an absent block and
   * C1, C2, D2 and X3 fall back to what the holder already has.
   */
  rates(input: {
    readonly userId: string;
    readonly asOf: DateOnly;
  }): Promise<InsightsMarketRates | null>;
}

// ---------------------------------------------------------------------------
// FX — WP 4.12b (C-10)
// ---------------------------------------------------------------------------

/**
 * A read-only conversion into the snapshot's base currency.
 *
 * `#netWorth`/`#cash` used to fold every open account into one `Money` total
 * with `Money.add`, which throws `CurrencyMismatchError` the moment one
 * account's currency differs from `input.baseCurrency` — and because that
 * throw happens inside `build()`'s scope loop, it takes down the *whole*
 * snapshot, denying every granted scope to an advisor that asked for none of
 * this one (G3-13). `FxPort` is this package's own mirror of
 * `@ctx/investments`'s `FxReader` — insights cannot import that context
 * directly (the layer lint forbids `@ctx/*` → `@ctx/*`) — narrowed to the one
 * call the builder needs.
 *
 * `null` is a first-class answer, exactly like everywhere else this app reads
 * an FX rate: **never a fabricated par rate**. The builder's response to a
 * `null` is to exclude that account from the total and name its currency in
 * `excluded_currencies`, not to throw a second time — a snapshot has no
 * user-facing error surface to carry a `FxRateUnavailable` to, unlike the
 * ledger and the corrections route.
 */
export interface FxPort {
  convert(input: {
    readonly amount: Money;
    readonly toCurrency: string;
    readonly asOf: DateOnly;
  }): Promise<Money | null>;
}

// ---------------------------------------------------------------------------
// Planning — WP 4.9
// ---------------------------------------------------------------------------

/**
 * One goal, as much of it as `goals.list` may carry — **and one id, to drop**.
 *
 * `id` is here for the same reason `InsightsAccount.id` is: the builder mints
 * the pseudonym, and a drop is only reviewable if there was something to drop.
 * What is *not* here is the point of the type: no funding account ids, no
 * earmarks, no funded amount, no target date. `evaluateGoalPace` needs all of
 * them and the composition root has them; the port hands over only the
 * verdict. The target date crosses as a month count.
 */
export interface InsightsGoal {
  readonly id: string;
  /** The holder's own label, ≤ 96 characters (WP 4.1's limit is the contract's). */
  readonly name: string;
  readonly target: Money;
  /** Whole months from the evaluation day to the target date. */
  readonly monthsRemaining: number;
  /** funded ÷ target as WP 4.6 computed it: a six-place decimal string, may exceed 1. */
  readonly fundedRatio: string;
  readonly status: 'on_track' | 'off_track';
  readonly requiredMonthly: Money;
  readonly plannedMonthly: Money;
}

/** WP 4.1's current risk profile, minus the answers and the penalty. */
export interface InsightsRiskProfile {
  readonly tolerance: string;
  readonly horizonYears: number;
  /** `null` when the holder declined to give an income: then there is no band to send. */
  readonly taxBracketBand: string | null;
  readonly liquidityNeed: 'low' | 'medium' | 'high';
}

/**
 * The newest baseline projection, already reduced to ratios, ages and years.
 *
 * The composition root does the reduction — birth date to an age, a run date
 * to a year, two balances to a share — because it is the one place both the
 * dates and the ages are in scope, and a port that carried the birth date so
 * the builder could subtract would put a day-precision date one property away
 * from an external advisor. The *money* that remains (the terminal band) is
 * rounded here, in the builder, from the scope row.
 */
export interface InsightsPlanProjection {
  readonly asOfYear: number;
  readonly currency: string;
  readonly method: 'monte_carlo' | 'deterministic';
  readonly paths: number;
  readonly assumptionsVersion: string;
  readonly stale: boolean;
  /** Decimal strings throughout. A success probability is never a `number`. */
  readonly successProbability: string;
  readonly successTarget: string;
  readonly terminal: {
    readonly age: number;
    readonly calendarYear: number;
    readonly p5: Money | null;
    readonly p50: Money;
    readonly p95: Money | null;
  };
  readonly ages: {
    readonly current: number;
    readonly retirement: number;
    readonly planEnd: number;
  };
  readonly savingsRate: {
    readonly plan: string;
    readonly observed: string;
    readonly planSource: 'stated' | 'derived';
  } | null;
  readonly rmd: {
    readonly startAge: number;
    readonly startYear: number;
    readonly taxDeferredShare: string;
  } | null;
  readonly socialSecurity: {
    readonly claimAgeYears: number;
    readonly claimAgeMonths: number;
    readonly claimFactor: string;
    readonly factorAt70: string;
  } | null;
  readonly guardrail: {
    readonly withdrawalRate: string;
    readonly referenceRate: string;
    readonly lower: string;
    readonly upper: string;
    readonly position: 'below' | 'within' | 'above';
  } | null;
}

/**
 * `@ctx/planning`, read-only, as three answers.
 *
 * Each method answers `null` for "nothing to say" — no active evaluable goal,
 * no risk profile, no baseline run — and the builder turns that into **no
 * key**, exactly as the investments port does. None of the three writes: the
 * projection method in particular reads the newest *stored* run and never
 * computes one, because a snapshot that ran the engine would be a read with a
 * side effect (a stored run, a `ProjectionCompleted`) that no advisor asked for.
 */
export interface PlanningPort {
  goals(input: {
    readonly userId: string;
    readonly asOf: DateOnly;
  }): Promise<readonly InsightsGoal[] | null>;
  riskProfile(input: { readonly userId: string }): Promise<InsightsRiskProfile | null>;
  projection(input: {
    readonly userId: string;
    readonly asOf: DateOnly;
  }): Promise<InsightsPlanProjection | null>;
}

/**
 * The five ports the builder always wants, plus the FX conversion it wants
 * only when an account's currency does not already match `baseCurrency`.
 *
 * `fx` is optional so that a caller with nothing behind it (no `@ctx/investments`
 * wiring, or a fixture with every account in one currency) never has to supply
 * one — the builder degrades to excluding the mismatched account rather than
 * requiring the port to exist. Supplying it is what turns that exclusion into
 * an actual conversion; see `FxPort`'s header.
 *
 * `planning` (WP 4.9) is optional for a narrower reason: three composition
 * sites construct this object (`modules.ts`' `insightsModule`,
 * `routes/insights.ts`' on-demand run, and the tests), and making it required
 * would have to land in all of them at once. Absent, `goals.list`,
 * `risk.profile` and `plan.projection` emit **no key** — the same outcome as a
 * holder with no goals — and `wp4.9-advisor-catalog-v3.md` hands the
 * orchestrator the one line per site that binds `createInsightsPlanningPort`.
 */
export interface SnapshotPorts {
  readonly ledger: LedgerPort;
  readonly budget: BudgetPort;
  readonly recurring: RecurringPort;
  readonly investments: InvestmentsPort;
  readonly marketData: MarketDataPort;
  readonly fx?: FxPort;
  readonly planning?: PlanningPort;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export interface FakeLedgerData {
  readonly accounts?: readonly InsightsAccount[];
  readonly netWorthTrend?: readonly { readonly month: string; readonly netWorth: Money }[];
  readonly cashflow?: readonly MonthlyCashflowRow[];
  readonly categorySpend?: readonly CategorySpendRow[];
  readonly merchants?: readonly MerchantSpendRow[];
  readonly transactions?: readonly InsightsTransaction[];
}

/**
 * A `LedgerPort` over fixed rows.
 *
 * Not a mock: every method honours its own `months`/`limit` bound, so a test
 * that asks for 12 months of a 24-month fixture gets 12. A fake that ignored
 * the bounds would let a builder bug — emitting more history than the scope
 * allows — pass every suite in this package.
 */
export function inMemoryLedgerPort(data: FakeLedgerData): LedgerPort {
  return {
    listAccounts() {
      return Promise.resolve(data.accounts ?? []);
    },
    netWorthTrend(input) {
      const rows = [...(data.netWorthTrend ?? [])].sort((a, b) => a.month.localeCompare(b.month));
      return Promise.resolve(rows.slice(Math.max(0, rows.length - input.months)));
    },
    monthlyCashflow(input) {
      const rows = [...(data.cashflow ?? [])].sort((a, b) => a.month.localeCompare(b.month));
      return Promise.resolve(rows.slice(Math.max(0, rows.length - input.months)));
    },
    categorySpend() {
      return Promise.resolve(data.categorySpend ?? []);
    },
    topMerchants(input) {
      const rows = [...(data.merchants ?? [])].sort((a, b) =>
        a.total.minor === b.total.minor
          ? a.merchantId.localeCompare(b.merchantId)
          : a.total.minor < b.total.minor
            ? -1
            : 1,
      );
      return Promise.resolve(rows.slice(0, Math.max(0, input.limit)));
    },
    listTransactions(input) {
      const rows = [...(data.transactions ?? [])]
        .filter((row) => row.date >= input.from && row.date <= input.to)
        .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
      return Promise.resolve(rows.slice(0, Math.max(0, input.limit)));
    },
  };
}

export function inMemoryBudgetPort(period: InsightsBudgetPeriod | null): BudgetPort {
  return {
    currentPeriod(input) {
      if (period === null) return Promise.resolve(null);
      // The fake honours the half-open interval too. A builder that asked for a
      // period outside the one it has should get `null`, not the only row in
      // the fixture, or "no budget exists" is untestable.
      const inside = input.today >= period.startDate && input.today < period.endDate;
      return Promise.resolve(inside ? period : null);
    },
  };
}

export function inMemoryRecurringPort(streams: readonly InsightsRecurringStream[]): RecurringPort {
  return {
    listStreams() {
      return Promise.resolve(streams);
    },
  };
}

/**
 * An `InvestmentsPort` over fixed blocks.
 *
 * Both methods honour `null` as a first-class answer rather than returning an
 * empty object, because "no portfolio" and "an empty portfolio" are the
 * distinction the whole no-key rule rests on and a fake that collapsed them
 * would make `'a portfolio-less holder gets no holdings key'` untestable.
 */
export function inMemoryInvestmentsPort(data: {
  readonly holdings?: InsightsHoldings | null;
  readonly liabilities?: InsightsLiabilities | null;
}): InvestmentsPort {
  return {
    holdings() {
      return Promise.resolve(data.holdings ?? null);
    },
    liabilities() {
      return Promise.resolve(data.liabilities ?? null);
    },
  };
}

export function inMemoryMarketDataPort(rates: InsightsMarketRates | null): MarketDataPort {
  return {
    rates() {
      return Promise.resolve(rates);
    },
  };
}

/**
 * An `FxPort` over a fixed rate table, keyed `"FROM/TO"` (e.g. `"CAD/USD"`).
 *
 * Deliberately dumb — a lookup, not a cross-rate calculator — because the
 * arithmetic this fake needs to get right belongs to `@ctx/investments`'s own
 * `FxReader` and is proven there; this one exists only to let the builder's
 * own conversion call be exercised without wiring the real reader in.
 */
export function inMemoryFxPort(rates: Readonly<Record<string, string>>): FxPort {
  return {
    convert({ amount, toCurrency }) {
      if (amount.currency === toCurrency) return Promise.resolve(amount);
      const factor = rates[`${amount.currency}/${toCurrency}`];
      if (factor === undefined) return Promise.resolve(null);
      return Promise.resolve(Money.multiplyByDecimal(Money.of(amount.minor, toCurrency), factor));
    },
  };
}

/**
 * A `PlanningPort` over fixed answers.
 *
 * Each method returns its fixture verbatim — `null` stays `null` — so a test
 * can distinguish "no goals" from "an empty goal list" the way the builder has
 * to. Neither this fake nor the real port computes anything: the reduction to
 * ratios and ages is the composition root's, and it is proven over a real
 * database in `apps/api/test/db/phase4-advisors.test.ts`.
 */
export function inMemoryPlanningPort(data: {
  readonly goals?: readonly InsightsGoal[] | null;
  readonly riskProfile?: InsightsRiskProfile | null;
  readonly projection?: InsightsPlanProjection | null;
}): PlanningPort {
  return {
    goals() {
      return Promise.resolve(data.goals ?? null);
    },
    riskProfile() {
      return Promise.resolve(data.riskProfile ?? null);
    },
    projection() {
      return Promise.resolve(data.projection ?? null);
    },
  };
}

/** Five empty ports. What a builder sees on a fresh install. */
export function emptyPorts(): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({}),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
    investments: inMemoryInvestmentsPort({}),
    marketData: inMemoryMarketDataPort(null),
  };
}
