// SPDX-License-Identifier: MIT
/**
 * `@ctx/notifications` — Notifications.
 *
 * Channels, rules, quiet hours, and the delivery outbox. Knows only about events: it never imports a domain context. If Budgeting wants to notify, it emits an event.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.notifications`) and event metadata. */
export const CONTEXT_ID = 'notifications' as const;
