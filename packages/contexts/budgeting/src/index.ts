// SPDX-License-Identifier: MIT
/**
 * `@ctx/budgeting` — Budgeting.
 *
 * Envelope-lite: flexible category targets, rollover, a to-be-budgeted pool, and sinking funds. Strict envelope and 50/30/20 are derived views over the same ledger, not separate models.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.budgeting`) and event metadata. */
export const CONTEXT_ID = 'budgeting' as const;
