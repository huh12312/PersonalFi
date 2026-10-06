// SPDX-License-Identifier: MIT
/**
 * The spending rules — 07 §3.3's S family, restricted to the subset
 * 02-phase-2-dispatch.md §3 names (S1, S2, S3, S5, S6, S7, S9, S10) and further
 * restricted by what a snapshot can actually carry.
 *
 * Six ship: **S2** (category creep), **S3** (uncategorised transactions), **S6**
 * (a possible duplicate charge), **S7** (fees paid over a year), **S9** (a month
 * that spent more than it earned) and **S10** (annual bills clustering ahead).
 * S1 and S5 are declared unavailable in `catalogue.ts`: both need an *exact*
 * transaction amount, and `transactions.raw` carries a band instead (03 §8.3 —
 * exact amounts across enough rows are a fingerprint). A rule that said "your
 * charge was about $200" from the band `200-1000` would be inventing precision,
 * which is the same defect as inventing a number.
 *
 * ## S3 prints no count, and that is the interesting part of this file
 *
 * 07's S3 template is "{n} transactions (${amt}) aren't categorized". Neither
 * figure is available: `transactions.raw` has one row per transaction and no
 * count field, and its amounts are bands. `n` could be *computed* — it is just
 * `rows.filter(…).length` — and that is exactly why it may not be printed: a
 * number an advisor computed from the shape of the data rather than from a value
 * in it has nothing for the validator to trace, and the only way to make it
 * traceable would be a laundering expression like `$0 * 0 + 1 + 1 + …`, which
 * `derivations.ts` documents as the hole it deliberately closes.
 *
 * So S3 says "some recent transactions", puts every one of them in
 * `evidence[]`, and lets the UI count what it renders. The rule still fires on a
 * count, because a *trigger* is not a rendered figure — nothing about a
 * threshold reaches the user's eye.
 */
