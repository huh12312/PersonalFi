// SPDX-License-Identifier: MIT
/**
 * `@ctx/ledger` — Ledger.
 *
 * The system of record and the gravitational centre of the app. Deliberately dumb: it stores facts and their provenance, and does not categorise, budget, or interpret. Provider-sourced rows are immutable; user intent lives in an overlay resolved on read.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.ledger`) and event metadata. */
export const CONTEXT_ID = 'ledger' as const;
