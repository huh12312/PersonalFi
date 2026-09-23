// SPDX-License-Identifier: MIT
/**
 * The cash rules — 07 §3.3's C family, as far as Phase 2 data reaches.
 *
 * Five of the seven ship: **C1** (cash well above a cushion), **C2** (a balance
 * earning less than another account the user already holds), **C3** (charges due
 * inside a fortnight that exceed the cash to meet them), **C4** (a cushion below
 * three months) and **C7** (one large charge landing against a thin balance).
 * C5 and C6 need a credit card's limit, balance and APR; no Phase 2 scope
 * carries any of the three, and `catalogue.ts` says so rather than approximating
 * them.
 *
 * ## The market rate this catalogue now has (WP 3.10)
 *
 * 07's C1 and C2 both compare against a market yield — "a {mkt}% account would
 * earn ~${g}/yr more". Phase 2 had no price feed, so there was no market rate
 * in the snapshot, and a hardcoded `4%` would have been a numeral nothing could
 * account for: the validator would have rejected it at step 7, and it would
 * have been right to. C2 therefore compared the user's accounts **with each
 * other**, and this header predicted the shape of the fix — *"a new snapshot
 * field and one more ref, not a constant in this file."*
 *
 * That is exactly what landed. `market.rates` carries a **dated, attributed
 * FRED observation**, and both rules now read it:
 *
 *   * **C2** compares each balance against the published rate when one is
 *     present, and falls back — unchanged, same key, same arithmetic — to the
 *     best rate the user already holds when it is not. The fallback is not
 *     politeness: a deployment with no FRED key still gets the weaker, entirely
 *     true version rather than nothing, which is what "degrades to no price,
 *     stale flag, visible" means for an advisor.
 *   * **C1** names the published rate beside what the cash is actually earning.
 *     It does **not** claim a dollar figure for the difference: C1's excess is
 *     itself a derivation (cash less a three-month average), and nesting that
 *     into a spread would produce a six-input expression whose evaluation order
 *     has to match the parser's exactly. The sentence C1 was withholding is the
 *     rate; the sentence it still withholds is a saving it cannot show the
 *     working for in one legible expression. C2 shows that saving, per account,
 *     where the balance *is* a ref.
 *
 * A **stale** observation is not used by either. A rate is only meaningful as
 * of a date, and a comparison against a stale one is wrong by however much
 * rates have moved since — which is the whole of the claim.
 *
 * The attribution sentence rides with the figure as a caveat wherever a
 * published rate is shown. 01 §4.3 makes it a licence condition, not a
 * courtesy, and a rule that prints the rate is a surface that owes it.
 *
 * ## Why the two urgent rules carry no dollar figure
 *
 * C3 and C7 are 07's P0-safety class: an overdraft, a bill that will not clear.
 * Their "impact" in 07 is `overdraft_fee × expected_count`, and this app knows
 * neither the fee nor the count. Rather than invent one, both rules claim **no**
 * impact — which is precisely the case the alert budget's floor exemption exists
 * for (`policy/alert-budget.ts`: an insight that claims nothing is judged on
 * what it is). They rank on severity, above every saving in the catalogue.
 */