import type { Insight } from '../contract/response.ts';
import type { AdvisorSnapshot, AmountBucket } from '../contract/snapshot.ts';
import { builtinManifest } from './manifest.ts';
import {
  annualisedAverage,
  annualisedDelta,
  averageOf,
  clampImpact,
  completeMonths,
  daysBetween,
  formatMinor,
  formatMoneyJson,
  insightOf,
  metric,
  ruleDraft,
  seriesEvidence,
  snapshotRef,
  suggest,
  sumOf,
  transactionEvidence,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from './support.ts';

function monthRef(index: number, field: string): string {
  return snapshotRef(`cashflow_monthly.months[${String(index)}].${field}`);
}

function rowRef(index: number, field: string): string {
  return snapshotRef(`transactions_raw.rows[${String(index)}].${field}`);
}

function streamRef(index: number, field: string): string {
  return snapshotRef(`recurring_list.streams[${String(index)}].${field}`);
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// S2 — a category that has crept
// ---------------------------------------------------------------------------

const CREEP_RECENT_MONTHS = 3;
/**
 * The baseline is the six complete months **before** the three recent ones,
 * not the trailing twelve (C5-8, G5-10). The trailing twelve contains the
 * recent three, so one month's rows were cited both as "a recent month" and as
 * "a month in the baseline", and the single month a purchase landed in dragged
 * its own baseline up with it. Disjoint windows keep a row on one side only.
 *
 * Six and not nine because a derivation may only name the literals on
 * `validate/derivations.ts`'s allow-list (`9` is not one; `6` is), and because
 * the rule then still speaks at nine complete months of history, where the old
 * one needed twelve — so a short real-world history does not silence S2.
 */
const CREEP_BASELINE_MONTHS = 6;
/** 07 §3.3 S2's `× 1.25`, as an integer comparison: `recent × 4 > baseline × 5`. */
const CREEP_RATIO_NUMERATOR = 4n;
const CREEP_RATIO_DENOMINATOR = 5n;
/** 07 §3.3 S2's "delta > $50/mo", in minor units. */
const CREEP_DELTA_FLOOR_MINOR = 5_000n;

export const spendingCategoryCreep: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.category_creep',
    displayName: 'A category that has crept up',
    purpose: 'Compares the last three months of a category with the six months before them.',
    scopes: ['cashflow.monthly'],
    maxSeverity: 'notable',
    producesImpact: true,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const allMonths = snapshot.cashflow_monthly?.months ?? [];
    const complete = completeMonths(allMonths, context.today);
    if (complete.length < CREEP_RECENT_MONTHS + CREEP_BASELINE_MONTHS) {
      return { insights: [], warnings: [] };
    }

    const recent = complete.slice(-CREEP_RECENT_MONTHS);
    const baseline = complete.slice(
      -(CREEP_RECENT_MONTHS + CREEP_BASELINE_MONTHS),
      -CREEP_RECENT_MONTHS,
    );
    const slugs = new Set(
      recent.flatMap((month) => month.by_category.map((row) => row.category_slug)),
    );

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const slug of [...slugs].sort((left, right) => left.localeCompare(right))) {
      const recentRefs = refsFor(allMonths, recent, slug);
      const baselineRefs = refsFor(allMonths, baseline, slug);
      if (recentRefs.refs.length === 0 || baselineRefs.refs.length === 0) continue;
      if (recentRefs.refs.length + baselineRefs.refs.length > 15) continue;

      // Magnitudes, because a category's sign is a convention of whichever
      // reader produced it and a creep is about size either way.
      const recentAverage = magnitude(recentRefs.total) / BigInt(CREEP_RECENT_MONTHS);
      const baselineAverage = magnitude(baselineRefs.total) / BigInt(CREEP_BASELINE_MONTHS);
      if (recentAverage * CREEP_RATIO_NUMERATOR <= baselineAverage * CREEP_RATIO_DENOMINATOR) {
        continue;
      }
      if (recentAverage - baselineAverage < CREEP_DELTA_FLOOR_MINOR) continue;

      // A creep is a run, not a purchase (C5-8, G5-10): the same two thresholds
      // must hold with the single largest recent month set aside. One $1,299
      // charge among three months moves the plain average past both and the
      // trimmed one past neither. A trigger, never a rendered figure — nothing
      // here reaches the user's eye or needs a derivation.
      const trimmedAverage = trimmedRecentAverage(recentRefs.monthly);
      if (trimmedAverage * CREEP_RATIO_NUMERATOR <= baselineAverage * CREEP_RATIO_DENOMINATOR) {
        continue;
      }
      if (trimmedAverage - baselineAverage < CREEP_DELTA_FLOOR_MINOR) continue;

      const recentDerivation = averageOf(
        snapshot,
        'recent_average',
        recentRefs.refs,
        CREEP_RECENT_MONTHS,
        'The last three complete months of this category, averaged.',
      );
      const baselineDerivation = averageOf(
        snapshot,
        'baseline_average',
        baselineRefs.refs,
        CREEP_BASELINE_MONTHS,
        'The six complete months before those three, averaged.',
      );
      const annual = annualisedDelta(
        snapshot,
        'annual_difference',
        recentRefs.refs,
        CREEP_RECENT_MONTHS,
        baselineRefs.refs,
        CREEP_BASELINE_MONTHS,
        'The monthly difference between the two averages, taken out to a year.',
      );
      if (recentDerivation === null || baselineDerivation === null || annual === null) continue;

      const verdict = clampImpact(annual.value, context.baseCurrency, `${slug} creep`);
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        continue;
      }

      const recentText = formatMinor(recentDerivation.value);
      const baselineText = formatMinor(baselineDerivation.value);
      const annualText = formatMoneyJson(verdict.money);
      if (recentText === null || baselineText === null || annualText === null) continue;

      insights.push(
        insightOf({
          key: `spending.category_creep.${slug}`,
          period: context.period,
          type: 'spending.category_creep',
          severity: 'notable',
          title: 'A category has been running higher than usual',
          summary:
            `${slug} has run about ${recentText} a month lately, against ${baselineText} ` +
            `a month across the six months before — about ${annualText} a year at the new pace.`,
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis:
            'The gap between a three-month average and the six-month average before it, annualised.',
          derivationId: annual.derivation.id,
          derivations: [
            recentDerivation.derivation,
            baselineDerivation.derivation,
            annual.derivation,
          ],
          evidence: [
            ...recentRefs.refs.map((ref) => metric('A recent month', ref, null)),
            ...baselineRefs.refs
              .slice(0, 12)
              .map((ref) => metric('A month in the baseline', ref, null)),
          ].slice(0, 32),
          actions: [
            suggest(
              'Look at this category',
              'Two or more of the last three months ran higher: a new habit, or a bill that moved.',
            ),
          ],
          caveats: ['A single large month inside the window still moves this average.'],
        }),
      );
    }

    return { insights, warnings };
  },
};

