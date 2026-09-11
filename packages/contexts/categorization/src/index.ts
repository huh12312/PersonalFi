// SPDX-License-Identifier: MIT
/**
 * `@ctx/categorization` — Categorization & Rules.
 *
 * The taxonomy, the rules engine, merchant normalisation, and the classifier. Writes to a transaction's category through `LedgerWriter.applyCategorization`, never a direct UPDATE, so provenance and the resulting event stay in one place.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.categorization`) and event metadata. */
export const CONTEXT_ID = 'categorization' as const;
