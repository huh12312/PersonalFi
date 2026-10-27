// SPDX-License-Identifier: MIT
/**
 * `builtin.spending.rule_suggestion` — "you keep filing this merchant the same
 * way by hand; make it a rule?" (WP 11.1; 11 §3.1's last row: "a count, not a
 * model. Build as a built-in advisor").
 *
 * ## The policy, all of it here
 *
 * `categorization.rule_candidates` carries every (merchant, category) pair the
 * holder has confirmed at least twice, and decides nothing. This rule decides:
 *
 *   * **Three confirmations, not two** (`RULE_SUGGESTION_MIN_CONFIRMATIONS`).
 *     Two is a coincidence; three is a habit. The reader's floor is two on
 *     purpose, so the pair this threshold refuses is actually in the snapshot
 *     a test builds, and the refusal is observable.
 *   * **Not when a rule already files it** (`covered_by_rule`). Suggesting a
 *     second rule for a merchant the first one already handles is noise.
 *   * **Not when the merchant's category is locked** (`locked_default`). The
 *     merchant tier already files every one of its transactions; a rule would
 *     change nothing.
 *   * **Not when the holder files the merchant two ways.** A merchant that
 *     appears under two categories, each confirmed at least twice, is one a
 *     rule would misfile half the time — a store that is groceries on Monday
 *     and household on Saturday. The title says "the same way", and this is
 *     what keeps it true.
 *   * **One insight per merchant**, keyed `spending.rule_suggestion.<merchant
 *     token>` with period `all_time`, so a re-run is an upsert and a dismissal
 *     walks the existing per-(advisor, key) cooldown ladder for that merchant
 *     alone (07 §7.4: 30 days, 90 days, permanent).
 *
 * ## What it says, and what it cannot say
 *
 * The merchant's name never appears (D22): the advisor holds only a
 * `MERCHANT_` pseudonym, and the copy linter refuses one in prose. The count
 * is printed because it is a snapshot value the numerals check traces; the
 * threshold is never printed, because a constant in this file is not.
 *
 * `ProposedAction` has no payload field, and this rule does not need one: the
 * drafted rule is carried by the evidence. The `category_ref` row names the
 * category and the first `transaction_ref` row names a transaction of the
 * merchant's, both by uuid, which is what the app's existing rule editor is
 * prefilled from. Nothing is created until the holder saves it.
 *
 * No impact: a rule saves the holder time, not money, so `producesImpact` is
 * `false` and the insight ranks after anything that claims a figure — a
 * convenience, last.
 */
import type { Evidence, Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  insightOf,
  metric,
  ruleDraft,
  snapshotRef,
  transactionEvidence,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';

export const RULE_SUGGESTION_ADVISOR_ID = 'builtin.spending.rule_suggestion';

/** Confirmations by hand before a rule is suggested. Never printed. */
export const RULE_SUGGESTION_MIN_CONFIRMATIONS = 3;

/** One run's ceiling. The rest surface as these are saved or dismissed. */
const MAX_SUGGESTIONS = 10;

function candidateRef(index: number, field: string): string {
  return snapshotRef(`rule_candidates.merchants[${String(index)}].${field}`);
}

export const spendingRuleSuggestion: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: RULE_SUGGESTION_ADVISOR_ID,
    displayName: 'A merchant you keep filing the same way',
    purpose:
      'Suggests a categorisation rule for a merchant the holder has filed under the same ' +
      'category by hand several times, where no rule already files it.',
    scopes: ['categorization.rule_candidates'],
    maxSeverity: 'info',
    producesImpact: false,
    maxInsights: MAX_SUGGESTIONS,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const merchants: unknown = context.snapshot.rule_candidates?.merchants;
    if (!Array.isArray(merchants)) return { insights: [], warnings: [] };
    const rows = context.snapshot.rule_candidates?.merchants ?? [];

    const pairsPerMerchant = new Map<string, number>();
    for (const row of rows) {
      pairsPerMerchant.set(row.merchant_ref, (pairsPerMerchant.get(row.merchant_ref) ?? 0) + 1);
    }

    const insights: Insight[] = [];
    rows.forEach((row, index) => {
      if (insights.length >= MAX_SUGGESTIONS) return;
      if (row.confirmations < RULE_SUGGESTION_MIN_CONFIRMATIONS) return;
      if (row.covered_by_rule || row.locked_default) return;
      if ((pairsPerMerchant.get(row.merchant_ref) ?? 0) > 1) return;
      if (row.transactions.length === 0) return;

      const count = String(row.confirmations);
      const evidence: Evidence[] = [
        metric(
          'Times filed under this category by hand',
          candidateRef(index, 'confirmations'),
          count,
        ),
        metric(
          'The category a rule would file it under',
          candidateRef(index, 'category_ref'),
          row.category_ref,
        ),
        ...row.transactions.map((transaction, position) =>
          transactionEvidence(
            'A transaction you filed this way',
            candidateRef(index, `transactions[${String(position)}].transaction_ref`),
            transaction.transaction_ref,
          ),
        ),
      ];

      insights.push(
        insightOf({
          key: `spending.rule_suggestion.${row.merchant_ref}`,
          period: 'all_time',
          type: 'spending.rule_suggestion',
          severity: 'info',
          title: 'A merchant you keep filing the same way',
          summary:
            `You have filed this merchant under ${row.category_slug} ${count} times by hand. ` +
            'A rule would file it there automatically from now on — nothing changes until you ' +
            'save one.',
          confidence: 1,
          horizon: 'this_period',
          basis: 'No figure is claimed: a rule saves time, not money.',
          evidence,
          actions: [
            ruleDraft(
              'Create rule',
              'Opens the rule editor with this merchant and category filled in. Nothing is ' +
                'saved until you save it.',
            ),
          ],
        }),
      );
    });

    return { insights, warnings: [] };
  },
};