interface CategoryRefs {
  readonly refs: readonly string[];
  readonly total: bigint;
  /** Each window month's magnitude, in window order; a month without the category is `0n`. */
  readonly monthly: readonly bigint[];
}

/** The mean of the recent months with the single largest set aside (integer minor units). */
function trimmedRecentAverage(monthly: readonly bigint[]): bigint {
  if (monthly.length < 2) return 0n;
  const sorted = [...monthly].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const kept = sorted.slice(0, -1);
  return kept.reduce((sum, value) => sum + value, 0n) / BigInt(kept.length);
}

function refsFor(
  allMonths: NonNullable<AdvisorSnapshot['cashflow_monthly']>['months'],
  window: readonly NonNullable<AdvisorSnapshot['cashflow_monthly']>['months'][number][],
  slug: string,
): CategoryRefs {
  const refs: string[] = [];
  const monthly: bigint[] = [];
  let total = 0n;
  for (const month of window) {
    const monthIndex = allMonths.indexOf(month);
    const categoryIndex = month.by_category.findIndex((row) => row.category_slug === slug);
    const row = month.by_category[categoryIndex];
    if (monthIndex < 0 || categoryIndex < 0 || row === undefined) {
      monthly.push(0n);
      continue;
    }
    refs.push(monthRef(monthIndex, `by_category[${String(categoryIndex)}].amount.minor`));
    total += BigInt(row.amount.minor);
    monthly.push(magnitude(BigInt(row.amount.minor)));
  }
  return { refs, total, monthly };
}

// ---------------------------------------------------------------------------
// S3 — transactions with no category
// ---------------------------------------------------------------------------

/** 07 §3.3 S3's "> 10 txns". The dollar half of its trigger needs exact amounts. */
const UNCATEGORISED_FLOOR = 10;

export const spendingUncategorised: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.uncategorised',
    displayName: 'Transactions with no category',
    purpose: 'Reports recent transactions that have not been categorised yet.',
    scopes: ['transactions.raw'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const rows = context.snapshot.transactions_raw?.rows ?? [];
    const uncategorised = rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.category_slug === null);
    if (uncategorised.length < UNCATEGORISED_FLOOR) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'spending.uncategorised',
          period: context.period,
          type: 'spending.uncategorised',
          severity: 'notable',
          title: 'Some recent transactions have no category',
          summary:
            'Some recent transactions have not been categorised, so budgets and these ' +
            'insights are incomplete until they are. The evidence panel lists them.',
          confidence: 1,
          horizon: 'this_period',
          basis: 'No figure is claimed: the amounts behind these rows cross as bands, not totals.',
          evidence: uncategorised
            .slice(0, 24)
            .map((entry) =>
              transactionEvidence(
                'A transaction with no category',
                rowRef(entry.index, 'transaction_ref'),
                null,
              ),
            ),
          actions: [
            ruleDraft(
              'Start a rule from one of these',
              'A rule files this merchant the same way next time.',
            ),
          ],
        }),
      ],
      warnings: [],
    };
  },
};

// ---------------------------------------------------------------------------
// S6 — a charge that looks like it landed twice
// ---------------------------------------------------------------------------

/** 07 §3.3 S6's 72 hours. */
const DUPLICATE_WINDOW_DAYS = 3;
/**
 * The bands a duplicate is worth raising on.
 *
 * 07 says "amount > $10", which maps onto `10-50` and up. In practice the `10-50`
 * band is where two coffees on the same day live, and a false "you were charged
 * twice" costs more trust than a missed one earns — 02 §5's standing argument
 * about precision over recall. So the rule starts at `50-200`.
 */
const DUPLICATE_BANDS: ReadonlySet<AmountBucket> = new Set<AmountBucket>([
  '50-200',
  '200-1000',
  '1000-5000',
  '5000+',
]);

