// SPDX-License-Identifier: MIT
/**
 * The three read ports the snapshot is built from — and the reason there are
 * exactly three of them and not one.
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
 * None of the three has a write method. Insights proposes; it does not act
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
 * pass.
 */
import type { DateOnly, Money } from '@core/kernel';

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

/** The three ports, as one object, because the builder always wants all three. */
export interface SnapshotPorts {
  readonly ledger: LedgerPort;
  readonly budget: BudgetPort;
  readonly recurring: RecurringPort;
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

/** Three empty ports. What a builder sees on a fresh install. */
export function emptyPorts(): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({}),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
  };
}
