// SPDX-License-Identifier: MIT
/**
 * Revealed behaviour, rolling twelve months (WP 4.3).
 *
 * 09 GOAL-4, normative: *"contribution rates are derived from observed
 * transfers over the trailing 12 months (and are overridable), and retirement
 * spending is anchored to his observed non-savings spending (with one-offs
 * excluded)."* This module is that sentence and nothing more: a pure derivation
 * over the two ports in `src/ports.ts` (`CashflowReader`, `plan → ledger`;
 * `SpendingReader`, bound at the composition root because 08 §1.6 draws no
 * `plan → budg` arrow). It writes nothing, emits nothing and holds no clock.
 *
 * ## What it derives
 *
 *   * **Contributions, per tax bucket.** Money arriving in a `TAXABLE`,
 *     `TAX_DEFERRED`, `ROTH` or `HSA` account (07 §5.2's four) — *unless*
 *     Phase 1's pairing matched it to an outflow from another invested account.
 *     That is what "internal transfer" means here, and it is precise on purpose:
 *     checking → brokerage is also a paired transfer, and it is exactly the
 *     contribution GOAL-4 wants counted; brokerage → Roth IRA is money that was
 *     already saved changing wrappers, and counting it would count one dollar
 *     twice. An *unpaired* arrival (a payroll deferral, an employer match, a
 *     deposit from an unlinked bank) is a contribution from outside the linked
 *     accounts.
 *   * **Income** — take-home deposits into on-budget cash accounts, plus the
 *     contributions that arrived from outside the linked accounts (a 401(k)
 *     deferral never passes through checking, so without it the savings rate's
 *     denominator would omit exactly the pay that was saved). **This is net of
 *     tax and gross of saving.** The dispatch says "gross income"; a ledger
 *     never sees withholding, so gross-of-tax income is not derivable from it
 *     and is not claimed. `basis` says so on every result.
 *   * **Savings rate** = contributions ÷ income, a decimal string to four
 *     places, exact until one half-even rounding.
 *   * **Essential and discretionary spend** — the NEED-class and WANT-class
 *     budget lines' activity, each summed on its own. Unclassified lines are
 *     their own total and are never apportioned to either. With no NEED-class
 *     category at all, essential spend is `not_derivable` — never a total minus
 *     a guess, and never a default share of a total. 07 §5.6 makes this number
 *     the spending *floor* of the guardrail rule; a floor invented from a
 *     percentage is a floor nobody chose.
 *
 * ## Every number carries its provenance
 *
 * `source: 'DERIVED'` (09 GOAL-2: *derived from your data* vs *default* vs
 * *you set this* is on screen), the window it was taken over, how many months
 * of it were actually observed, and how many observations it rests on. Below
 * `minimumMonths` of observed history the answer is `insufficient_history`,
 * which carries **no amount field at all** — there is nothing for a caller to
 * read by mistake.
 *
 * ## Every exclusion is named
 *
 * Anything this derivation read and then set aside is in `exclusions` with the
 * row it came from and the reason in words: a one-off (`src/windows.ts`'s
 * detector), an internal transfer, a refund, a row the holder excluded (09
 * TX-10), a foreign-currency row (never converted at a guessed rate — D4), or a
 * row in a month the ledger saw only part of. 09 E10's *"a $40k house-deposit
 * move is not a monthly contribution rate"* is the case the list exists for: the
 * move is excluded, and the holder can see that it was and why.
 *
 * ## One-offs, and where they are looked for
 *
 * Per series, never pooled: a bucket's contributions are judged against that
 * bucket's other contributions (a $2,000 half-yearly brokerage top-up is not an
 * outlier against $900 payroll deferrals into a 401(k)), and a category's spend
 * against that category's other non-zero periods. Only *non-zero* periods count
 * as spending observations — an annual insurance premium is one observation,
 * not one spike among eleven zeros, and with fewer than `oneOffMinimumPeers`
 * peers nothing is judged at all (`too_few_peers` is reported, not guessed).
 * Income is **not** one-off filtered: a bonus is income, and a detector cannot
 * tell it from an inheritance. The holder's TX-10 exclusion is the tool for
 * that, and it is honoured and named.
 */