export const spendingDuplicateCharge: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.duplicate_charge',
    displayName: 'A charge that may have landed twice',
    purpose: 'Finds two outgoing charges at one merchant, in one amount band, days apart.',
    scopes: ['transactions.raw'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 5,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const rows = context.snapshot.transactions_raw?.rows ?? [];
    const candidates = rows
      .map((row, index) => ({ row, index }))
      .filter(
        (entry) =>
          entry.row.direction === 'outflow' &&
          entry.row.merchant_ref !== null &&
          DUPLICATE_BANDS.has(entry.row.amount_bucket),
      );

    const insights: Insight[] = [];
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const first = candidates[left];
        const second = candidates[right];
        if (first === undefined || second === undefined) continue;
        if (first.row.merchant_ref !== second.row.merchant_ref) continue;
        if (first.row.amount_bucket !== second.row.amount_bucket) continue;
        const gap = daysBetween(first.row.date, second.row.date);
        if (gap === null || Math.abs(gap) > DUPLICATE_WINDOW_DAYS) continue;

        insights.push(
          insightOf({
            key: `spending.duplicate_charge.${first.row.transaction_ref}.${second.row.transaction_ref}`,
            period: context.period,
            type: 'spending.duplicate_charge',
            severity: 'urgent',
            title: 'Two similar charges at one merchant',
            summary:
              `Two outgoing charges at the same merchant landed on ${first.row.date} and ` +
              `${second.row.date}, both in the ${first.row.amount_bucket} band.`,
            confidence: 0.6,
            horizon: 'immediate',
            basis:
              'No figure is claimed: amounts cross as bands, so the exact charge is not known here.',
            evidence: [
              transactionEvidence('The first charge', rowRef(first.index, 'transaction_ref'), null),
              transactionEvidence('Its date', rowRef(first.index, 'date'), first.row.date),
              transactionEvidence(
                'The second charge',
                rowRef(second.index, 'transaction_ref'),
                null,
              ),
              transactionEvidence('Its date', rowRef(second.index, 'date'), second.row.date),
              transactionEvidence(
                'The band both fall in',
                rowRef(first.index, 'amount_bucket'),
                first.row.amount_bucket,
              ),
            ],
            actions: [
              suggest(
                'Check these two against the statement',
                'Amounts are compared as bands here, so two similar charges can look alike.',
              ),
            ],
            caveats: [
              'Amounts are compared as bands, so a genuine pair of similar charges looks the same as a duplicate.',
            ],
          }),
        );
        if (insights.length >= 5) return { insights, warnings: [] };
      }
    }

    return { insights, warnings: [] };
  },
};

// ---------------------------------------------------------------------------
// S7 — fees paid over a year
// ---------------------------------------------------------------------------

/** The fee taxonomy, as category slugs `@ctx/categorization` actually seeds. */
const FEE_SLUGS: readonly string[] = Object.freeze([
  'fees_and_services.atm_fees',
  'fees_and_services.bank_fees',
  'fees_and_services.foreign_fees',
  'fees_and_services.interest_charges',
  'fees_and_services.other_fees',
]);

/** Below this a year of fees is true, uninteresting, and crowds out more. */
const FEE_FLOOR_MINOR = 5_000n;

export const spendingFees: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.fees',
    displayName: 'Fees paid over a year',
    purpose: 'Adds up a year of bank, ATM, foreign-transaction and interest charges.',
    scopes: ['transactions.summary'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const summary = context.snapshot.transactions_summary;
    if (summary === undefined) return { insights: [], warnings: [] };

    const fees = summary.by_category
      .map((row, index) => ({ row, index }))
      .filter((entry) => FEE_SLUGS.includes(entry.row.category_slug));
    if (fees.length === 0) return { insights: [], warnings: [] };

    const total = fees.reduce((sum, entry) => sum + magnitude(BigInt(entry.row.total.minor)), 0n);
    if (total < FEE_FLOOR_MINOR) return { insights: [], warnings: [] };

    const derived = sumOf(
      context.snapshot,
      'fees_over_a_year',
      fees.map((entry) =>
        snapshotRef(`transactions_summary.by_category[${String(entry.index)}].total.minor`),
      ),
      'Every fee category in the last twelve months of summarised spending.',
    );
    if (derived === null) return { insights: [], warnings: [] };

    const verdict = clampImpact(derived.value, context.baseCurrency, 'fees over a year');
    if (verdict.kind === 'withheld') {
      return { insights: [], warnings: [verdict.warning] };
    }
    const totalText = formatMoneyJson(verdict.money);
    if (totalText === null) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'spending.fees',
          period: context.period,
          type: 'spending.fees',
          severity: 'warning',
          title: 'Fees added up over the year',
          summary:
            `Bank, card and ATM charges came to about ${totalText} across the last year ` +
            `of transactions.`,
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis: 'Every fee category in the last year of summarised spending, added up.',
          derivationId: derived.derivation.id,
          derivations: [derived.derivation],
          evidence: fees.map((entry) =>
            metric(
              entry.row.category_slug,
              snapshotRef(`transactions_summary.by_category[${String(entry.index)}].total`),
              formatMoneyJson(entry.row.total),
            ),
          ),
          actions: [
            suggest(
              'See where these came from',
              'Each fee category links through to the transactions behind it.',
            ),
          ],
          caveats: ['Fees are counted from how the charges were filed, which you can change.'],
        }),
      ],
      warnings: [],
    };
  },
};

