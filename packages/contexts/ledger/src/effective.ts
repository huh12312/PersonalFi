// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { normaliseMerchantName } from './normalise.ts';
import type { EffectiveTransaction, TransactionFact, TransactionOverlay } from './types.ts';

/**
 * The one function that resolves provider truth against user intent.
 *
 * Decision D11 says provider rows are never mutated by sync and user edits live in
 * an overlay "resolved by one pure function". This is that function, and the rule
 * it exists to enforce is *one*: there must be exactly one place in the codebase
 * that knows the resolution order, because the moment there are two, a list page
 * and a budget total disagree about what a transaction is called and nobody can
 * say which is right.
 *
 * ## Resolution order
 *
 * ```
 * effective(field) = overlay[field]   when the user has spoken   -- explicit intent
 *                  | fact[field]      otherwise                  -- provider truth
 * ```
 *
 * 04 §2.2 states a three-tier order with a rule result between the two. WP 1.4
 * (Categorization) owns rules and there is no rule layer yet; the seam is the
 * overlay, which a rule writes to with its own provenance. Deliberately *not*
 * pre-built: a resolution tier with no producer is a tier nobody can test.
 *
 * ## Why `merchantKey` and not a merchant id
 *
 * Purity. Mapping a normalised key to a `merchants` row is a database round trip,
 * and a resolution function that can do I/O is a resolution function that will
 * eventually do I/O on the read path for 50,000 rows. The writer resolves the key
 * to an id once and denormalises it; the reader uses the stored id.
 *
 * ## The effective date
 *
 * `COALESCE(authorized_date, posted_date)` (04 §2.4). The swipe is when the user
 * experienced the spend, and a card authorised on the 31st that settles on the 2nd
 * belongs in the month it was spent — which is the whole argument, because budgets
 * live exactly on that boundary. Making the preference user-configurable is
 * deferred to WP 2.1, where the budget period actually exists to be configured
 * against; doing it now would be a setting with nothing to change the answer to.
 */
export function resolveEffective(
  fact: TransactionFact,
  overlay: TransactionOverlay,
): EffectiveTransaction {
  const date = fact.authorizedDate ?? fact.postedDate;

  // A user's merchant name wins over the provider's; the provider's cleaned
  // `merchant_name` wins over the raw descriptor. The raw descriptor is the last
  // resort because it is the one that reads like `SQ *BLUE BOTTLE COFFEE`.
  const userName = blankToNull(overlay.userMerchantName);
  const providerName = blankToNull(fact.merchantName);
  const rawName = fact.name;

  const displaySource = userName ?? providerName ?? rawName;
  const normalised = normaliseMerchantName(displaySource);

  return {
    date,
    amount: fact.amount,
    // The name shown in the list. Falls back to the raw descriptor rather than to
    // an empty string: a row with no name at all is worse than an ugly one.
    name: normalised.display === '' ? rawName : normalised.display,
    merchantKey: normalised.key === '' ? null : normalised.key,
    merchantDisplayName: normalised.display === '' ? null : normalised.display,
    pending: fact.pending,
    excluded: overlay.userExcluded,
    categoryId: overlay.userCategoryId,
    note: blankToNull(overlay.userNote),
  };
}

/**
 * `DateOnly` comparison helper used by every effective-date-ordered read path, so
 * that "is this row inside the window?" is answered the same way in SQL and in the
 * pairing heuristics that run in TypeScript.
 */
export function withinDays(a: DateOnly, b: DateOnly, days: number): boolean {
  return Math.abs(DateOnly.differenceInDays(a, b)) <= days;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
