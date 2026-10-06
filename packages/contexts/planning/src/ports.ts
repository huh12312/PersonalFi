// SPDX-License-Identifier: MIT
/**
 * The four ports the net-worth snapshotter reads its world through.
 *
 * Every input to `net_worth_daily` belongs to somebody else: the account
 * roster and its balances are `@ctx/ledger`'s, holdings and prices and FX rates
 * are `@ctx/investments`'. 08 §1.6 draws the arrows down — planning → investments
 * → ledger — so planning *may* import those contexts' types, and
 * `scripts/eslint-boundaries.js` says so explicitly. What it may never do is
 * read their tables: `pnpm lint:schema-ownership` refuses any SQL in this
 * package that names `accounts`, `holdings`, `prices` or `fx_rates`, and these
 * interfaces are what make that refusal survive contact with the code rather
 * than being a rule everyone remembers until the first deadline.
 *
 * ## Why they are declared here and not imported
 *
 * A port is the *consumer's* description of what it needs. Importing
 * `@ctx/investments`' `PriceReader` wholesale would make every field that
 * reader ever grows a field this context depends on, and would make a change
 * over there a compile error over here for no reason a planning maintainer
 * could act on. So each interface below asks for the narrowest shape that
 * answers planning's question.
 *
 * They are nonetheless *deliberately structural mirrors*: `createPriceReader`
 * and `createFxReader` from `@ctx/investments` satisfy `PriceReader` and
 * `FxReader` here with no adapter at all, which is what lets
 * `apps/api/src/domain.ts` wire the real readers straight in (see
 * `docs/evidence/phase-3/wp3.w-wiring.md` §3 for the shape the wiring batch
 * expects). `test/ports.test.ts` holds the compile-time assignability check, so
 * the day one of them drifts is the day a test goes red rather than the day the
 * composition root stops building.
 *
 * ## The four booleans (07 §4.1)
 *
 * `BalancesReader.accounts()` returns all four of `onBudget`, `inNetWorth`,
 * `isLiquid` and `isInvestable`, and the snapshotter sums a separate total over
 * each. **Today `accounts` carries only `include_in_net_worth`**
 * (0004_ledger.sql). `onBudget` is derivable from `@ctx/budgeting`'s exclusion
 * list (`budgets.off_budget_account_ids`, 0009_budgeting.sql — which says in as
 * many words that adding an `on_budget` column would be Budgeting writing
 * Ledger's table), and `isLiquid` / `isInvestable` **do not exist anywhere**.
 * WP 3.8 does not add them: they are `@ctx/ledger` columns and this work package
 * opens one table in one other context already. The port demands all four so the
 * composition root has to state its derivation out loud — 07 §4.1's class table
 * applied to `AccountKind` is the intended one, and `defaultFlagsFor` below is
 * that derivation, exported so the adapter reuses it rather than inventing a
 * second. `docs/evidence/phase-3/wp3.8-net-worth.md` §7 records the gap.
 */
import type { DateOnly, Money } from '@core/kernel';
import type { AssumptionsLike, ProjectionPlan } from './engine/boundary.ts';

