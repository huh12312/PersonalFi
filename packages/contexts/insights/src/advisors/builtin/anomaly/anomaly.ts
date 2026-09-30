// SPDX-License-Identifier: MIT
/**
 * S1 and S5 — 09 ADV-5 and ADV-8, WP 5.7.
 *
 * Both read `transactions.anomalies` only, and both are quiet about the
 * threshold: the block already carries only the rows that qualified
 * (`snapshot/builder.ts`'s `#transactionsAnomalies`, the `idle_cash`
 * precedent), so a rule here never re-applies the >3-deviation or $250 test —
 * it only decides *which* qualifying reason each row is telling it about, so
 * a row the builder flagged only for S5 is never also announced as an S1
 * finding it does not actually clear (and vice versa).
 *
 * That reconstruction is exact bigint arithmetic over the row's own fields —
 * never a re-read of `deviation_multiple`, which is `null` whenever the
 * category's MAD is exactly zero, a case the ratio cannot express but
 * `deviation > floor` still decides correctly without dividing by anything.
 *
 * Neither rule prints the deviation multiple in its copy. A fractional "how
 * many times" figure is exactly the shape 03 §8.3's numeral tracer is
 * pickiest about, and the two Money figures — the charge and the category's
 * usual size — already carry the finding; `deviation_multiple` still crosses
 * as evidence, cited but not rendered into a number a human reads.
 */
import type { BuiltinRule, RuleContext, RuleOutput } from '../../support.ts';
import { formatMoneyJson, insightOf, snapshotRef, transactionEvidence } from '../../support.ts';
import { builtinManifest } from '../../manifest.ts';
import type { Insight } from '../../../contract/response.ts';
import type { AdvisorSnapshot } from '../../../contract/snapshot.ts';

type AnomalyBlock = NonNullable<AdvisorSnapshot['transactions_anomalies']>;
type AnomalyRow = AnomalyBlock['rows'][number];

function rowRef(index: number, field: string): string {
  return snapshotRef(`transactions_anomalies.rows[${String(index)}].${field}`);
}

/**
 * The builder's own S1 test, replayed exactly over the row's own fields.
 *
 * `deviation > threshold × mad AND deviation > floor` — the same two
 * conditions `#transactionsAnomalies` applied before this row ever crossed,
 * recomputed here in bigint so the rule's decision and the builder's
 * inclusion decision can never silently disagree.
 */
function clearsCategoryThreshold(row: AnomalyRow, block: AnomalyBlock): boolean {
  if (row.baseline_median === null || row.baseline_mad === null) return false;
  const magnitude = -BigInt(row.amount.minor);
  const median = BigInt(row.baseline_median.minor);
  const deviation = magnitude < median ? median - magnitude : magnitude - median;
  const floor = BigInt(block.materiality_floor.minor);
  if (deviation <= floor) return false;
  const mad = BigInt(row.baseline_mad.minor);
  const threshold = BigInt(Math.round(block.deviation_threshold));
  return deviation > threshold * mad;
}

/** The builder's own S5 test: the merchant's earliest row, and over the floor. */
function clearsNewMerchantThreshold(row: AnomalyRow, block: AnomalyBlock): boolean {
  if (!row.first_seen_merchant) return false;
  const magnitude = -BigInt(row.amount.minor);
  const floor = BigInt(block.new_merchant_floor.minor);
  return magnitude > floor;
}

