// SPDX-License-Identifier: MIT
import type { BudgetLine, Category, CategoryVariability } from '../../api/generated/types.gen.ts';
import { meterFiguresOf, type MeterFigures } from '../../components/finance/budget-meter.ts';

/**
 * The "By variability" view (WP 10.11; Monarch's equivalent — "Budgeted fixed expenses", "Budgeted
 * flexible expenses", "Budgeted non-monthly expenses"). Pure, so the sections' totals are tested to equal the sum of
 * their rows (`variability.test.ts`).
 *
 * Which lines it covers: every `kind: 'category'` line whose category is not `income` — the money a budget spends
 * or sets aside. Income lines and credit-card-payment lines are not spending to classify; they keep their own
 * section ("Income and card payments") below, unchanged, so nothing the "By group" view can edit disappears.
 *
 * A section's figures are `meterFiguresOf(its lines)` — the same sums the meters draw — so a section's total *is*
 * the sum of its rows by construction, and the test holds that against a hand sum.
 */

export type VariabilityKey = CategoryVariability | 'unclassified';

export const VARIABILITY_ORDER: readonly VariabilityKey[] = [
  'fixed',
  'flexible',
  'non_monthly',
  'unclassified',
];

export const VARIABILITY_LABELS: Record<VariabilityKey, string> = {
  fixed: 'Fixed',
  flexible: 'Flexible',
  non_monthly: 'Non-monthly',
  unclassified: 'Unclassified',
};

/** The totals row's words. */
export const VARIABILITY_TOTAL_LABELS: Record<CategoryVariability, string> = {
  fixed: 'Budgeted fixed expenses',
  flexible: 'Budgeted flexible expenses',
  non_monthly: 'Budgeted non-monthly expenses',
};

/** One line of meaning per section, for the header. */
export const VARIABILITY_MEANING: Record<VariabilityKey, string> = {
  fixed: 'About the same every month — rent, loans, subscriptions.',
  flexible: 'Changes with the choices you make — groceries, dining, shopping.',
  non_monthly: 'Irregular or yearly — insurance, gifts, repairs.',
  unclassified: 'Not yet sorted. Choose Fixed, Flexible or Non-monthly for each.',
};

export interface VariabilitySection {
  readonly key: VariabilityKey;
  readonly lines: readonly BudgetLine[];
  readonly figures: MeterFigures;
}

export interface VariabilityView {
  /** The four sections in order, each present even when empty (an empty one says so). */
  readonly sections: readonly VariabilitySection[];
  /** Income and credit-card-payment lines — not spending to classify. */
  readonly other: readonly BudgetLine[];
}

/** A category's variability as the wire may carry it: `null`/absent is unclassified. */
export function variabilityOf(category: Pick<Category, 'variability'> | undefined): VariabilityKey {
  return category?.variability ?? 'unclassified';
}

export function variabilityViewOf(
  lines: readonly BudgetLine[],
  categoriesById: ReadonlyMap<string, Pick<Category, 'kind' | 'variability'>>,
  currency: string,
): VariabilityView {
  const buckets = new Map<VariabilityKey, BudgetLine[]>(VARIABILITY_ORDER.map((k) => [k, []]));
  const other: BudgetLine[] = [];
  for (const line of lines) {
    const category = line.categoryId === null ? undefined : categoriesById.get(line.categoryId);
    if (line.kind !== 'category' || category?.kind === 'income') {
      other.push(line);
      continue;
    }
    buckets.get(variabilityOf(category))?.push(line);
  }
  return {
    sections: VARIABILITY_ORDER.map((key) => {
      const bucket = buckets.get(key) ?? [];
      return { key, lines: bucket, figures: meterFiguresOf(bucket, currency) };
    }),
    other,
  };
}
