// SPDX-License-Identifier: MIT
/**
 * `@ctx/insights` — Insights / Advisory.
 *
 * The `Advisor` contract and the insight feed. The only context that reads broadly, and it does so through a single assembler (`SnapshotBuilder`) so data minimisation has exactly one implementation point.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.insights`) and event metadata. */
export const CONTEXT_ID = 'insights' as const;