import type { Insight } from '../contract/response.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import { builtinManifest } from './manifest.ts';
import {
  averageDelta,
  clampImpact,
  completeMonths,
  daysBetween,
  formatMinor,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  seriesEvidence,
  snapshotRef,
  suggest,
  sumOf,
  yieldSpread,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from './support.ts';

type CashSummary = NonNullable<AdvisorSnapshot['cash_summary']>;

function accountRef(index: number, field: string): string {
  return snapshotRef(`cash_summary.accounts[${String(index)}].${field}`);
}

function streamRef(index: number, field: string): string {
  return snapshotRef(`recurring_list.streams[${String(index)}].${field}`);
}

function totalRef(): string {
  return snapshotRef('cash_summary.total');
}

// ---------------------------------------------------------------------------
// The published rate (WP 3.10)
// ---------------------------------------------------------------------------

/** What a cash balance is compared against, and where it came from. */
interface PublishedRate {
  readonly index: number;
  readonly rate: number;
  readonly observationDate: string;
  readonly ref: string;
  readonly dateRef: string;
}

/**
 * The first fresh published rate that describes what cash could earn.
 *
 * `savings_apy` first because it is the closer comparable for a deposit
 * balance, `short_term_risk_free` second because a T-bill is the honest
 * alternative when no deposit series is tracked. A **stale** row is skipped
 * rather than labelled: see the header.
 */
function publishedCashRate(snapshot: AdvisorSnapshot): PublishedRate | null {
  const rates = snapshot.market_rates?.rates ?? [];
  for (const kind of ['savings_apy', 'short_term_risk_free'] as const) {
    const index = rates.findIndex((row) => row.kind === kind && !row.stale);
    if (index === -1) continue;
    const row = rates[index];
    if (row === undefined) continue;
    return {
      index,
      rate: row.rate,
      observationDate: row.observation_date,
      ref: snapshotRef(`market_rates.rates[${String(index)}].rate`),
      dateRef: snapshotRef(`market_rates.rates[${String(index)}].observation_date`),
    };
  }
  return null;
}

/** The attribution sentence as a caveat, when a published rate was shown. */
function attributionCaveat(snapshot: AdvisorSnapshot): readonly string[] {
  const attribution = snapshot.market_rates?.attribution;
  return attribution === undefined ? [] : [attribution];
}

// ---------------------------------------------------------------------------
// C1 — cash well above a cushion
// ---------------------------------------------------------------------------

/** Months of cover above which the balance stops being a cushion. */
const CUSHION_MONTHS = 6;
/** The cushion the excess is measured against, in complete months. */
const CUSHION_WINDOW = 3;
/** 07 §3.3 C1's `> $5,000`, in minor units. */
const IDLE_CASH_FLOOR_MINOR = 500_000n;

export const cashIdleAboveCushion: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.cash.idle_above_cushion',
    displayName: 'Cash above a cushion',
    purpose: 'Reports cash held well beyond three months of recent spending, and what it earns.',
    scopes: ['cash.summary', 'cashflow.monthly', 'market.rates'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const cash = snapshot.cash_summary;
    const allMonths = snapshot.cashflow_monthly?.months ?? [];
    if (cash === undefined || cash.emergency_fund_months === null)
      return { insights: [], warnings: [] };
    if (cash.emergency_fund_months <= CUSHION_MONTHS) return { insights: [], warnings: [] };

    const complete = completeMonths(allMonths, context.today);
    const window = complete.slice(-CUSHION_WINDOW);
    if (window.length < CUSHION_WINDOW) return { insights: [], warnings: [] };

    const expenseRefs = window.map((month) =>
      snapshotRef(`cashflow_monthly.months[${String(allMonths.indexOf(month))}].expense.minor`),
    );
    if (expenseRefs.some((ref) => ref.includes('[-1]'))) return { insights: [], warnings: [] };

    const excess = averageDelta(
      snapshot,
      'excess_over_cushion',
      [snapshotRef('cash_summary.total.minor')],
      1,
      expenseRefs,
      CUSHION_WINDOW,
      'Cash held, less the average of the last three complete months of spending.',
    );
    if (excess === null || excess.value <= 0n) return { insights: [], warnings: [] };

    const excessText = formatMinor(excess.value);
    const apyText = formatPercent(cash.blended_apy);
    if (excessText === null || apyText === null) return { insights: [], warnings: [] };

    const excessMinor = BigInt(excess.derivation.value.split('.')[0] ?? '0');
    if (excessMinor < IDLE_CASH_FLOOR_MINOR) return { insights: [], warnings: [] };

    // WP 3.10: the sentence this rule has been withholding since Phase 2. It
    // names the published rate and stops there — see the header for why the
    // *difference* is C2's to claim and not C1's.
    const published = publishedCashRate(snapshot);
    const publishedText = published === null ? null : formatPercent(published.rate);
    const marketSentence =
      published === null || publishedText === null
        ? ''
        : ` A published rate for cash was ${publishedText} on ${published.observationDate}.`;

    return {
      insights: [
        insightOf({
          key: 'cash.idle_above_cushion',
          period: context.period,
          type: 'cash.idle_above_cushion',
          severity: 'notable',
          title: 'Cash is sitting well above a cushion',
          summary:
            `About ${excessText} more than three months of recent spending is held in cash, ` +
            `earning ${apyText} across those accounts.${marketSentence}`,
          confidence: 1,
          horizon: 'this_year',
          basis: 'No saving is claimed here: this is the balance above a three-month cushion.',
          derivations: [excess.derivation],
          evidence: [
            metric('Cash held', totalRef(), formatMoneyJson(cash.total)),
            metric(
              'Months of cover',
              snapshotRef('cash_summary.emergency_fund_months'),
              String(cash.emergency_fund_months),
            ),
            ...expenseRefs.map((ref) => metric('A month of spending', ref, null)),
            ...(published === null
              ? []
              : [
                  metric('A published rate for cash', published.ref, null),
                  metric(
                    'When that rate was observed',
                    published.dateRef,
                    published.observationDate,
                  ),
                ]),
          ],
          actions: [
            suggest(
              'Compare your cash accounts',
              'The evidence panel shows what each account holds and what it earns.',
            ),
          ],
          caveats: attributionCaveat(snapshot),
        }),
      ],
      warnings: [],
    };
  },
};

