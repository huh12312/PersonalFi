// SPDX-License-Identifier: MIT
/**
 * `@ctx/connections` — Connections & Providers.
 *
 * The `Connector` port and its adapters (Plaid, SimpleFIN, Coinbase, wallet RPC, CSV, manual), plus sync orchestration and connection health. Depends on Ledger, never the reverse — that asymmetry is what makes swapping the aggregator a one-context change.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.connections`) and event metadata. */
export const CONTEXT_ID = 'connections' as const;
