// SPDX-License-Identifier: MIT
/**
 * `@ctx/recurring` — Recurring.
 *
 * Subscription and bill detection as a *candidate* pipeline with human confirmation. A false 'you have a subscription' is a trust-destroying bug, so nothing is acted on silently.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.recurring`) and event metadata. */
export const CONTEXT_ID = 'recurring' as const;