// ---------------------------------------------------------------------------
// S9 — a month that spent more than it earned
// ---------------------------------------------------------------------------

const NEGATIVE_RUN_MONTHS = 3;

export const spendingNegativeMonth: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.negative_month',
    displayName: 'A month that ran short',
    purpose: 'Reports the most recent complete month in which spending exceeded income.',
    scopes: ['cashflow.monthly'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const allMonths = snapshot.cashflow_monthly?.months ?? [];
    const complete = completeMonths(allMonths, context.today);
    const latest = complete[complete.length - 1];
    if (latest === undefined) return { insights: [], warnings: [] };

    const latestIndex = allMonths.indexOf(latest);
    if (latestIndex < 0) return { insights: [], warnings: [] };
    const net = BigInt(latest.net.minor);
    if (net >= 0n) return { insights: [], warnings: [] };

    const run = complete.slice(-NEGATIVE_RUN_MONTHS);
    const sustained =
      run.length === NEGATIVE_RUN_MONTHS && run.every((month) => BigInt(month.net.minor) < 0n);

    const annual = sustained
      ? annualisedAverage(
          snapshot,
          'annualised_shortfall',
          run.map((month) => monthRef(allMonths.indexOf(month), 'net.minor')),
          NEGATIVE_RUN_MONTHS,
          'The last three complete months of net cash flow, averaged and taken out to a year.',
        )
      : null;

    const warnings: string[] = [];
    let annualized = null as ReturnType<typeof clampImpact> | null;
    if (annual !== null) {
      annualized = clampImpact(annual.value, context.baseCurrency, 'sustained shortfall');
      if (annualized.kind === 'withheld') warnings.push(annualized.warning);
    }

    const shortfallText = formatMoneyJson(latest.net);
    if (shortfallText === null) return { insights: [], warnings };

    const annualMoney = annualized !== null && annualized.kind === 'kept' ? annualized.money : null;
    const oneTime =
      annualMoney === null
        ? { minor: magnitude(net).toString(), currency: latest.net.currency }
        : null;

    return {
      insights: [
        insightOf({
          key: `spending.negative_month.${latest.month}`,
          period: latest.month,
          type: 'spending.negative_month',
          severity: 'warning',
          title: 'A month spent more than it brought in',
          summary: `In ${latest.month}, spending ran about ${shortfallText} ahead of income.`,
          confidence: 1,
          horizon: sustained ? 'this_year' : 'this_period',
          annualized: annualMoney,
          oneTime,
          basis:
            annualMoney === null
              ? 'The gap between income and spending in that month.'
              : 'Three months of shortfall, averaged and taken out to a year.',
          derivationId: annualMoney === null || annual === null ? null : annual.derivation.id,
          derivations: annualMoney === null || annual === null ? [] : [annual.derivation],
          evidence: [
            metric(
              'Income that month',
              monthRef(latestIndex, 'income'),
              formatMoneyJson(latest.income),
            ),
            metric(
              'Spending that month',
              monthRef(latestIndex, 'expense'),
              formatMoneyJson(latest.expense),
            ),
            metric('The difference', monthRef(latestIndex, 'net'), shortfallText),
          ],
          actions: [
            suggest(
              'Look at the largest categories',
              'The report screen breaks the month down by category.',
            ),
          ],
          caveats: sustained
            ? []
            : ['One month on its own can be a timing difference rather than a trend.'],
        }),
      ],
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// S10 — annual bills clustering ahead
// ---------------------------------------------------------------------------

/** 07 §3.3 S10's ninety-day look-ahead. */
const ANNUAL_BILL_WINDOW_DAYS = 90;
/** Its "> 1.5× monthly discretionary", as `sum × 2 > monthly × 3`. */
const ANNUAL_BILL_NUMERATOR = 2n;
const ANNUAL_BILL_DENOMINATOR = 3n;
/** A stream charged at most twice a year is the "annual bill" population. */
const ANNUAL_BILL_MAX_PERIODS = 2;

export const spendingAnnualBillsAhead: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.annual_bills_ahead',
    displayName: 'Annual bills landing soon',
    purpose: 'Adds up yearly and half-yearly bills falling due in the next three months.',
    scopes: ['recurring.list', 'cashflow.monthly'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const streams = snapshot.recurring_list?.streams ?? [];
    const allMonths = snapshot.cashflow_monthly?.months ?? [];
    const complete = completeMonths(allMonths, context.today).slice(-3);
    if (complete.length < 3) return { insights: [], warnings: [] };

    const monthlySpend =
      complete.reduce((sum, month) => sum + magnitude(BigInt(month.expense.minor)), 0n) / 3n;
    if (monthlySpend <= 0n) return { insights: [], warnings: [] };

    const due = streams
      .map((stream, index) => ({ stream, index }))
      .filter((row) => {
        if (row.stream.status !== 'ACTIVE' || row.stream.next_due_date === null) return false;
        if (row.stream.periods_per_year > ANNUAL_BILL_MAX_PERIODS) return false;
        const days = daysBetween(context.today, row.stream.next_due_date);
        return days !== null && days >= 0 && days <= ANNUAL_BILL_WINDOW_DAYS;
      })
      .slice(0, 16);
    if (due.length === 0) return { insights: [], warnings: [] };

    const total = due.reduce(
      (sum, row) => sum + magnitude(BigInt(row.stream.typical_amount.minor)),
      0n,
    );
    if (total * ANNUAL_BILL_NUMERATOR <= monthlySpend * ANNUAL_BILL_DENOMINATOR) {
      return { insights: [], warnings: [] };
    }

    const derived = sumOf(
      snapshot,
      'annual_bills_ahead',
      due.map((row) => streamRef(row.index, 'typical_amount.minor')),
      'Every yearly or half-yearly bill due in the next three months, at its usual amount.',
    );
    if (derived === null) return { insights: [], warnings: [] };
    const totalText = formatMinor(derived.value);
    if (totalText === null) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'spending.annual_bills_ahead',
          period: context.period,
          type: 'spending.annual_bills_ahead',
          severity: 'notable',
          title: 'Yearly bills land in the next few months',
          summary:
            `About ${totalText} of yearly and half-yearly bills fall due in the next three ` +
            `months, which is large next to a normal month of spending.`,
          confidence: Math.min(...due.map((row) => row.stream.confidence)),
          horizon: 'next_quarter',
          basis: 'No saving is claimed: this is what the infrequent bills add up to.',
          derivations: [derived.derivation],
          evidence: due
            .flatMap((row) => [
              seriesEvidence(
                'A bill due in the window',
                streamRef(row.index, 'typical_amount'),
                formatMoneyJson(row.stream.typical_amount),
              ),
              seriesEvidence(
                'When it is due',
                streamRef(row.index, 'next_due_date'),
                row.stream.next_due_date,
              ),
            ])
            .slice(0, 32),
          actions: [
            suggest(
              'Set money aside for these',
              'A sinking fund spreads an infrequent bill across the months before it.',
            ),
          ],
        }),
      ],
      warnings: [],
    };
  },
};

export const SPENDING_RULES: readonly BuiltinRule[] = Object.freeze([
  spendingAnnualBillsAhead,
  spendingCategoryCreep,
  spendingDuplicateCharge,
  spendingFees,
  spendingNegativeMonth,
  spendingUncategorised,
]);
