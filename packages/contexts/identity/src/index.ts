// SPDX-License-Identifier: MIT
/**
 * `@ctx/identity` — Identity & Security.
 *
 * Authentication, sessions, key custody, and the audit trail. Owns `SecretBox`, the single chokepoint through which every other context encrypts anything: no context may import a crypto library directly.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.identity`) and event metadata. */
export const CONTEXT_ID = 'identity' as const;