// ---------------------------------------------------------------------------
// C2 — a balance earning less than one of your own accounts
// ---------------------------------------------------------------------------

/** 07 §3.3 C2's `balance > $2,500`, in minor units. */
const YIELD_BALANCE_FLOOR_MINOR = 250_000n;
/** The spread that makes the difference worth a sentence: half a point. */
const YIELD_SPREAD_FLOOR = 0.005;
/** Above this annual difference the finding is a warning rather than a note. */
const YIELD_WARNING_MINOR = 50_000n;

export const cashYieldSpread: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.cash.yield_spread',
    displayName: 'Cash earning less than it could',
    purpose: 'Compares each cash balance with the best rate already held in another account.',
    scopes: ['cash.summary', 'market.rates'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const cash: CashSummary | undefined = context.snapshot.cash_summary;
    if (cash === undefined) return { insights: [], warnings: [] };

    const rated = cash.accounts
      .map((account, index) => ({ account, index }))
      .filter((row) => row.account.apy !== null);

    // WP 3.10. Two comparisons, one shape. With a published rate the benchmark
    // is the world; without one it is the best account the user already holds,
    // which is what Phase 2 shipped and is byte-identical to it — same key,
    // same expression, same arithmetic — so a deployment with no FRED key sees
    // exactly what it saw before rather than nothing.
    const published = publishedCashRate(context.snapshot);
    const fallbackBest =
      published !== null || rated.length < 2
        ? null
        : rated.find(
            (row) => (row.account.apy ?? 0) === Math.max(...rated.map((r) => r.account.apy ?? 0)),
          );
    if (published === null && (fallbackBest === undefined || fallbackBest === null)) {
      return { insights: [], warnings: [] };
    }

    const comparisonRate = published?.rate ?? fallbackBest?.account.apy ?? 0;
    const comparisonRef = published?.ref ?? accountRef(fallbackBest?.index ?? 0, 'apy');
    const comparisonNote =
      published === null
        ? 'This balance at the better of two rates already held, less the rate it earns.'
        : 'This balance at a published rate, less the rate the account actually earns.';

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const row of rated) {
      // Comparing the benchmark account with itself would claim a saving of
      // zero against the user's own best rate. With a published benchmark there
      // is no such account to skip.
      if (fallbackBest !== null && fallbackBest !== undefined && row.index === fallbackBest.index) {
        continue;
      }
      const rate = row.account.apy ?? 0;
      if (comparisonRate - rate < YIELD_SPREAD_FLOOR) continue;
      const balance = BigInt(row.account.balance.minor);
      if (balance < YIELD_BALANCE_FLOOR_MINOR) continue;

      const gain = yieldSpread(
        context.snapshot,
        'spread_over_a_year',
        accountRef(row.index, 'balance.minor'),
        comparisonRef,
        accountRef(row.index, 'apy'),
        comparisonNote,
      );
      if (gain === null) continue;
      const verdict = clampImpact(gain.value, row.account.balance.currency, 'cash yield spread');
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        continue;
      }

      const balanceText = formatMoneyJson(row.account.balance);
      const gainText = formatMoneyJson(verdict.money);
      const rateText = formatPercent(rate);
      const bestText = formatPercent(comparisonRate);
      if (
        balanceText === null ||
        gainText === null ||
        rateText === null ||
        bestText === null ||
        BigInt(verdict.money.minor) === 0n
      ) {
        continue;
      }

      insights.push(
        insightOf({
          key: `cash.yield_spread.${row.account.account_ref}`,
          period: context.period,
          type: 'cash.yield_spread',
          severity: BigInt(verdict.money.minor) >= YIELD_WARNING_MINOR ? 'warning' : 'notable',
          title:
            published === null
              ? 'One account earns less than another you already hold'
              : 'One account earns less than the published rate',
          summary:
            published === null
              ? `One account holds ${balanceText} at ${rateText}, while another of your own ` +
                `earns ${bestText}. At the higher rate that balance would have earned about ` +
                `${gainText} over a year.`
              : `One account holds ${balanceText} at ${rateText}, while a published rate was ` +
                `${bestText} on ${published.observationDate}. At that rate the same balance ` +
                `would have earned about ${gainText} over a year.`,
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis:
            published === null
              ? 'The balance at the higher of two rates you already hold, less the lower.'
              : 'The balance at a dated published rate, less the rate the account earns.',
          derivationId: gain.derivation.id,
          derivations: [gain.derivation],
          evidence: [
            metric('The balance', accountRef(row.index, 'balance'), balanceText),
            metric('What it earns', accountRef(row.index, 'apy'), null),
            published === null
              ? metric('The better rate you hold', comparisonRef, null)
              : metric('The published rate', comparisonRef, null),
            ...(published === null
              ? []
              : [
                  metric(
                    'When that rate was observed',
                    published.dateRef,
                    published.observationDate,
                  ),
                ]),
          ],
          actions: [
            suggest(
              'Compare your cash accounts',
              published === null
                ? 'Both accounts are yours; the difference is only where the balance sits.'
                : 'A published series is not an offer anyone has made you; it is what the ' +
                    'market was doing on the date shown.',
            ),
          ],
          caveats:
            published === null
              ? [
                  'Rates come from what is recorded against each account, not from a market ' +
                    'feed.',
                ]
              : [
                  'The published rate is a national series, not an account anyone has offered ' +
                    'you.',
                  ...attributionCaveat(context.snapshot),
                ],
        }),
      );
    }

    return { insights, warnings };
  },
};

