// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { resolveMerchantIdentity } from './normalise.ts';
import {
  NO_AUTO,
  NO_RULE,
  type AutoResolution,
  type CategorySource,
  type EffectiveTransaction,
  type RuleResolution,
  type TransactionFact,
  type TransactionOverlay,
} from './types.ts';

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

/**
 * The category tier order, alone: an explicit user edit, then a rule the user
 * wrote in advance, then what the automatic tiers decided (04 §2.2: 3 a merchant
 * default, 4 the provider's category, 5 the classifier at or above its floor),
 * then nothing.
 *
 * WP 11.2b made the last tier effective. Until then `auto` did not exist and a
 * tier 3-5 answer lived only in `category_assignments`, so a row the machine
 * had placed was "uncategorised" to the list, the Inbox filter, budgets and
 * every report. It is a *projection* the ledger owns (`transactions.auto_*`,
 * written by `setAutoCategories`), because the ledger may not read the
 * categorization context's tables, and it is a tier of **this** function
 * because the one rule of this module is that there is one place that knows the
 * order. A holder's pick or a rule always outranks it; it is never applied
 * silently - the chip, the stored explanation and the classifier's floor are
 * what 04 §5.2's "never silently apply" rests on.
 *
 * Exported and shared rather than inlined twice: `resolveEffective` calls it to
 * build the projection at write time, and `effectiveOf` (`db.ts`) calls it to
 * rehydrate a stored row without a fact in hand. Two implementations of one
 * tier order is exactly the drift this module's header exists to prevent. The
 * SQL readers (`read.ts`'s filters) spell the same order as one `COALESCE`
 * (`effectiveCategorySql`), pinned to this function by `test/read.test.ts`.
 */
export function resolveCategoryId(
  overlay: TransactionOverlay,
  rule: RuleResolution = NO_RULE,
  auto: AutoResolution = NO_AUTO,
): string | null {
  return overlay.userCategoryId ?? rule.ruleCategoryId ?? auto.autoCategoryId;
}

/** `resolveCategoryId`, and which tier the answer came from. */
export function resolveCategory(
  overlay: TransactionOverlay,
  rule: RuleResolution = NO_RULE,
  auto: AutoResolution = NO_AUTO,
): { readonly categoryId: string | null; readonly source: CategorySource | null } {
  if (overlay.userCategoryId !== null)
    return { categoryId: overlay.userCategoryId, source: 'user' };
  if (rule.ruleCategoryId !== null) return { categoryId: rule.ruleCategoryId, source: 'rule' };
  if (auto.autoCategoryId !== null) return { categoryId: auto.autoCategoryId, source: 'auto' };
  return { categoryId: null, source: null };
}

export function resolveEffective(
  fact: TransactionFact,
  overlay: TransactionOverlay,
  rule: RuleResolution = NO_RULE,
  auto: AutoResolution = NO_AUTO,
): EffectiveTransaction {
  const date = fact.authorizedDate ?? fact.postedDate;

  // A user's merchant name wins over the provider's; the provider's cleaned
  // `merchant_name` wins over the raw descriptor. The raw descriptor is the last
  // resort because it is the one that reads like `SQ *BLUE BOTTLE COFFEE`.
  // That order lives in `resolveMerchantIdentity` and nowhere else.
  const rawName = fact.name;

  // Decision D25. `identity.key` is `null` when the descriptor names a banking
  // operation rather than a payee — `CHECK 1234`, `TRANSFER TO SAVINGS` — so no
  // `merchants` row is created for it. The *display* is unaffected: the row still
  // reads as what the bank sent, it simply has no merchant identity to group on.
  //
  // The counterparties are passed through deliberately: this must compute the
  // *same* key the write path computes, or a descriptor whose only evidence of a
  // payee is a provider entity id gets a `merchants` row that no transaction
  // points at.
  const identity = resolveMerchantIdentity({
    name: rawName,
    merchantName: fact.merchantName,
    userMerchantName: overlay.userMerchantName,
    provider: fact.provider ?? null,
    counterparties: fact.counterparties ?? null,
  });

  return {
    date,
    amount: fact.amount,
    // The name shown in the list. Falls back to the raw descriptor rather than to
    // an empty string: a row with no name at all is worse than an ugly one.
    name: identity.display === '' ? rawName : identity.display,
    merchantKey: identity.key,
    merchantDisplayName: identity.display === '' ? null : identity.display,
    pending: fact.pending,
    excluded: overlay.userExcluded,
    // The provider's own category is deliberately absent — `@ctx/categorization`
    // owns that mapping and writes its result to `category_assignments`, so
    // surfacing it here would be a second place that decides what a transaction
    // is.
    ...categoryOf(overlay, rule, auto),
    note: blankToNull(overlay.userNote),
  };
}

function categoryOf(
  overlay: TransactionOverlay,
  rule: RuleResolution,
  auto: AutoResolution,
): { categoryId: string | null; categorySource: CategorySource | null } {
  const resolved = resolveCategory(overlay, rule, auto);
  return { categoryId: resolved.categoryId, categorySource: resolved.source };
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
