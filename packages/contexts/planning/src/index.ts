// SPDX-License-Identifier: MIT
/**
 * `@ctx/planning` — Planning.
 *
 * Goals, assumptions, scenarios, deterministic projection, and Monte Carlo. Also the sole writer of the `net_worth_daily` read model, which is why that table lives here even though its inputs come from Ledger and Investments.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.planning`) and event metadata. */
export const CONTEXT_ID = 'planning' as const;
