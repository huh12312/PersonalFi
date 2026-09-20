// SPDX-License-Identifier: MIT
/**
 * The subscription rules — 07 §3.3's U family, as far as Phase 2 data reaches.
 *
 * Three of the eight ship: **U2** (a confirmed price increase), **U3**
 * (duplicate services in one taxonomy node) and **U7** (subscriptions against
 * take-home). The other five are declared in `catalogue.ts` with the field they
 * would need and do not have; `catalog.test.ts` asserts every one of the eight
 * is either implemented or has a stated reason, so "we forgot U5" and "U5 is not
 * possible yet" are different states with different evidence.
 *
 * ## What these rules are allowed to say about a vendor
 *
 * Nothing. D22 makes a merchant cross as `MERCHANT_<hash>`; these rules never
 * receive "Spotify" and so cannot print it. Every sentence below says "a
 * subscription" and puts the identity in `evidence[].source_ref`, where WP
 * 2.10's evidence panel resolves it for display out of data the advisor never
 * saw. That is why U3's copy is "you have two entertainment.streaming
 * subscriptions" rather than 07's "{n} {node} services: {list}" — the list is
 * the UI's to render.
 *
 * ## `eligible_for_impact` is load-bearing
 *
 * 07 §2.4 caps an `EARLY_DETECTION` stream at 0.70 confidence, and the snapshot
 * carries the consequence as a boolean: a stream seen twice has a cadence we are
 * guessing at, and multiplying a guess by twelve produces a confident-looking
 * annual figure with nothing behind it. A rule here may *report* such a stream;
 * it may not attach a dollar figure to it.
 */
