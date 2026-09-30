// SPDX-License-Identifier: MIT
/**
 * `builtin.spending.fee_hunter` — 07 S7's fuller successor, WP 5.7.
 *
 * `builtin.spending.fees` (`rules-spending.ts`, still `S7`) sums whatever
 * category slugs match its own fee list out of `transactions.summary`. This
 * rule reads the scope built for it, `fees.summary`, which has already
 * classified each type as avoidable or not (07: "interest charges are the D
 * family's") and totalled by account — so this rule only sums the avoidable
 * subset, names the worst offender, and states the cost. Assigned `S7` in the
 * catalogue too: it is 07's same rule, read from a richer scope, not a new
 * numbered one.
 */
import type { BuiltinRule, RuleContext, RuleOutput } from '../../support.ts';
import {
  clampImpact,
  formatMoneyJson,
  insightOf,
  metric,
  snapshotRef,
  sumOf,
} from '../../support.ts';
import { builtinManifest } from '../../manifest.ts';
/** Acronyms that read as words otherwise. Not a new claim -- just casing. */
const ACRONYMS: ReadonlySet<string> = new Set(['atm']);

/** `fees_and_services.atm_fees` → `ATM fees`. Readable, never a new claim. */
function typeLabel(slug: string): string {
  const leaf = slug.split('.').pop() ?? slug;
  const words = leaf
    .split('_')
    .filter((word) => word !== 'fees')
    .map((word) =>
      ACRONYMS.has(word) ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    );
  const label = words.length === 0 ? leaf : words.join(' ');
  return `${label} fees`;
}

export const spendingFeeHunter: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.spending.fee_hunter',
    displayName: 'Avoidable fees, by type and by account',
    purpose:
      'Totals avoidable fees by type over twelve months, names the worst offender, and states the yearly cost.',
    scopes: ['fees.summary'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const block = context.snapshot.fees_summary;
    if (block === undefined) return { insights: [], warnings: [] };

    const avoidable = block.by_type
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.avoidable && entry.row.count > 0);
    if (avoidable.length === 0) return { insights: [], warnings: [] };

    const derived = sumOf(
      context.snapshot,
      'avoidable_fees_over_a_year',
      avoidable.map((entry) =>
        snapshotRef(`fees_summary.by_type[${String(entry.index)}].total.minor`),
      ),
      'Every avoidable fee type in the last twelve months of transactions, added up.',
    );
    if (derived === null) return { insights: [], warnings: [] };

    const verdict = clampImpact(derived.value, context.baseCurrency, 'avoidable fees over a year');
    if (verdict.kind === 'withheld') {
      return { insights: [], warnings: [verdict.warning] };
    }
    const totalText = formatMoneyJson(verdict.money);
    if (totalText === null) return { insights: [], warnings: [] };

    let worst = avoidable[0];
    for (const entry of avoidable) {
      if (worst === undefined) break;
      if (BigInt(entry.row.total.minor) > BigInt(worst.row.total.minor)) worst = entry;
    }
    if (worst === undefined) return { insights: [], warnings: [] };
    const worstText = formatMoneyJson(worst.row.total);
    if (worstText === null) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'spending.fee_hunter',
          period: context.period,
          type: 'spending.fee_hunter',
          severity: 'warning',
          title: 'Avoidable fees added up over the year',
          summary:
            `Avoidable fees came to about ${totalText} over the last year, led by ` +
            `${typeLabel(worst.row.type)} at ${worstText}.`,
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis:
            'Every avoidable fee type in the last twelve months of transactions, added up; ' +
            'interest charges are excluded — a debt-family rule covers those.',
          derivationId: derived.derivation.id,
          derivations: [derived.derivation],
          evidence: [
            metric(
              `${typeLabel(worst.row.type)}, the worst offender`,
              snapshotRef(`fees_summary.by_type[${String(worst.index)}].total`),
              worstText,
            ),
            metric(
              'Every avoidable type this year, added up',
              snapshotRef('fees_summary.by_type'),
              null,
            ),
          ],
          actions: [
            {
              kind: 'suggest_only',
              label: 'Switch account or set autopay to avoid the worst offender',
              rationale_md:
                'Avoidable fees are, by definition, avoidable — usually with an account ' +
                'feature, an autopay setup, or a different provider.',
              url: null,
            },
          ],
          caveats: ['Interest charges are not counted here; a debt-family rule addresses those.'],
        }),
      ],
      warnings: [],
    };
  },
};