import { DateOnly, Money, type Money as MoneyType } from '@core/kernel';
import type { ContributionPlanInput } from './contributions.ts';
import {
  TAX_BUCKETS,
  type CashflowAccount,
  type CashflowInflow,
  type RevealedPorts,
  type SpendingBudget,
  type SpendingClass,
  type SpendingLine,
  type SpendingPeriod,
  type TaxBucket,
} from './ports.ts';
import {
  MAX_WINDOW_MONTHS,
  divideHalfEven,
  integerSqrt,
  monthsFullyCovered,
  observedSpan,
  parseThreshold,
  ratioToDecimal,
  separateOneOffs,
  trailingWindow,
  type OneOffEvidence,
  type OneOffThresholds,
  type TrailingWindow,
} from './windows.ts';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface RevealedParameters {
  /** 09 GOAL-4's "trailing 12 months". */
  readonly windowMonths: number;
  /**
   * Below this many observed months the answer is `insufficient_history`.
   * Default 6: half the window. Four months of a twice-yearly contribution can
   * contain zero of them or two, and neither annualises to the truth.
   */
  readonly minimumMonths: number;
  /** `m` — see `src/windows.ts`'s `OneOffThresholds`. A decimal string, never a `number`. */
  readonly oneOffMedianMultiple: string;
  /** `k`, in population standard deviations. A decimal string. */
  readonly oneOffSigma: string;
  /** A series with fewer peers than this is never judged. */
  readonly oneOffMinimumPeers: number;
}

export const REVEALED_DEFAULTS: RevealedParameters = Object.freeze({
  windowMonths: 12,
  minimumMonths: 6,
  oneOffMedianMultiple: '4',
  oneOffSigma: '3',
  oneOffMinimumPeers: 3,
});

export class RevealedParametersInvalid extends Error {
  override readonly name = 'RevealedParametersInvalid';
  readonly code = 'planning.revealed_parameters_invalid';
}