// ---------------------------------------------------------------------------
// C3 — charges due before there is cash to meet them
// ---------------------------------------------------------------------------

/** 07 §3.3 C3's fourteen-day horizon. */
const SHORTFALL_WINDOW_DAYS = 14;

export const cashProjectedShortfall: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.cash.projected_shortfall',
    displayName: 'Charges due before the cash is there',
    purpose:
      'Adds up recurring charges due in the next fortnight and compares them with cash held.',
    scopes: ['cash.summary', 'recurring.list'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const cash = snapshot.cash_summary;
    const streams = snapshot.recurring_list?.streams ?? [];
    if (cash === undefined || streams.length === 0) return { insights: [], warnings: [] };

    const due = streams
      .map((stream, index) => ({ stream, index }))
      .filter((row) => {
        if (row.stream.status !== 'ACTIVE' || row.stream.next_due_date === null) return false;
        const days = daysBetween(context.today, row.stream.next_due_date);
        return days !== null && days >= 0 && days <= SHORTFALL_WINDOW_DAYS;
      })
      .sort((left, right) => {
        const leftAmount = BigInt(left.stream.typical_amount.minor);
        const rightAmount = BigInt(right.stream.typical_amount.minor);
        if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
        return left.index - right.index;
      })
      .slice(0, 16);
    if (due.length === 0) return { insights: [], warnings: [] };

    const total = sumOf(
      snapshot,
      'due_within_fortnight',
      due.map((row) => streamRef(row.index, 'typical_amount.minor')),
      'Every recurring charge due in the next fortnight, at its usual amount.',
    );
    if (total === null) return { insights: [], warnings: [] };

    const dueMinor = BigInt(total.derivation.value.split('.')[0] ?? '0');
    const cashMinor = BigInt(cash.total.minor);
    if (dueMinor <= cashMinor) return { insights: [], warnings: [] };

    const dueText = formatMinor(total.value);
    const cashText = formatMoneyJson(cash.total);
    if (dueText === null || cashText === null) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'cash.projected_shortfall',
          period: context.period,
          type: 'cash.projected_shortfall',
          severity: 'urgent',
          title: 'More is due than there is cash to meet it',
          summary:
            `Recurring charges of about ${dueText} fall due in the next two weeks, ` +
            `and your cash accounts hold ${cashText} today.`,
          confidence: Math.min(...due.map((row) => row.stream.confidence)),
          horizon: 'immediate',
          basis:
            'No figure is claimed for what an overdraft would cost; this app does not know the fee.',
          derivations: [total.derivation],
          evidence: [
            metric('Cash held', totalRef(), cashText),
            ...due.flatMap((row) => [
              seriesEvidence(
                'A charge due soon',
                streamRef(row.index, 'typical_amount'),
                formatMoneyJson(row.stream.typical_amount),
              ),
              seriesEvidence(
                'When it is due',
                streamRef(row.index, 'next_due_date'),
                row.stream.next_due_date,
              ),
            ]),
          ].slice(0, 32),
          actions: [
            suggest(
              'Review what is due',
              'Income expected before then is not counted here, so check the dates.',
            ),
          ],
          caveats: ['Only recurring charges are counted. Anything one-off is not in this total.'],
        }),
      ],
      warnings: [],
    };
  },
};

// ---------------------------------------------------------------------------
// C4 — a cushion below three months
// ---------------------------------------------------------------------------

