// SPDX-License-Identifier: MIT
/**
 * `@ctx/investments` — Investments & Market Data.
 *
 * Securities, holdings, lots, prices, and FX. `SecurityResolver` is the hard part: Coinbase says ETH, Plaid says ETHEREUM, a wallet says a contract address, a brokerage says a CUSIP — one resolver, one securities table, everything else references security_id.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.investments`) and event metadata. */
export const CONTEXT_ID = 'investments' as const;
