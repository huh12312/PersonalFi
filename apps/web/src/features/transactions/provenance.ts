// SPDX-License-Identifier: MIT
/**
 * WP 11.2b: the words and figures of a provenance chip, from the stored placement.
 *
 * Nothing here decides or recomputes anything: the tier and the confidence arrive from the api exactly as the
 * categorisation pass stored them (`autoCategory` on a transaction, the stored chain on an explanation). The chip
 * names the tier ("Plaid", "Learned", "Classifier 92 %"); the sentence behind it is the server's stored line.
 */
import type {
  AutoCategory,
  CategoryExplanation,
  Transaction,
} from '../../api/generated/types.gen.ts';

export type AutoTier = AutoCategory['tier'];

/** The placement an automatic tier made, when that is what the row's category is. */
export function autoPlacementOf(
  transaction: Pick<Transaction, 'categorySource' | 'autoCategory'>,
): AutoCategory | null {
  return transaction.categorySource === 'auto' ? (transaction.autoCategory ?? null) : null;
}

/** `0.9234` → `92 %`: whole percent, the same figure and spelling as the server's explanation line. */
export function percentOf(confidence: number): string {
  return `${String(Math.round(confidence * 100))} %`;
}

/** The chip's text: "Plaid" (tier 4), "Learned" (tier 3), "Classifier 92 %" (tier 5, the calibrated confidence). */
export function chipLabelOf(auto: AutoCategory): string {
  switch (auto.tier) {
    case 'provider':
      return 'Plaid';
    case 'merchant_default':
      return 'Learned';
    case 'classifier':
      return `Classifier ${percentOf(auto.confidence)}`;
  }
}

/** What the chip is, for a screen reader reading its accessible name before the reveal. */
export function chipNameOf(auto: AutoCategory): string {
  switch (auto.tier) {
    case 'provider':
      return 'Placed automatically from Plaid’s category';
    case 'merchant_default':
      return 'Placed automatically from what you did before for this merchant';
    case 'classifier':
      return `Placed automatically by the classifier at ${percentOf(auto.confidence)}`;
  }
}

/**
 * The reveal's headline, from the stored chain. "Learned from 4 confirmations" reads the winning merchant tier's
 * stored `support`; a pinned merchant says so; a chain stored without figures says only what the chip says.
 */
export function revealHeadlineOf(
  auto: AutoCategory,
  explanation: CategoryExplanation | undefined,
): string {
  const winner = explanation?.tiers.find((tier) => tier.won);
  if (auto.tier === 'merchant_default') {
    if (winner?.facts?.['locked'] === true) return 'Pinned for this merchant';
    const support = winner?.facts?.['support'];
    if (typeof support === 'number') {
      return `Learned from ${String(support)} confirmation${support === 1 ? '' : 's'}`;
    }
    return 'Learned from your earlier picks';
  }
  if (auto.tier === 'provider') return 'From Plaid’s category for this transaction';
  return `Classifier, ${percentOf(auto.confidence)} confident`;
}