import type { Insight } from '../contract/response.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import * as decimal from '../validate/decimal.ts';
import { builtinManifest } from './manifest.ts';
import {
  clampImpact,
  daysBetween,
  completeMonths,
  formatMoneyJson,
  formatMinor,
  insightOf,
  metric,
  monthlyFromAnnual,
  monthOf,
  seriesEvidence,
  snapshotRef,
  sumProducts,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from './support.ts';

/** Counting words, so a rule never has to print a numeral it cannot trace. */
const COUNT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

function countWord(value: number): string {
  return COUNT_WORDS[value] ?? 'several';
}

type Stream = NonNullable<AdvisorSnapshot['recurring_list']>['streams'][number];

interface IndexedStream {
  readonly stream: Stream;
  readonly index: number;
}

function activeSubscriptions(snapshot: AdvisorSnapshot): readonly IndexedStream[] {
  const streams = snapshot.recurring_list?.streams ?? [];
  return streams
    .map((stream, index) => ({ stream, index }))
    .filter((row) => row.stream.type === 'SUBSCRIPTION' && row.stream.status === 'ACTIVE');
}

function streamRef(index: number, field: string): string {
  return snapshotRef(`recurring_list.streams[${String(index)}].${field}`);
}

/** The annual cost of a stream in minor units, for ordering. `null` if unusable. */
function annualMinor(stream: Stream): bigint | null {
  const typical = BigInt(stream.typical_amount.minor);
  const periods = stream.periods_per_year;
  if (!Number.isInteger(periods) || periods <= 0) return null;
  const magnitude = typical < 0n ? -typical : typical;
  return magnitude * BigInt(periods);
}

// ---------------------------------------------------------------------------
// U2 — a confirmed price increase
// ---------------------------------------------------------------------------

/** A price change older than this is history, not news. */
const PRICE_CHANGE_WINDOW_DAYS = 180;
/** Above this annual difference the finding is a warning rather than a note. */
const PRICE_CHANGE_WARNING_MINOR = 10_000n;

export const subscriptionPriceIncrease: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.subscriptions.price_increase',
    displayName: 'Subscription price increases',
    purpose: 'Reports a confirmed price rise on a recurring charge and what it costs over a year.',
    scopes: ['recurring.list'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 20,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const streams = context.snapshot.recurring_list?.streams ?? [];
    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, stream] of streams.entries()) {
      for (const [position, change] of stream.price_changes.entries()) {
        if (change.direction !== 'INCREASE') continue;
        const age = daysBetween(change.effective_date, context.today);
        if (age === null || age < 0 || age > PRICE_CHANGE_WINDOW_DAYS) continue;

        const base = `recurring_list.streams[${String(index)}].price_changes[${String(position)}]`;
        const previous = formatMoneyJson(change.previous_amount);
        const next = formatMoneyJson(change.new_amount);
        const period = monthOf(change.effective_date);
        if (previous === null || next === null || period === null) continue;

        const annualRaw = decimal.parseDecimal(change.annual_impact.minor);
        // 07 §2.4: a stream we have seen twice has a cadence we are guessing at.
        // The increase is still real; the annualisation of it is not.
        const verdict =
          annualRaw === null || !stream.eligible_for_impact
            ? null
            : clampImpact(annualRaw, change.annual_impact.currency, `${base}.annual_impact`);
        if (verdict !== null && verdict.kind === 'withheld') warnings.push(verdict.warning);

        const annualText =
          verdict !== null && verdict.kind === 'kept' ? formatMoneyJson(verdict.money) : null;
        const caveats =
          verdict === null
            ? [
                stream.eligible_for_impact
                  ? 'The yearly difference could not be read exactly, so it is left unstated.'
                  : 'This charge has not been seen often enough to put a yearly figure on it.',
              ]
            : verdict.kind === 'withheld'
              ? [verdict.caveat]
              : [];

        const summary =
          annualText === null
            ? `A subscription went from ${previous} to ${next} on ${change.effective_date}.`
            : `A subscription went from ${previous} to ${next} on ${change.effective_date} — ` +
              `about ${annualText} more a year.`;

        const annualMoney = verdict !== null && verdict.kind === 'kept' ? verdict.money : null;
        const severe =
          annualMoney !== null && BigInt(annualMoney.minor) >= PRICE_CHANGE_WARNING_MINOR;

        insights.push(
          insightOf({
            key: `subscription.price_increase.${stream.merchant_ref}.${change.effective_date}`,
            period,
            type: 'subscription.price_increase',
            severity: severe ? 'warning' : 'notable',
            title: 'A subscription costs more than it did',
            summary,
            confidence: stream.confidence,
            horizon: 'this_year',
            annualized: annualMoney,
            basis:
              annualMoney === null
                ? 'No yearly figure: the charge is not yet regular enough to annualise.'
                : 'The difference between the old and new price, across a year of charges.',
            evidence: [
              seriesEvidence('Previous price', snapshotRef(`${base}.previous_amount`), previous),
              seriesEvidence('New price', snapshotRef(`${base}.new_amount`), next),
              seriesEvidence(
                'Effective from',
                snapshotRef(`${base}.effective_date`),
                change.effective_date,
              ),
              seriesEvidence(
                'The charge this belongs to',
                streamRef(index, 'typical_amount'),
                formatMoneyJson(stream.typical_amount),
              ),
            ],
            actions: [
              suggest(
                'Review this subscription',
                'Worth a look if the new price changes what it is worth to you.',
              ),
            ],
            caveats,
          }),
        );
      }
    }

    return { insights, warnings };
  },
};

// ---------------------------------------------------------------------------
// U3 — two services covering the same ground
// ---------------------------------------------------------------------------

/**
 * How many streams one group may hold before the saving is left unstated.
 *
 * `Derivation.inputs` is capped at sixteen by the contract, and each stream
 * costs two (amount and periods). Six members means five contribute to
 * "everything but the cheapest" — ten refs — and the seventh would make the
 * arithmetic unexpressible. A group that large still produces the *finding*; it
 * just does not carry a figure, which is the honest degradation.
 */
const DUPLICATE_GROUP_LIMIT = 6;