function resolveParameters(overrides: Partial<RevealedParameters> | undefined): {
  readonly parameters: RevealedParameters;
  readonly thresholds: OneOffThresholds;
} {
  const parameters: RevealedParameters = Object.freeze({ ...REVEALED_DEFAULTS, ...overrides });
  const whole = (what: string, value: number, low: number, high: number): void => {
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      throw new RevealedParametersInvalid(
        `${what} must be a whole number from ${String(low)} to ${String(high)}, got ${String(value)}`,
      );
    }
  };
  whole('windowMonths', parameters.windowMonths, 1, MAX_WINDOW_MONTHS);
  whole('minimumMonths', parameters.minimumMonths, 1, parameters.windowMonths);
  whole('oneOffMinimumPeers', parameters.oneOffMinimumPeers, 1, 1000);
  try {
    return {
      parameters,
      thresholds: {
        medianMultiple: parseThreshold('oneOffMedianMultiple', parameters.oneOffMedianMultiple),
        sigma: parseThreshold('oneOffSigma', parameters.oneOffSigma),
        minimumPeers: parameters.oneOffMinimumPeers,
      },
    };
  } catch (error) {
    throw new RevealedParametersInvalid(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** The window a number was taken over, and how much of it was actually seen. */
export interface RevealedWindow {
  /** First of the window's first month. */
  readonly from: DateOnly;
  /** Last day of the window's last complete month. */
  readonly to: DateOnly;
  readonly months: number;
  /** First day of observed data inside the window; `null` if none was observed. */
  readonly observedFrom: DateOnly | null;
  readonly monthsObserved: number;
}

interface Provenance {
  readonly source: 'DERIVED';
  readonly window: RevealedWindow;
  /** How many observations the number rests on, after every exclusion. */
  readonly observationCount: number;
}

/** A derived amount. `total` is what was observed; `annual` and `monthly` scale it, each rounded once. */
export interface DerivedAmountValue extends Provenance {
  readonly status: 'derived';
  readonly total: MoneyType;
  readonly annual: MoneyType;
  readonly monthly: MoneyType;
}

/** Too little history. Carries no amount, so there is nothing to misread. */
export interface InsufficientHistory extends Provenance {
  readonly status: 'insufficient_history';
  readonly minimumMonths: number;
}

/** The data needed does not exist (no budget, no NEED class, no bucketed account). */
export interface NotDerivable extends Provenance {
  readonly status: 'not_derivable';
  readonly reason: string;
}

export type DerivedAmount = DerivedAmountValue | InsufficientHistory | NotDerivable;

export interface DerivedRateValue extends Provenance {
  readonly status: 'derived';
  /** A decimal string with four places (`'0.0496'`). Never a `number`. */
  readonly rate: string;
}

export type DerivedRate = DerivedRateValue | InsufficientHistory | NotDerivable;

export type ExclusionReason =
  | 'one_off'
  | 'internal_transfer'
  | 'refund'
  | 'user_excluded'
  | 'currency_mismatch'
  | 'partial_month';

/** Something the derivation read and set aside, with the reason in words. */
export interface RevealedExclusion {
  readonly derivation: 'contributions' | 'income' | 'spending';
  readonly reason: ExclusionReason;
  /** The transaction's date, or a budget period's first day. */
  readonly date: DateOnly;
  readonly amount: MoneyType;
  /** What it was: the transaction's name, or a category and its period. */
  readonly label: string;
  readonly explanation: string;
  readonly transactionId: string | null;
  readonly accountId: string | null;
  readonly taxBucket: TaxBucket | null;
  readonly periodId: string | null;
  readonly categoryId: string | null;
}

export type OneOffTestOutcome = 'applied' | 'too_few_peers';

export interface SpendingCategorySummary {
  readonly categoryId: string | null;
  readonly name: string | null;
  /** The class of its most recent period in the window (classes are frozen per period). */
  readonly class: SpendingClass | null;
  readonly observationCount: number;
  readonly oneOffTest: OneOffTestOutcome;
}

export interface RevealedBehavior {
  readonly source: 'DERIVED';
  readonly asOf: DateOnly;
  readonly baseCurrency: string;
  readonly parameters: RevealedParameters;
  readonly income: {
    /** Take-home plus contributions from outside the linked accounts. */
    readonly total: DerivedAmount;
    readonly takeHome: DerivedAmount;
    readonly fromContributions: DerivedAmount;
    /** Whether `total` includes `fromContributions` (it cannot when contributions were not derived). */
    readonly includesContributions: boolean;
    readonly basis: string;
  };
  readonly contributions: {
    readonly total: DerivedAmount;
    readonly byBucket: Readonly<Record<TaxBucket, DerivedAmount>>;
    readonly oneOffTest: Readonly<Record<TaxBucket, OneOffTestOutcome>>;
  };
  readonly savingsRate: DerivedRate;
  readonly spending: {
    /** NEED-class lines. 07 §5.6's `floor_spending`. */
    readonly essential: DerivedAmount;
    /** WANT-class lines. */
    readonly discretionary: DerivedAmount;
    /** Category lines nobody classified. Never apportioned to either of the above. */
    readonly unclassified: DerivedAmount;
    /** essential + discretionary + unclassified — 09 GOAL-4's "non-savings spending". */
    readonly nonSavings: DerivedAmount;
    /** SAVINGS-class lines: shown so their omission from spending is visible. */
    readonly savingsClass: DerivedAmount;
    /** The budget the periods came from, when there was one. */
    readonly budgetId: string | null;
    readonly categories: readonly SpendingCategorySummary[];
  };
  readonly exclusions: readonly RevealedExclusion[];
}

export const INCOME_BASIS =
  'take-home deposits into on-budget cash accounts, plus contributions that arrived from ' +
  'outside the linked accounts (payroll deferrals, employer match); net of tax, gross of saving ' +
  '— a ledger never sees withholding, so gross-of-tax income is not derived';

// ---------------------------------------------------------------------------
// Facts: what the ports return, gathered once
// ---------------------------------------------------------------------------

export interface RevealedInput {
  readonly userId: string;
  readonly asOf: DateOnly;
  readonly baseCurrency: string;
  readonly parameters?: Partial<RevealedParameters>;
}

/** Everything the derivation reads, so the arithmetic can be a pure function of it. */
export interface RevealedFacts {
  readonly accounts: readonly CashflowAccount[];
  readonly historyStarts: ReadonlyMap<string, DateOnly>;
  readonly inflows: readonly CashflowInflow[];
  /** Every budget the holder has, oldest first — `listBudgets`' order. */
  readonly budgets: readonly SpendingBudget[];
  /** The first budget's periods that fall wholly inside the window. */
  readonly periods: readonly SpendingPeriod[];
}

/**
 * Read the facts through the ports. The only I/O in this module.
 *
 * Budget choice: the **oldest** budget, which is the choice
 * `createInsightsBudgetPort` already makes at the composition root. Two
 * budgets over the same accounts would count every purchase twice if summed;
 * which one is the household's is the holder's decision, and until there is a
 * field for it the choice is stated in `spending.budgetId` rather than hidden.
 */
export async function gatherRevealedFacts(
  ports: RevealedPorts,
  input: RevealedInput,
): Promise<RevealedFacts> {
  const { parameters } = resolveParameters(input.parameters);
  const window = trailingWindow(input.asOf, parameters.windowMonths);
  const accounts = await ports.cashflow.accounts(input.userId, input.asOf);
  const ids = accounts
    .filter((a) => a.taxBucket !== null || isIncomeAccount(a))
    .map((a) => a.accountId);
  const [historyStarts, inflows, budgets] = await Promise.all([
    ids.length === 0
      ? new Map<string, DateOnly>()
      : ports.cashflow.historyStarts(input.userId, ids),
    ids.length === 0 ? [] : ports.cashflow.inflows(input.userId, ids, window.from, window.to),
    ports.spending.listBudgets({ userId: input.userId }),
  ]);
  const budget = budgets[0];
  let periods: SpendingPeriod[] = [];
  if (budget !== undefined) {
    const summaries = await ports.spending.listPeriods({
      userId: input.userId,
      budgetId: budget.id,
    });
    const inWindow = summaries.filter((summary) => periodInWindow(summary, window));
    const views = await Promise.all(
      inWindow.map((summary) =>
        ports.spending.getPeriod({ userId: input.userId, periodId: summary.id }),
      ),
    );
    periods = views.filter((view): view is SpendingPeriod => view !== null);
  }
  return { accounts, historyStarts, inflows, budgets, periods };
}

/** Gather, then compute. The entry point a service or a route calls. */
export async function deriveRevealedBehavior(
  ports: RevealedPorts,
  input: RevealedInput,
): Promise<RevealedBehavior> {
  return computeRevealedBehavior(await gatherRevealedFacts(ports, input), input);
}

// ---------------------------------------------------------------------------
// The pure derivation
// ---------------------------------------------------------------------------

/** 07 §4.1: income lands in an on-budget cash account. `onBudget` is WP 3.8's `defaultFlagsFor`, narrowed by budgeting's exclusion list. */
function isIncomeAccount(account: CashflowAccount): boolean {
  return account.kind === 'cash' && account.flags.onBudget;
}

function periodInWindow(
  period: { readonly startDate: DateOnly; readonly endDate: DateOnly },
  window: TrailingWindow,
): boolean {
  return (
    DateOnly.compare(period.startDate, window.from) >= 0 &&
    DateOnly.compare(period.endDate, DateOnly.addDays(window.to, 1)) <= 0 &&
    DateOnly.compare(period.startDate, period.endDate) < 0
  );
}

function describe(amount: MoneyType): string {
  return `${Money.formatAmount(amount)} ${amount.currency}`;
}

function byDateThenId(
  a: { readonly date: DateOnly; readonly transactionId: string },
  b: { readonly date: DateOnly; readonly transactionId: string },
): number {
  const byDate = DateOnly.compare(a.date, b.date);
  if (byDate !== 0) return byDate;
  return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
}

/**
 * How long this group of accounts has been observed: the **earliest** history
 * start among them.
 *
 * Not the latest. An account opened inside the window — a rollover IRA, a new
 * HSA — has a late first row because it is new, not because the ledger was
 * blind before it, and taking the latest start would shrink every other
 * account's twelve months to that account's few (the first draft did exactly
 * that, and `'an internal transfer never counts as a contribution'` caught it:
 * a February rollover cut the year to six months). Annualising the group over
 * the earliest start instead spreads a new account's arrivals over the whole
 * observed span, which can understate a brand-new habit and can never inflate
 * one: a $6,000 opening deposit a month ago is $6,000 a year here, not $72,000.
 */
function earliestStart(
  accounts: readonly CashflowAccount[],
  starts: ReadonlyMap<string, DateOnly>,
): DateOnly | null {
  let earliest: DateOnly | null = null;
  for (const account of accounts) {
    const start = starts.get(account.accountId);
    if (start !== undefined && (earliest === null || DateOnly.compare(start, earliest) < 0)) {
      earliest = start;
    }
  }
  return earliest;
}

function revealedWindow(
  window: TrailingWindow,
  from: DateOnly | null,
  monthsObserved: number,
): RevealedWindow {
  return Object.freeze({
    from: window.from,
    to: window.to,
    months: window.months,
    observedFrom: from,
    monthsObserved,
  });
}

function notDerivable(window: RevealedWindow, reason: string): NotDerivable {
  return { status: 'not_derivable', source: 'DERIVED', window, observationCount: 0, reason };
}

/**
 * The one place an observed total becomes a rate: `annual = total × scale`,
 * `monthly = total × scale / 12`, each rounded **once**, half-even, straight
 * from the exact total — never monthly from a rounded annual.
 */
function amountOf(
  total: MoneyType,
  window: RevealedWindow,
  observationCount: number,
  minimumMonths: number,
  scaleNumerator: bigint,
  scaleDenominator: bigint,
): DerivedAmount {
  if (window.monthsObserved < minimumMonths) {
    return {
      status: 'insufficient_history',
      source: 'DERIVED',
      window,
      observationCount,
      minimumMonths,
    };
  }
  return {
    status: 'derived',
    source: 'DERIVED',
    window,
    observationCount,
    total,
    annual: Money.of(
      divideHalfEven(total.minor * scaleNumerator, scaleDenominator),
      total.currency,
    ),
    monthly: Money.of(
      divideHalfEven(total.minor * scaleNumerator, scaleDenominator * 12n),
      total.currency,
    ),
  };
}

interface ExclusionDraft {
  readonly derivation: RevealedExclusion['derivation'];
  readonly reason: ExclusionReason;
  readonly explanation: string;
  readonly taxBucket: TaxBucket | null;
}

function exclusionOfRow(row: CashflowInflow, draft: ExclusionDraft): RevealedExclusion {
  return {
    ...draft,
    date: row.date,
    amount: row.amount,
    label: row.label,
    transactionId: row.transactionId,
    accountId: row.accountId,
    periodId: null,
    categoryId: null,
  };
}

function oneOffExplanation(
  amount: MoneyType,
  evidence: OneOffEvidence,
  thresholds: OneOffThresholds,
  series: string,
): string {
  const n = BigInt(evidence.peerCount);
  const code = amount.currency;
  const median = Money.of(divideHalfEven(evidence.peerTwiceMedian, 2n), code);
  const mean = Money.of(divideHalfEven(evidence.peerSum, n), code);
  // Display only, rounded; the test itself was the exact inequality in src/windows.ts.
  const sigma = Money.of(divideHalfEven(integerSqrt(evidence.peerScaledVariance), n), code);
  return (
    `${describe(amount)} is more than ${thresholds.medianMultiple.text}× the median of the other ` +
    `${String(evidence.peerCount)} ${series} in the window (${describe(median)}) and more than ` +
    `${thresholds.sigma.text}σ above their mean (${describe(mean)}, σ ${describe(sigma)}); a ` +
    'one-off is excluded rather than annualised into a rate'
  );
}

/**
 * Screen one row against the rules every derivation shares, in a fixed order.
 * Returns the exclusion, or `null` when the row survives.
 */
function screenRow(
  row: CashflowInflow,
  derivation: 'contributions' | 'income',
  span: { readonly from: DateOnly | null; readonly historyStart: DateOnly | null },
  baseCurrency: string,
  bucket: TaxBucket | null,
): RevealedExclusion | null {
  const draft = (reason: ExclusionReason, explanation: string): RevealedExclusion =>
    exclusionOfRow(row, { derivation, reason, explanation, taxBucket: bucket });
  if (span.from === null || DateOnly.compare(row.date, span.from) < 0) {
    return draft(
      'partial_month',
      `falls in a month the ledger saw only part of (history on these accounts begins ` +
        `${span.historyStart ?? 'nowhere in the window'}); a part month is never annualised`,
    );
  }
  if (row.amount.currency !== baseCurrency) {
    return draft(
      'currency_mismatch',
      `is in ${row.amount.currency}, not the base currency ${baseCurrency}; it is set aside ` +
        'rather than converted at a guessed rate (D4)',
    );
  }
  if (row.userExcluded) {
    return draft('user_excluded', 'you excluded this transaction from analysis (09 TX-10)');
  }
  if (row.isRefund) {
    return draft(
      'refund',
      derivation === 'income'
        ? 'a refund returns money already spent; it is not income'
        : 'a refund is money returned, not money saved',
    );
  }
  return null;
}

interface Contribution {
  readonly row: CashflowInflow;
  readonly bucket: TaxBucket;
  readonly origin: 'linked_account' | 'external';
}

export function computeRevealedBehavior(
  facts: RevealedFacts,
  input: RevealedInput,
): RevealedBehavior {
  const { parameters, thresholds } = resolveParameters(input.parameters);
  const window = trailingWindow(input.asOf, parameters.windowMonths);
  const base = input.baseCurrency;
  const exclusions: RevealedExclusion[] = [];
  const byId = new Map(facts.accounts.map((account) => [account.accountId, account] as const));
  const rows = [...facts.inflows]
    .filter(
      (row) =>
        DateOnly.compare(row.date, window.from) >= 0 && DateOnly.compare(row.date, window.to) <= 0,
    )
    .sort(byDateThenId);

  // --- contributions --------------------------------------------------------
  const bucketed = facts.accounts.filter((account) => account.taxBucket !== null);
  const contributionStart = earliestStart(bucketed, facts.historyStarts);
  const contributionSpan = observedSpan(window, contributionStart);
  const contributionWindow = revealedWindow(
    window,
    contributionSpan.from,
    contributionSpan.monthsObserved,
  );
  const contributionScale = BigInt(Math.max(contributionSpan.monthsObserved, 1));

  const candidates: Contribution[] = [];
  for (const row of rows) {
    const account = byId.get(row.accountId);
    const bucket = account?.taxBucket ?? null;
    if (bucket === null) continue;
    const screened = screenRow(
      row,
      'contributions',
      { from: contributionSpan.from, historyStart: contributionStart },
      base,
      bucket,
    );
    if (screened !== null) {
      exclusions.push(screened);
      continue;
    }
    const counterpart =
      row.transferCounterpartAccountId === null
        ? undefined
        : byId.get(row.transferCounterpartAccountId);
    if (counterpart?.taxBucket !== undefined && counterpart.taxBucket !== null) {
      exclusions.push(
        exclusionOfRow(row, {
          derivation: 'contributions',
          reason: 'internal_transfer',
          taxBucket: bucket,
          explanation:
            `paired by Phase 1's transfer matching with an outflow from ${counterpart.name} ` +
            `(${counterpart.taxBucket}) into ${account?.name ?? row.accountId} (${bucket}); money ` +
            'moving between two invested accounts was already saved and is not a contribution',
        }),
      );
      continue;
    }
    candidates.push({
      row,
      bucket,
      origin: row.transferCounterpartAccountId === null ? 'external' : 'linked_account',
    });
  }

  const byBucket = {} as Record<TaxBucket, DerivedAmount>;
  const oneOffTest = {} as Record<TaxBucket, OneOffTestOutcome>;
  const kept: Contribution[] = [];
  for (const bucket of TAX_BUCKETS) {
    const series = candidates.filter((candidate) => candidate.bucket === bucket);
    const verdict = separateOneOffs(
      series,
      (candidate) => candidate.row.amount.minor,
      (a, b) => byDateThenId(a.row, b.row),
      thresholds,
    );
    oneOffTest[bucket] = verdict.judged ? 'applied' : 'too_few_peers';
    for (const { item, evidence } of verdict.excluded) {
      exclusions.push(
        exclusionOfRow(item.row, {
          derivation: 'contributions',
          reason: 'one_off',
          taxBucket: bucket,
          explanation: oneOffExplanation(
            item.row.amount,
            evidence,
            thresholds,
            `${bucket} contributions`,
          ),
        }),
      );
    }
    kept.push(...verdict.kept);
    // A bucket with no account in it is not a rate of zero: "$0 a year into a
    // Roth" claims the holder has a Roth and puts nothing in it. It is the
    // absence of an observation, and says so.
    byBucket[bucket] = !bucketed.some((account) => account.taxBucket === bucket)
      ? notDerivable(
          contributionWindow,
          `no ${bucket} account is linked, so there is nothing to observe a contribution in`,
        )
      : amountOf(
          Money.sum(
            verdict.kept.map((c) => c.row.amount),
            base,
          ),
          contributionWindow,
          verdict.kept.length,
          parameters.minimumMonths,
          12n,
          contributionScale,
        );
  }
  const contributionTotal: DerivedAmount =
    bucketed.length === 0
      ? notDerivable(
          contributionWindow,
          'no account is classified into a tax bucket (TAXABLE, TAX_DEFERRED, ROTH, HSA), so a ' +
            'contribution rate has nothing to be observed in',
        )
      : amountOf(
          Money.sum(
            kept.map((c) => c.row.amount),
            base,
          ),
          contributionWindow,
          kept.length,
          parameters.minimumMonths,
          12n,
          contributionScale,
        );
  const external = kept.filter((c) => c.origin === 'external');
  const externalTotal = Money.sum(
    external.map((c) => c.row.amount),
    base,
  );

  // --- income ---------------------------------------------------------------
  const incomeAccounts = facts.accounts.filter(isIncomeAccount);
  const incomeStart = earliestStart(incomeAccounts, facts.historyStarts);
  const incomeSpan = observedSpan(window, incomeStart);
  const incomeWindow = revealedWindow(window, incomeSpan.from, incomeSpan.monthsObserved);
  const takeHomeRows: CashflowInflow[] = [];
  for (const row of rows) {
    const account = byId.get(row.accountId);
    if (account === undefined || !isIncomeAccount(account)) continue;
    const screened = screenRow(
      row,
      'income',
      { from: incomeSpan.from, historyStart: incomeStart },
      base,
      null,
    );
    if (screened !== null) {
      exclusions.push(screened);
      continue;
    }
    if (row.transferCounterpartAccountId !== null) {
      const from = byId.get(row.transferCounterpartAccountId);
      exclusions.push(
        exclusionOfRow(row, {
          derivation: 'income',
          reason: 'internal_transfer',
          taxBucket: null,
          explanation:
            `paired by Phase 1's transfer matching with an outflow from ` +
            `${from?.name ?? 'another of your accounts'}; a transfer between your own accounts is not income`,
        }),
      );
      continue;
    }
    takeHomeRows.push(row);
  }
  const takeHomeTotal = Money.sum(
    takeHomeRows.map((row) => row.amount),
    base,
  );
  const takeHome: DerivedAmount =
    incomeAccounts.length === 0
      ? notDerivable(incomeWindow, 'no on-budget cash account to observe take-home pay in')
      : amountOf(
          takeHomeTotal,
          incomeWindow,
          takeHomeRows.length,
          parameters.minimumMonths,
          12n,
          BigInt(Math.max(incomeSpan.monthsObserved, 1)),
        );
  const fromContributions: DerivedAmount =
    contributionTotal.status === 'derived'
      ? amountOf(
          externalTotal,
          contributionWindow,
          external.length,
          parameters.minimumMonths,
          12n,
          contributionScale,
        )
      : contributionTotal;

  const narrower: RevealedWindow =
    contributionWindow.monthsObserved < incomeWindow.monthsObserved
      ? contributionWindow
      : incomeWindow;
  let incomeTotal: DerivedAmount = takeHome;
  const includesContributions =
    takeHome.status === 'derived' && contributionTotal.status === 'derived';
  if (includesContributions) {
    // Exact over the two spans: 12·(tT·cM + eT·tM) / (tM·cM), rounded once.
    const tM = BigInt(incomeSpan.monthsObserved);
    const cM = BigInt(contributionSpan.monthsObserved);
    const numerator = takeHomeTotal.minor * cM + externalTotal.minor * tM;
    incomeTotal = {
      status: 'derived',
      source: 'DERIVED',
      window: narrower,
      observationCount: takeHomeRows.length + external.length,
      total: Money.add(takeHomeTotal, externalTotal),
      annual: Money.of(divideHalfEven(12n * numerator, tM * cM), base),
      monthly: Money.of(divideHalfEven(numerator, tM * cM), base),
    };
  }

  // --- savings rate ---------------------------------------------------------
  let savingsRate: DerivedRate;
  if (contributionTotal.status !== 'derived') {
    savingsRate = contributionTotal;
  } else if (incomeTotal.status !== 'derived') {
    savingsRate = incomeTotal;
  } else {
    const tM = BigInt(incomeSpan.monthsObserved);
    const cM = BigInt(contributionSpan.monthsObserved);
    // (cT / cM) ÷ ((tT·cM + eT·tM) / (tM·cM))  =  cT·tM / (tT·cM + eT·tM)
    const denominator = takeHomeTotal.minor * cM + externalTotal.minor * tM;
    const observationCount = contributionTotal.observationCount + takeHomeRows.length;
    savingsRate =
      denominator <= 0n
        ? notDerivable(narrower, 'no income was observed, so a savings rate has no denominator')
        : {
            status: 'derived',
            source: 'DERIVED',
            window: narrower,
            observationCount,
            rate: ratioToDecimal(contributionTotal.total.minor * tM, denominator, 4),
          };
  }

  // --- spending -------------------------------------------------------------
  const spending = deriveSpending(facts, window, base, parameters, thresholds, exclusions);

  exclusions.sort((a, b) => {
    const order = ['contributions', 'income', 'spending'] as const;
    const byDerivation = order.indexOf(a.derivation) - order.indexOf(b.derivation);
    if (byDerivation !== 0) return byDerivation;
    const byDate = DateOnly.compare(a.date, b.date);
    if (byDate !== 0) return byDate;
    const left = a.transactionId ?? `${a.periodId ?? ''}:${a.categoryId ?? ''}`;
    const right = b.transactionId ?? `${b.periodId ?? ''}:${b.categoryId ?? ''}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return {
    source: 'DERIVED',
    asOf: input.asOf,
    baseCurrency: base,
    parameters,
    income: {
      total: incomeTotal,
      takeHome,
      fromContributions,
      includesContributions,
      basis: INCOME_BASIS,
    },
    contributions: { total: contributionTotal, byBucket, oneOffTest },
    savingsRate,
    spending,
    exclusions,
  };
}

interface SpendObservation {
  readonly period: SpendingPeriod;
  readonly line: SpendingLine;
  /** `−activity`: positive is money spent. */
  readonly spend: MoneyType;
  /** For the detector's tie-break; not a transaction id. */
  readonly date: DateOnly;
  readonly transactionId: string;
}

function deriveSpending(
  facts: RevealedFacts,
  window: TrailingWindow,
  base: string,
  parameters: RevealedParameters,
  thresholds: OneOffThresholds,
  exclusions: RevealedExclusion[],
): RevealedBehavior['spending'] {
  const empty = revealedWindow(window, null, 0);
  const none = (reason: string, budgetId: string | null): RevealedBehavior['spending'] => {
    const answer = notDerivable(empty, reason);
    return {
      essential: answer,
      discretionary: answer,
      unclassified: answer,
      nonSavings: answer,
      savingsClass: answer,
      budgetId,
      categories: [],
    };
  };
  const budget = facts.budgets[0];
  if (budget === undefined) {
    return none(
      'no budget exists; spending is read from budget categories and never estimated',
      null,
    );
  }
  if (budget.currency !== base) {
    return none(
      `the budget is in ${budget.currency}, not the base currency ${base}; it is not converted at a guessed rate`,
      budget.id,
    );
  }
  const periods = facts.periods
    .filter((period) => periodInWindow(period, window))
    .sort((a, b) => DateOnly.compare(a.startDate, b.startDate));
  const coveredDays = periods.reduce(
    (days, period) => days + DateOnly.differenceInDays(period.startDate, period.endDate),
    0,
  );
  const monthsObserved = monthsFullyCovered(window, periods);
  const spendWindow = revealedWindow(window, periods[0]?.startDate ?? null, monthsObserved);

  const observations: SpendObservation[] = [];
  let anyNeedClass = false;
  for (const period of periods) {
    for (const line of period.lines) {
      if (line.kind !== 'category') continue;
      if (line.class === 'NEED') anyNeedClass = true;
      if (line.activity.minor === 0n) continue;
      const spend = Money.negate(line.activity);
      if (spend.currency !== base) {
        exclusions.push(
          spendingExclusion(
            period,
            line,
            spend,
            'currency_mismatch',
            `is in ${spend.currency}, not the base currency ${base}; it is set aside rather than converted (D4)`,
          ),
        );
        continue;
      }
      observations.push({
        period,
        line,
        spend,
        date: period.startDate,
        transactionId: `${period.id}:${line.id}`,
      });
    }
  }

  const keyOf = (observation: SpendObservation): string =>
    observation.line.categoryId ?? `line:${observation.line.name ?? observation.line.id}`;
  const keys = [...new Set(observations.map(keyOf))].sort();
  const survivors: SpendObservation[] = [];
  const categories: SpendingCategorySummary[] = [];
  for (const key of keys) {
    const series = observations.filter((observation) => keyOf(observation) === key);
    const verdict = separateOneOffs(series, (o) => o.spend.minor, byDateThenId, thresholds);
    for (const { item, evidence } of verdict.excluded) {
      exclusions.push(
        spendingExclusion(
          item.period,
          item.line,
          item.spend,
          'one_off',
          oneOffExplanation(
            item.spend,
            evidence,
            thresholds,
            `periods of ${item.line.name ?? 'this category'}`,
          ),
        ),
      );
    }
    survivors.push(...verdict.kept);
    const latest = series[series.length - 1] as SpendObservation;
    categories.push({
      categoryId: latest.line.categoryId,
      name: latest.line.name,
      class: latest.line.class,
      observationCount: verdict.kept.length,
      oneOffTest: verdict.judged ? 'applied' : 'too_few_peers',
    });
  }

  const days = BigInt(window.days);
  const covered = BigInt(Math.max(coveredDays, 1));
  const sumOf = (select: (observation: SpendObservation) => boolean): DerivedAmount => {
    const chosen = survivors.filter(select);
    return amountOf(
      Money.sum(
        chosen.map((o) => o.spend),
        base,
      ),
      spendWindow,
      chosen.length,
      parameters.minimumMonths,
      days,
      covered,
    );
  };
  // Essential spend is the NEED-class lines, summed on their own. With no line
  // classified NEED there is no source for it, and the answer says so rather
  // than reaching for `nonSavings − discretionary` or a default share.
  const essential: DerivedAmount =
    !anyNeedClass && monthsObserved >= parameters.minimumMonths
      ? notDerivable(
          spendWindow,
          'no budget category is classified NEED, so essential spend has no source; it is never ' +
            'a total minus a guess or a default share of a total',
        )
      : sumOf((o) => o.line.class === 'NEED');
  return {
    essential,
    discretionary: sumOf((o) => o.line.class === 'WANT'),
    unclassified: sumOf((o) => o.line.class === null),
    nonSavings: sumOf((o) => o.line.class !== 'SAVINGS'),
    savingsClass: sumOf((o) => o.line.class === 'SAVINGS'),
    budgetId: budget.id,
    categories,
  };
}

function spendingExclusion(
  period: SpendingPeriod,
  line: SpendingLine,
  spend: MoneyType,
  reason: ExclusionReason,
  explanation: string,
): RevealedExclusion {
  const lastDay = DateOnly.addDays(period.endDate, -1);
  return {
    derivation: 'spending',
    reason,
    date: period.startDate,
    amount: spend,
    label: `${line.name ?? 'Unnamed category'}, ${period.startDate} to ${lastDay}`,
    explanation,
    transactionId: null,
    accountId: null,
    taxBucket: null,
    periodId: period.id,
    categoryId: line.categoryId,
  };
}

// ---------------------------------------------------------------------------
// Into WP 4.1's contribution plans
// ---------------------------------------------------------------------------

/**
 * A derived monthly rate as WP 4.1's `DERIVED` contribution-plan input, or
 * `null` when there is no rate to plan from.
 *
 * `derivedAsOf` is the window's last observed day — `goal_contributions.as_of`
 * names the window the rate was taken over (09 GOAL-4: overridable, and the
 * difference between derived and typed must stay visible). A zero or negative
 * rate is `null`, not a zero plan: `validateContributionPlan` refuses a
 * non-positive amount, and "you contribute nothing" is a fact about the window,
 * not a plan.
 */
export function derivedContributionPlan(
  amount: DerivedAmount,
  startsOn: DateOnly,
): ContributionPlanInput | null {
  if (amount.status !== 'derived' || amount.monthly.minor <= 0n) return null;
  return {
    cadence: 'monthly',
    amount: amount.monthly,
    escalationPct: '0',
    startsOn,
    endsOn: null,
    source: 'DERIVED',
    derivedAsOf: amount.window.to,
  };
}