const EMERGENCY_FUND_TARGET_MONTHS = 3;

export const cashEmergencyFundShort: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.cash.emergency_fund_short',
    displayName: 'A thin cushion',
    purpose: 'Reports how many months of recent spending the cash on hand would cover.',
    scopes: ['cash.summary', 'cashflow.monthly'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const cash = context.snapshot.cash_summary;
    if (cash === undefined || cash.emergency_fund_months === null)
      return { insights: [], warnings: [] };
    if (cash.emergency_fund_months >= EMERGENCY_FUND_TARGET_MONTHS)
      return { insights: [], warnings: [] };

    const cashText = formatMoneyJson(cash.total);
    if (cashText === null) return { insights: [], warnings: [] };
    const months = String(cash.emergency_fund_months);

    return {
      insights: [
        insightOf({
          key: 'cash.emergency_fund_short',
          period: context.period,
          type: 'cash.emergency_fund_short',
          severity: 'warning',
          title: 'The cash cushion is thin',
          summary:
            `Cash on hand covers about ${months} months of recent spending. ` +
            `A cushion of three to six months is the usual guidance.`,
          confidence: 1,
          horizon: 'this_year',
          basis: 'Months of cover, from cash held against recent monthly spending.',
          evidence: [
            metric('Cash held', totalRef(), cashText),
            metric('Months of cover', snapshotRef('cash_summary.emergency_fund_months'), months),
          ],
          actions: [
            suggest(
              'Set money aside for this',
              'A cushion is what keeps an unexpected bill off a credit card.',
            ),
          ],
          caveats: ['Cover is measured against recent spending, which includes one-off months.'],
        }),
      ],
      warnings: [],
    };
  },
};

// ---------------------------------------------------------------------------
// C7 — one large charge against a thin balance
// ---------------------------------------------------------------------------

/** 07 §3.3 C7's ten-day horizon. */
const LARGE_BILL_WINDOW_DAYS = 10;
/** 07 §3.3 C7's "> 40% of current balance", as a rational comparison. */
const LARGE_BILL_NUMERATOR = 2n;
const LARGE_BILL_DENOMINATOR = 5n;

export const cashLargeBillDue: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.cash.large_bill_due',
    displayName: 'A large charge lands soon',
    purpose: 'Flags a single recurring charge due within ten days that is large against cash held.',
    scopes: ['cash.summary', 'recurring.list'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const cash = snapshot.cash_summary;
    const streams = snapshot.recurring_list?.streams ?? [];
    if (cash === undefined) return { insights: [], warnings: [] };

    const cashMinor = BigInt(cash.total.minor);
    if (cashMinor <= 0n) return { insights: [], warnings: [] };
    const cashText = formatMoneyJson(cash.total);
    if (cashText === null) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, stream] of streams.entries()) {
      if (stream.status !== 'ACTIVE' || stream.next_due_date === null) continue;
      const days = daysBetween(context.today, stream.next_due_date);
      if (days === null || days < 0 || days > LARGE_BILL_WINDOW_DAYS) continue;

      const amount = BigInt(stream.typical_amount.minor);
      const magnitude = amount < 0n ? -amount : amount;
      if (magnitude * LARGE_BILL_DENOMINATOR <= cashMinor * LARGE_BILL_NUMERATOR) continue;

      const amountText = formatMoneyJson(stream.typical_amount);
      if (amountText === null) continue;

      insights.push(
        insightOf({
          key: `cash.large_bill_due.${stream.series_ref}`,
          period: context.period,
          type: 'cash.large_bill_due',
          severity: 'warning',
          title: 'A large charge is due shortly',
          summary:
            `A recurring charge of about ${amountText} is due on ${stream.next_due_date}, ` +
            `and your cash accounts hold ${cashText}.`,
          confidence: stream.confidence,
          horizon: 'immediate',
          basis: 'No figure is claimed for a missed payment; this app does not know the fee.',
          evidence: [
            seriesEvidence('The charge', streamRef(index, 'typical_amount'), amountText),
            seriesEvidence(
              'When it is due',
              streamRef(index, 'next_due_date'),
              stream.next_due_date,
            ),
            metric('Cash held', totalRef(), cashText),
          ],
          actions: [
            suggest('Check the timing', 'Income expected before the due date is not counted here.'),
          ],
        }),
      );
    }

    return { insights: insights.slice(0, 10), warnings: [] };
  },
};

export const CASH_RULES: readonly BuiltinRule[] = Object.freeze([
  cashEmergencyFundShort,
  cashIdleAboveCushion,
  cashLargeBillDue,
  cashProjectedShortfall,
  cashYieldSpread,
]);
