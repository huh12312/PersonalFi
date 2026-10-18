// SPDX-License-Identifier: MIT
import { createdAtColumn, idColumn } from '@core/db/columns';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * The account holder.
 *
 * Single user today, but every user-scoped table carries `user_id` from the first
 * migration (decision D6) so multi-user is additive rather than a rewrite of every
 * query. No role system is built and none is implied.
 */
export const users = pgTable('users', {
  id: idColumn(),
  displayName: text('display_name').notNull(),
  /**
   * IANA zone. Every period boundary — budget months, "today", digest windows, the
   * daily snapshot seal — is computed here via `todayIn(clock, zone)`, never from
   * the container's `TZ` and never from the browser's. WP 0.1 flagged its absence;
   * migration `0002_identity` adds it with a default of `UTC`.
   */
  displayTimezone: text('display_timezone').notNull().default('UTC'),
  /**
   * The dashboard's widget order and visibility (WP 10.9, migration `0046_dashboard_layout`): a JSON array of
   * `{ id, visible }` in display order, read and written only by `apps/api/src/routes/dashboard.ts`. NULL is the
   * default layout. The CHECK `users_dashboard_layout_is_array` holds the array shape; the route holds the ids.
   */
  dashboardLayout: jsonb('dashboard_layout').$type<readonly { id: string; visible: boolean }[]>(),
  createdAt: createdAtColumn(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