export const subscriptionDuplicateService: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.subscriptions.duplicate_service',
    displayName: 'Overlapping subscriptions',
    purpose: 'Finds two or more active subscriptions whose charges land in the same category.',
    scopes: ['recurring.list', 'transactions.raw'],
    maxSeverity: 'notable',
    producesImpact: true,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const rows = snapshot.transactions_raw?.rows ?? [];
    const subscriptions = activeSubscriptions(snapshot);
    if (rows.length === 0 || subscriptions.length < 2) return { insights: [], warnings: [] };

    // A merchant's category is the slug most of its charges landed in, with a
    // lexicographic tie-break so two runs over the same data group identically.
    const tally = new Map<string, Map<string, number>>();
    const witness = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
      if (row.merchant_ref === null || row.category_slug === null) continue;
      const slugs = tally.get(row.merchant_ref) ?? new Map<string, number>();
      slugs.set(row.category_slug, (slugs.get(row.category_slug) ?? 0) + 1);
      tally.set(row.merchant_ref, slugs);
      const key = `${row.merchant_ref} ${row.category_slug}`;
      if (!witness.has(key)) witness.set(key, index);
    }

    const categoryOf = new Map<string, string>();
    for (const [merchant, slugs] of tally) {
      const best = [...slugs.entries()].sort((left, right) =>
        left[1] === right[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
      )[0];
      if (best !== undefined) categoryOf.set(merchant, best[0]);
    }

    const groups = new Map<string, IndexedStream[]>();
    for (const entry of subscriptions) {
      const slug = categoryOf.get(entry.stream.merchant_ref);
      if (slug === undefined) continue;
      groups.set(slug, [...(groups.get(slug) ?? []), entry]);
    }

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [slug, members] of [...groups.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      const distinct = new Set(members.map((entry) => entry.stream.merchant_ref));
      if (members.length < 2 || distinct.size < 2) continue;

      // Cheapest first, so "everything but the cheapest" is a suffix and the
      // ordering of the derivation's inputs is a function of the data alone.
      const ordered = [...members].sort((left, right) => {
        const leftAnnual = annualMinor(left.stream) ?? 0n;
        const rightAnnual = annualMinor(right.stream) ?? 0n;
        if (leftAnnual !== rightAnnual) return leftAnnual < rightAnnual ? -1 : 1;
        return left.stream.merchant_ref.localeCompare(right.stream.merchant_ref);
      });

      const surplus = ordered.slice(1);
      const eligible =
        ordered.length <= DUPLICATE_GROUP_LIMIT &&
        ordered.every((entry) => entry.stream.eligible_for_impact);

      const derived = eligible
        ? sumProducts(
            snapshot,
            'surplus',
            surplus.map(
              (entry) =>
                [
                  streamRef(entry.index, 'typical_amount.minor'),
                  streamRef(entry.index, 'periods_per_year'),
                ] as const,
            ),
            'Each surplus subscription at its own price, across its own periods in a year.',
          )
        : null;

      const verdict =
        derived === null
          ? null
          : clampImpact(derived.value, context.baseCurrency, `${slug} surplus`);
      if (verdict !== null && verdict.kind === 'withheld') warnings.push(verdict.warning);
      const impact = verdict !== null && verdict.kind === 'kept' ? verdict.money : null;
      const impactText = impact === null ? null : formatMoneyJson(impact);

      const summary =
        impactText === null
          ? `You have ${countWord(ordered.length)} ${slug} subscriptions running at once.`
          : `You have ${countWord(ordered.length)} ${slug} subscriptions running at once. ` +
            `Keeping only the cheapest would free about ${impactText} a year.`;

      const evidence = ordered.flatMap((entry) => {
        const row = witness.get(`${entry.stream.merchant_ref} ${slug}`);
        const price = seriesEvidence(
          'A subscription in this group',
          streamRef(entry.index, 'typical_amount'),
          formatMoneyJson(entry.stream.typical_amount),
        );
        if (row === undefined) return [price];
        return [
          price,
          metric(
            'A charge from it, categorised',
            snapshotRef(`transactions_raw.rows[${String(row)}].category_slug`),
            slug,
          ),
        ];
      });

      insights.push(
        insightOf({
          key: `subscription.duplicate_service.${slug}`,
          period: context.period,
          type: 'subscription.duplicate_service',
          severity: 'notable',
          title: 'Subscriptions that cover the same ground',
          summary,
          confidence: Math.min(...ordered.map((entry) => entry.stream.confidence)),
          horizon: 'this_year',
          annualized: impact,
          basis:
            impact === null
              ? 'No yearly figure: this group is too large or too new to annualise exactly.'
              : 'Every subscription in the group except the cheapest, annualised.',
          derivationId: derived === null || impact === null ? null : derived.derivation.id,
          derivations: derived === null || impact === null ? [] : [derived.derivation],
          evidence: evidence.slice(0, 32),
          actions: [
            suggest(
              'Compare these services',
              'They charge separately and land in the same category.',
            ),
          ],
          caveats:
            verdict !== null && verdict.kind === 'withheld'
              ? [verdict.caveat]
              : ['Categories come from how these charges were filed, which you can change.'],
        }),
      );
    }

    return { insights, warnings };
  },
};

// ---------------------------------------------------------------------------
// U7 — subscriptions against take-home
// ---------------------------------------------------------------------------