/** The account classes the interpolation policy and the flag defaults turn on. */
export const ACCOUNT_KINDS = [
  'cash',
  'credit',
  'loan',
  'investment',
  'manual_asset',
  'other',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Which side of the balance sheet. Never inferred from the sign of a balance. */
export type AccountSide = 'asset' | 'liability';

/**
 * 07 §4.1's four booleans, each independent of the other three.
 *
 * They are one object rather than four loose parameters so that no call site can
 * pass them in the wrong order, and they are never collapsed into a single
 * "counts towards net worth" flag — "get these four booleans right and every
 * downstream rule's denominator is unambiguous" is the whole point, and the
 * property test `'the four account booleans are independent'` is what keeps a
 * future refactor from quietly deriving one from another.
 */
export interface AccountFlags {
  readonly onBudget: boolean;
  readonly inNetWorth: boolean;
  readonly isLiquid: boolean;
  readonly isInvestable: boolean;
}

/**
 * 07 §4.1's class table, as the derivation the composition root owes.
 *
 * Only `inNetWorth` has a column today; the other three are computed here so
 * there is exactly one place to change when `@ctx/ledger` grows them. Cash is
 * liquid and not investable; an investment account is investable and not liquid
 * (selling a position to buy groceries is not what "liquid" means in 07 §4.1);
 * a credit card is on-budget because its spending is spending; a mortgage is
 * neither on-budget nor liquid nor investable but is very much in net worth.
 */
export function defaultFlagsFor(kind: AccountKind, inNetWorth = true): AccountFlags {
  switch (kind) {
    case 'cash':
      return { onBudget: true, inNetWorth, isLiquid: true, isInvestable: false };
    case 'credit':
      return { onBudget: true, inNetWorth, isLiquid: false, isInvestable: false };
    case 'loan':
      return { onBudget: false, inNetWorth, isLiquid: false, isInvestable: false };
    case 'investment':
      return { onBudget: false, inNetWorth, isLiquid: false, isInvestable: true };
    case 'manual_asset':
      return { onBudget: false, inNetWorth, isLiquid: false, isInvestable: false };
    case 'other':
      return { onBudget: false, inNetWorth, isLiquid: false, isInvestable: false };
  }
}

/** One account, as the snapshotter needs to see it. */
export interface PlanningAccount {
  readonly accountId: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly side: AccountSide;
  /** The account's own currency. D4's `native`; the row's `base_currency` is the other half. */
  readonly currency: string;
  readonly flags: AccountFlags;
  /** A closed account contributes nothing from the day it closed. */
  readonly closedAt: Date | null;
  /**
   * WP 9.2 (O-2): how the holder said to value an investment or crypto account.
   * Absent or `'holdings'`: Σ quantity x price, an account with no priced
   * holdings is unvalued, never zero. `'balance'`: the same, but an account with
   * none falls back to its latest balance, labelled as such on the breakdown.
   */
  readonly valuation?: 'holdings' | 'balance';
}

/** A point-in-time balance observation, in the account's own currency. */
export interface BalanceObservation {
  readonly accountId: string;
  /** The business date of the observation, which may be earlier than the date asked for. */
  readonly date: string;
  readonly currentMinor: bigint;
  readonly currency: string;
  readonly source: 'provider' | 'manual' | 'derived';
}

/**
 * `@ctx/ledger`'s half of the world.
 *
 * `transactionsTotalOn` is the one method that exists solely for the backfill of
 * 04 §5.4 — `balance(d-1) = balance(d) - Σ txns(d)` — and `src/interpolate.ts`
 * refuses to call it for an investment account. It returns the *signed* sum in
 * the account's own currency, so an inflow is positive and an outflow negative,
 * matching the sign convention of the balance it is being subtracted from.
 */
export interface BalancesReader {
  accounts(userId: string, asOf: string): Promise<readonly PlanningAccount[]>;
  /** The freshest observation on or before `date`, or `null` if the account never reported. */
  balanceOnOrBefore(
    userId: string,
    accountId: string,
    date: string,
  ): Promise<BalanceObservation | null>;
  /** The signed minor-unit sum of everything that posted to this account on `date`. */
  transactionsTotalOn(userId: string, accountId: string, date: string): Promise<bigint>;
}

/** One position, as the snapshotter needs to see it. */
export interface HoldingObservation {
  readonly accountId: string;
  readonly securityId: string;
  /** An exact decimal string. Never a `number` — D3, and a share count is not an integer. */
  readonly quantity: string;
  /** The business date this quantity was observed on. */
  readonly asOfDate: string;
}

/**
 * `@ctx/investments`' holdings half.
 *
 * `bracketingObservations` is what makes 04 §5.4's *labelled linear
 * interpolation* possible: an investment account's history is rebuilt from
 * quantity x price, and the quantity between two observations is interpolated
 * and said to be. A reader that could only answer "the latest on or before"
 * would silently carry a stale share count forward through a month of
 * contributions and call the result observed.
 */
export interface HoldingsReader {
  positionsOnOrBefore(
    userId: string,
    accountId: string,
    date: string,
  ): Promise<readonly HoldingObservation[]>;
  bracketingObservations(
    userId: string,
    accountId: string,
    securityId: string,
    date: string,
  ): Promise<{
    readonly before: HoldingObservation | null;
    readonly after: HoldingObservation | null;
  }>;
}

/**
 * The subset of `@ctx/investments`' `PricePoint` this context reasons about.
 *
 * `staleness` and `rung` are both here because 08 §3.7's rule needs both: a
 * price the clock says is over 24 hours old is stale, and so is one the ladder
 * answered from its `last_known` rung, and neither implies the other.
 */
export interface PriceQuote {
  readonly close: string;
  readonly currency: string;
  readonly priceDate: string;
  readonly staleness: 'FRESH' | 'STALE';
  readonly rung: string;
  readonly carriedForward: boolean;
}

/**
 * `null` is an ordinary answer — a security nobody has priced yet — and it is
 * **not** the same thing as a missing FX rate. 08 §3.7 requires the day to seal
 * anyway, flagged, which is why this returns rather than throws.
 */
export interface PriceReader {
  price(securityId: string, date: string, currency: string): Promise<PriceQuote | null>;
}

/** The subset of `@ctx/investments`' `FxRate` D4 requires to be stored. */
export interface FxQuote {
  /** 1 `base` = `rate` `quote`, as an exact decimal string. */
  readonly rate: string;
  /** The date of the observation actually used. This is D4's `fx_rate_date`. */
  readonly rateDate: string;
  /** `'identity'` when and only when the two codes were literally equal. */
  readonly source: string;
}

/**
 * The FX half.
 *
 * **Throws `FxRateUnavailable` rather than answering.** That asymmetry with
 * `PriceReader` is the entire point of D4 and 08 §6.6: a security with no price
 * is a visible hole, whereas a foreign balance converted at a plausible 1.0 is
 * an invisible error worth the whole spread. `src/fx.ts` never catches it.
 */
export interface FxReader {
  rate(from: string, to: string, date: string): Promise<FxQuote>;
}

/** Everything the snapshotter reads, in one bag, so a call site cannot half-wire it. */
export interface SnapshotPorts {
  readonly balances: BalancesReader;
  readonly holdings: HoldingsReader;
  readonly prices: PriceReader;
  readonly fx: FxReader;
}

// ===========================================================================
// WP 4.3 — revealed behaviour: the two ports the rolling-12-month derivation
// reads through
// ===========================================================================
//
// 09 GOAL-4: *"contribution rates are derived from observed transfers over the
// trailing 12 months … and retirement spending is anchored to his observed
// non-savings spending (with one-offs excluded)."* Two halves, two owners, two
// arrows:
//
//   * **`CashflowReader` — `plan → ledger`.** Who owns which account, which of
//     them is a tax bucket, what arrived in each, and which arrivals Phase 1's
//     pairing already labelled as one leg of an internal transfer. 08 §1.6 draws
//     this arrow, so the composition root may satisfy it over `@ctx/ledger`'s
//     `listAccounts` and `transactions`/`transfer_links`. (The dispatch calls
//     this half the `ContributionsReader`; it is named for what it returns,
//     because the same inflows answer income as well as contributions.)
//   * **`SpendingReader` — no arrow at all.** 08 §1.6 draws *no* `plan → budg`
//     edge, yet 07 §5.6's `floor_spending = essential_spend` is defined over
//     D19's NEED-class budget categories, which only `@ctx/budgeting` knows.
//     So the answer arrives through this port, bound in `apps/api/src/domain.ts`,
//     and this package never names `@ctx/budgeting` — `scripts/eslint-boundaries.js`
//     refuses the import outright, in `test/` as well as `src/`.
//
// `SpendingReader` is a **deliberate structural mirror** of three functions
// `@ctx/budgeting` already exports — `listBudgets`, `listPeriods`, `getPeriod`
// — with the executor argument closed over. Its binding therefore maps no
// field: every `BudgetPeriodView` budgeting returns is handed through as-is.
// `test/ports.test.ts` proves that with the TypeScript compiler (a planning
// test may not import budgeting, so it type-checks a probe that can), and the
// day either side drifts is the day that test goes red.

/**
 * 07 §5.2's four tax buckets — the recursion is run once per bucket.
 *
 * **`@ctx/ledger` does not carry this.** `accounts` has a provider `subtype`
 * (`401k`, `roth`, `hsa`, …) and no tax-treatment column, exactly as it has
 * `include_in_net_worth` and none of 07 §4.1's other three booleans. WP 4.3
 * does not add one (that is Ledger's migration, and 09 AC-7's "classify each
 * account's role" is the user-facing half of it); `defaultTaxBucketFor` below is
 * the interim derivation, exported so the composition root reuses it rather than
 * inventing a second — `defaultFlagsFor`'s precedent, one table up.
 */
export const TAX_BUCKETS = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const;
export type TaxBucket = (typeof TAX_BUCKETS)[number];

/**
 * Provider subtypes, lower-cased, that name a tax-advantaged wrapper. Plaid's
 * investment-subtype vocabulary is the source; anything not listed here on an
 * investment account is `TAXABLE`, which is the conservative reading (it taxes
 * growth the projection might otherwise have sheltered).
 */
const TAX_DEFERRED_SUBTYPES: ReadonlySet<string> = new Set([
  '401a',
  '401k',
  '403b',
  '457b',
  'ira',
  'keogh',
  'lira',
  'pension',
  'profit sharing plan',
  'retirement',
  'rrsp',
  'sarsep',
  'sep ira',
  'simple ira',
  'thrift savings plan',
  'traditional ira',
]);
const ROTH_SUBTYPES: ReadonlySet<string> = new Set([
  'roth',
  'roth 401k',
  'roth 403b',
  'roth ira',
  // Canada's tax-free account: contributed after tax, withdrawn free — Roth's shape.
  'tfsa',
]);
const HSA_SUBTYPES: ReadonlySet<string> = new Set(['hsa', 'health savings account']);
/**
 * Tax-advantaged, but not one of the four retirement buckets: education
 * accounts fund a different goal, and folding a 529 into `TAX_DEFERRED` would
 * let college money pay for retirement in the projection.
 */
const NOT_A_RETIREMENT_BUCKET: ReadonlySet<string> = new Set([
  '529',
  'education savings account',
  'ugma',
  'utma',
]);

/**
 * The account's tax bucket, or `null` when it is not an invested account at
 * all (cash, credit, a loan, a house) or is an invested account for a
 * non-retirement purpose (a 529).
 *
 * Only an `investment`-kind account has a bucket: a savings account is
 * *savings* in 09 AC-7's role vocabulary, not *taxable*, and a transfer into it
 * is not a retirement contribution. Crypto maps to `investment` in the
 * composition root's `planningKindOf`, so a crypto exchange is `TAXABLE` here,
 * which is what it is.
 */
export function defaultTaxBucketFor(kind: AccountKind, subtype: string | null): TaxBucket | null {
  return defaultTaxBucketWithBasis(kind, subtype).bucket;
}

/**
 * `defaultTaxBucketFor`, and *why*: `subtype` when the provider's own subtype
 * named the bucket, `fallback` when nothing recognised it and `TAXABLE` is the
 * conservative reading, `none` when the account has no bucket at all. WP 9.2's
 * accounts screen says "from Plaid: 401k" for the first and "assumed taxable —
 * no recognised subtype" for the second, and the difference is the whole point
 * of CF-16: a mis-typed IRA that falls back to `TAXABLE` must not look like a
 * fact the provider stated.
 */
export function defaultTaxBucketWithBasis(
  kind: AccountKind,
  subtype: string | null,
): { readonly bucket: TaxBucket | null; readonly basis: 'subtype' | 'fallback' | 'none' } {
  if (kind !== 'investment') return { bucket: null, basis: 'none' };
  const key = (subtype ?? '').trim().toLowerCase();
  if (NOT_A_RETIREMENT_BUCKET.has(key)) return { bucket: null, basis: 'none' };
  if (ROTH_SUBTYPES.has(key)) return { bucket: 'ROTH', basis: 'subtype' };
  if (HSA_SUBTYPES.has(key)) return { bucket: 'HSA', basis: 'subtype' };
  if (TAX_DEFERRED_SUBTYPES.has(key)) return { bucket: 'TAX_DEFERRED', basis: 'subtype' };
  return { bucket: 'TAXABLE', basis: 'fallback' };
}

/**
 * What the holder has set on one account, as the projection needs to see it
 * (WP 9.2). Raw fields, `null` where nothing is set: the effective tax bucket is
 * already on `CashflowAccount.taxBucket`, and these exist so the input digest
 * covers a change to *any* of the three — a role or a valuation change moves no
 * bucket today and must still make a stored baseline read stale.
 */
export interface AccountOverlayFacts {
  readonly taxTreatment: TaxBucket | null;
  readonly role: string | null;
  readonly valuation: 'holdings' | 'balance' | null;
}

/**
 * One account, as the revealed-behaviour derivation needs to see it.
 *
 * `PlanningAccount` plus a bucket — and *not* a widened `PlanningAccount`,
 * because `apps/api/src/domain.ts` builds `PlanningAccount`s today and a new
 * required field there would break the composition root's build from inside
 * this package. `flags.onBudget` is the WP 3.8 derivation, reused:
 * `defaultFlagsFor(kind)` narrowed by `@ctx/budgeting`'s exclusion list.
 */
export interface CashflowAccount extends PlanningAccount {
  readonly taxBucket: TaxBucket | null;
  /**
   * WP 5.5 (wp4.6 §11 item 4): `'crypto'` for an account whose holdings are
   * crypto — Ledger's `crypto` account type, which `planningKindOf` maps to
   * `investment` and `defaultTaxBucketFor` therefore to `TAXABLE`. The
   * projection sums such an account out of its bucket and hands it to the
   * Monte Carlo as its own sleeve (07 §6.4: never folded into equity).
   * Optional so the composition root compiles before it binds it; absent means
   * "not crypto", which is exactly the behaviour before WP 5.5.
   */
  readonly sleeve?: 'crypto' | null;
  /**
   * WP 9.2: the holder's overlay on this account, `null` or absent when they have
   * set none. `taxBucket` above is the *effective* bucket — the overlay's tax
   * treatment where set, the provider-subtype default otherwise.
   */
  readonly overlay?: AccountOverlayFacts | null;
}

/**
 * One posted, positive-amount ledger row — money arriving in an account.
 *
 * The composition root drops what never moved money: pending rows, rows a
 * duplicate check superseded, provider tombstones. It does **not** drop what the
 * user excluded or what the pairing labelled: those are facts this derivation
 * must *name* when it sets them aside, and it cannot name what it never saw.
 */
export interface CashflowInflow {
  readonly transactionId: string;
  readonly accountId: string;
  /** `transactions.effective_date`. */
  readonly date: DateOnly;
  /** Positive, in the account's own currency, house sign convention. */
  readonly amount: Money;
  /** The resolved display name, so an exclusion can be named in words. */
  readonly label: string;
  /** 09 TX-10: the holder set this row aside. */
  readonly userExcluded: boolean;
  /** `@ctx/ledger`'s refund hint is set: money coming back, not money earned. */
  readonly isRefund: boolean;
  /**
   * When Phase 1's pairing (`transfer_links`) matched this row to an outflow
   * elsewhere, **the account that outflow left from**; `null` for an unpaired
   * row. This is the whole of "internal transfer" as this derivation sees it.
   */
  readonly transferCounterpartAccountId: string | null;
}

/**
 * `@ctx/ledger`'s half of revealed behaviour (`plan → ledger`, 08 §1.6).
 *
 * `historyStarts` exists because an empty month and an unobserved month are
 * different facts: twelve months of no contributions is a rate of zero, but
 * four months of history is not twelve months of anything, and 09 GOAL-4's
 * "trailing 12 months" must not annualise what it never saw.
 */
export interface CashflowReader {
  accounts(userId: string, asOf: string): Promise<readonly CashflowAccount[]>;
  /**
   * The earliest `effective_date` of any posted row, per account. An account
   * with no rows is absent from the map.
   */
  historyStarts(
    userId: string,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, DateOnly>>;
  /** Every posted row with a positive amount on these accounts in `[from, to]`, inclusive. */
  inflows(
    userId: string,
    accountIds: readonly string[],
    from: DateOnly,
    to: DateOnly,
  ): Promise<readonly CashflowInflow[]>;
}

/**
 * `@ctx/budgeting`'s `BudgetClass`, restated. 07 §1.6's 50/30/20 layer; `null`
 * is an honest "never classified", and is never read as either of the others.
 */
export type SpendingClass = 'NEED' | 'WANT' | 'SAVINGS';

/** The subset of `@ctx/budgeting`'s `BudgetLineView` this derivation reasons about. */
export interface SpendingLine {
  readonly id: string;
  readonly kind: 'category' | 'credit_card_payment';
  /** Opaque (`@ctx/categorization` owns categories). `null` iff a card-payment line. */
  readonly categoryId: string | null;
  readonly name: string | null;
  /**
   * The period's net activity on this envelope, **transfers already excluded
   * and refunds already netted by budgeting** (`transferExcludedCount`,
   * `refundNettedCount` on the same view). Negative is spending.
   */
  readonly activity: Money;
  readonly class: SpendingClass | null;
}

/** The subset of `@ctx/budgeting`'s `BudgetPeriodView`. */
export interface SpendingPeriod {
  readonly id: string;
  readonly startDate: DateOnly;
  /** **Exclusive**, as budgeting's own view documents. */
  readonly endDate: DateOnly;
  readonly lines: readonly SpendingLine[];
}

/** The subset of `@ctx/budgeting`'s `budgets` row. */
export interface SpendingBudget {
  readonly id: string;
  readonly currency: string;
}

/** The subset of `@ctx/budgeting`'s `BudgetPeriodSummary`. */
export interface SpendingPeriodSummary {
  readonly id: string;
  readonly startDate: DateOnly;
  /** Exclusive. */
  readonly endDate: DateOnly;
}

/**
 * `@ctx/budgeting`'s half of revealed behaviour — bound at the composition
 * root because 08 §1.6 draws no `plan → budg` arrow.
 *
 * Three methods, each `@ctx/budgeting`'s function of the same name with its
 * executor closed over. Choosing *which* periods fall in the window is this
 * context's job (`src/revealed.ts`), so the binding carries no logic to drift.
 */
export interface SpendingReader {
  listBudgets(input: { readonly userId: string }): Promise<readonly SpendingBudget[]>;
  listPeriods(input: {
    readonly userId: string;
    readonly budgetId: string;
  }): Promise<readonly SpendingPeriodSummary[]>;
  getPeriod(input: {
    readonly userId: string;
    readonly periodId: string;
  }): Promise<SpendingPeriod | null>;
}

/** Everything revealed behaviour reads, in one bag. */
export interface RevealedPorts {
  readonly cashflow: CashflowReader;
  readonly spending: SpendingReader;
}

// ===========================================================================
// WP 4.6 — the Monte Carlo port
// ===========================================================================
//
// WP 4.5 builds the Monte Carlo in a `worker_thread` (`src/engine/worker-host.ts`)
// concurrently with WP 4.6, so the projection service is written against this
// port — the consumer's description of its need, the `ports.ts` rule — and the
// composition root binds it to 4.5's worker host once that lands
// (`docs/evidence/phase-4/wp4.6-projection-service.md`, "For the orchestrator").
// Until then `MonteCarloRunner | null` is `null` in production and a
// Monte Carlo request is refused by name rather than quietly answered by the
// deterministic engine.
//
// The request is plain data and structured-cloneable end to end (Money is a
// bigint and a string; DateOnly is a string; the assumptions file is a frozen
// plain object), so the worker host can post it as-is. The outcome is **bands,
// never paths** (08 §7.2) and every amount in it is `Money`, already through
// `fromEngineAmount` on the worker's side of the boundary.

/** What one Monte Carlo run is asked. */
export interface MonteCarloRequest {
  readonly plan: ProjectionPlan;
  /** The resolved assumptions: the file's version, with the holder's overrides applied. */
  readonly assumptions: AssumptionsLike;
  /** Unsigned 64-bit. The only source of randomness the run may use. */
  readonly seed: bigint;
  readonly paths: number;
  /**
   * WP 5.5: crypto held today, the plan's currency — WP 4.5's own sleeve
   * (`runMonteCarloInWorker`'s `cryptoHolding`: Student-t, funds last, and the
   * crypto-at-zero projection beside it). Absent when the holder has none. The
   * adapter passes it straight through; a runner that drops it answers for a
   * plan with crypto valued at zero, which the input digest does not describe.
   */
  readonly cryptoHolding?: Money;
}

/** One projected year's band: end-of-year wealth in today's dollars. */
export interface MonteCarloPeriod {
  readonly index: number;
  readonly age: number;
  readonly calendarYear: number;
  readonly p5: Money;
  readonly p10: Money;
  readonly p25: Money;
  readonly p50: Money;
  readonly p75: Money;
  readonly p90: Money;
  readonly p95: Money;
}

/** What one Monte Carlo run answers. `seed`, `paths` and `engineVersion` are echoed and checked. */
export interface MonteCarloOutcome {
  readonly engineVersion: string;
  readonly seed: bigint;
  readonly paths: number;
  /** A decimal string in [0, 1] (`fromEngineRatio`), never a float. */
  readonly successProbability: string;
  readonly periods: readonly MonteCarloPeriod[];
}

/**
 * WP 4.5's Monte Carlo, as the projection service needs it.
 *
 * `engineVersion` is a property rather than only a field of the outcome
 * because it is an input to the **cache key**: the service must know which
 * engine would answer before it can decide whether it already has the answer.
 * An outcome whose echoed version, seed or path count differs from the request
 * is refused (`planning.monte_carlo_outcome_mismatch`) — a runner that
 * silently ignored the seed is exactly the failure "identical seed ⇒ identical
 * bytes" exists to catch.
 */
export interface MonteCarloRunner {
  readonly engineVersion: string;
  run(request: MonteCarloRequest): Promise<MonteCarloOutcome>;
}