export const spendingCategoryAnomaly: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.category_anomaly',
    displayName: "A charge far above its category's usual size",
    purpose:
      "Flags a transaction more than three robust deviations above its category's twelve-month norm.",
    scopes: ['transactions.anomalies'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 20,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const block = context.snapshot.transactions_anomalies;
    if (block === undefined) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    block.rows.forEach((row, index) => {
      if (!clearsCategoryThreshold(row, block)) return;
      const amountText = formatMoneyJson(row.amount);
      const medianText = row.baseline_median === null ? null : formatMoneyJson(row.baseline_median);
      if (amountText === null || medianText === null) return;
      const category = row.category_slug ?? 'this category';

      insights.push(
        insightOf({
          key: `spending.category_anomaly.${row.transaction_ref}`,
          period: context.period,
          type: 'spending.category_anomaly',
          severity: 'notable',
          title: `A ${category} charge well above the usual size`,
          summary:
            `A ${category} charge of ${amountText} on ${row.date} is well above the ` +
            `category's usual ${medianText}.`,
          confidence: 0.7,
          horizon: 'immediate',
          basis:
            "The category's median charge over the trailing twelve months, and how far a " +
            'typical charge in it swings either way.',
          evidence: [
            transactionEvidence('The charge', rowRef(index, 'transaction_ref'), null),
            transactionEvidence('Its date', rowRef(index, 'date'), row.date),
            transactionEvidence('The exact amount', rowRef(index, 'amount'), amountText),
            transactionEvidence(
              "The category's usual charge",
              rowRef(index, 'baseline_median'),
              medianText,
            ),
            transactionEvidence(
              'How many times the category’s usual swing this deviates by',
              rowRef(index, 'deviation_multiple'),
              null,
            ),
          ],
          actions: [
            {
              kind: 'suggest_only',
              label: 'Check this charge against the receipt or statement',
              rationale_md:
                "A charge far outside the category's usual range is worth a second look, " +
                'whether that means a one-off purchase, a billing error or a miscategorised row.',
              url: null,
            },
          ],
          caveats: [
            'A category can have a large, real charge for a legitimate reason — this only ' +
              'says the charge is unusual for the category, not that it is wrong.',
          ],
        }),
      );
    });

    return { insights: insights.slice(0, 20), warnings: [] };
  },
};

export const spendingNewMerchantHighCharge: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.new_merchant_high_charge',
    displayName: 'A first-time charge over $250 at a new merchant',
    purpose: 'Flags a charge over $250 at a merchant not otherwise seen in the last twelve months.',
    scopes: ['transactions.anomalies'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 20,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const block = context.snapshot.transactions_anomalies;
    if (block === undefined) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    block.rows.forEach((row, index) => {
      if (!clearsNewMerchantThreshold(row, block)) return;
      const amountText = formatMoneyJson(row.amount);
      if (amountText === null) return;

      insights.push(
        insightOf({
          key: `spending.new_merchant_high_charge.${row.transaction_ref}`,
          period: context.period,
          type: 'spending.new_merchant_high_charge',
          severity: 'warning',
          title: 'A first-time charge at a merchant not seen before',
          summary:
            `A ${amountText} charge on ${row.date} is the first charge seen from this merchant ` +
            'in the last twelve months.',
          confidence: 0.6,
          horizon: 'immediate',
          basis:
            'No merchant in the last twelve months of transactions matches this one before this date.',
          evidence: [
            transactionEvidence('The charge', rowRef(index, 'transaction_ref'), null),
            transactionEvidence('Its date', rowRef(index, 'date'), row.date),
            transactionEvidence('The exact amount', rowRef(index, 'amount'), amountText),
            transactionEvidence(
              "It is the merchant's first appearance in the window",
              rowRef(index, 'first_seen_merchant'),
              null,
            ),
          ],
          actions: [
            {
              kind: 'suggest_only',
              label: 'Confirm or dispute this charge',
              rationale_md:
                'A first-time charge over $250 at a merchant with no history is worth confirming ' +
                'it was you — a fraud-avoidance check, not an accusation.',
              url: null,
            },
          ],
          caveats: [
            'A merchant not seen in the last twelve months may still be one you know — an ' +
              'annual service, a new landlord, or a once-a-year purchase.',
          ],
        }),
      );
    });

    return { insights: insights.slice(0, 20), warnings: [] };
  },
};