/** 07 §3.3 U7: subscriptions above a tenth of take-home. */
const SHARE_OF_INCOME_DIVISOR = 10n;
/**
 * How many streams the monthly figure may stand on.
 *
 * Sixteen refs, two per stream. Beyond eight the rule reports the eight largest
 * and says so — which under-reports the total and can only make the finding more
 * conservative, never less.
 */
const SHARE_STREAM_LIMIT = 8;

export const subscriptionShareOfIncome: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.subscriptions.share_of_income',
    displayName: 'Subscriptions against income',
    purpose: 'Compares what subscriptions cost each month with what came in last month.',
    scopes: ['recurring.list', 'cashflow.monthly'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const months = completeMonths(snapshot.cashflow_monthly?.months ?? [], context.today);
    const latest = months[months.length - 1];
    const subscriptions = activeSubscriptions(snapshot);
    if (latest === undefined || subscriptions.length === 0) return { insights: [], warnings: [] };

    const incomeMinor = BigInt(latest.income.minor);
    if (incomeMinor <= 0n) return { insights: [], warnings: [] };

    const ordered = [...subscriptions].sort((left, right) => {
      const leftAnnual = annualMinor(left.stream) ?? 0n;
      const rightAnnual = annualMinor(right.stream) ?? 0n;
      if (leftAnnual !== rightAnnual) return leftAnnual > rightAnnual ? -1 : 1;
      return left.stream.merchant_ref.localeCompare(right.stream.merchant_ref);
    });
    const counted = ordered.slice(0, SHARE_STREAM_LIMIT);
    const capped = ordered.length > SHARE_STREAM_LIMIT;

    const monthIndex = (snapshot.cashflow_monthly?.months ?? []).indexOf(latest);
    if (monthIndex < 0) return { insights: [], warnings: [] };
    const incomeRef = snapshotRef(`cashflow_monthly.months[${String(monthIndex)}].income`);

    const monthly = monthlyFromAnnual(
      snapshot,
      'monthly_subscriptions',
      counted.map(
        (entry) =>
          [
            streamRef(entry.index, 'typical_amount.minor'),
            streamRef(entry.index, 'periods_per_year'),
          ] as const,
      ),
      'Each subscription at its own price and cadence, brought back to a month.',
    );
    if (monthly === null) return { insights: [], warnings: [] };

    const monthlyMinor = decimal.render(decimal.absolute(monthly.value), 0);
    if (monthlyMinor === null) return { insights: [], warnings: [] };
    if (BigInt(monthlyMinor) * SHARE_OF_INCOME_DIVISOR <= incomeMinor) {
      return { insights: [], warnings: [] };
    }

    const monthlyText = formatMinor(monthly.value);
    const incomeText = formatMoneyJson(latest.income);
    if (monthlyText === null || incomeText === null) return { insights: [], warnings: [] };

    const opening = capped
      ? `Your ${countWord(SHARE_STREAM_LIMIT)} largest subscriptions come to about ${monthlyText} a month`
      : `Your subscriptions come to about ${monthlyText} a month`;

    return {
      insights: [
        insightOf({
          key: 'subscription.share_of_income',
          period: context.period,
          type: 'subscription.share_of_income',
          severity: 'notable',
          title: 'Subscriptions are a large share of what comes in',
          summary: `${opening}. Income in ${latest.month} was ${incomeText}.`,
          confidence: Math.min(...counted.map((entry) => entry.stream.confidence)),
          horizon: 'this_year',
          basis: 'No saving is claimed: this is what the charges add up to, next to income.',
          derivations: [monthly.derivation],
          evidence: [
            metric('Income last month', incomeRef, incomeText),
            ...counted.map((entry) =>
              seriesEvidence(
                'A subscription counted here',
                streamRef(entry.index, 'typical_amount'),
                formatMoneyJson(entry.stream.typical_amount),
              ),
            ),
          ],
          actions: [
            suggest('Review the list', 'The evidence panel lists every charge counted here.'),
          ],
          caveats: capped
            ? ['Only the largest subscriptions are counted, so the real total is higher.']
            : [],
        }),
      ],
      warnings: [],
    };
  },
};

export const SUBSCRIPTION_RULES: readonly BuiltinRule[] = Object.freeze([
  subscriptionDuplicateService,
  subscriptionPriceIncrease,
  subscriptionShareOfIncome,
]);
