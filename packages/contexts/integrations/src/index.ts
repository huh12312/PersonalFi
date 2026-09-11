// SPDX-License-Identifier: MIT
/**
 * `@ctx/integrations` — Integrations.
 *
 * The anti-corruption layer for every external process — the Vibe-Trading sidecar, a local LLM, a future tax tool. Each is spoken to over the versioned Advisor contract, never over our internal ports, and must not be able to read Ledger, Connections, or Identity.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.integrations`) and event metadata. */
export const CONTEXT_ID = 'integrations' as const;
