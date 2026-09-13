// SPDX-License-Identifier: MIT
import { flagColumn, updatedAtColumn, userIdColumn } from '@core/db/columns';
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/**
 * Progressive module rollout and safe degradation — not A/B testing.
 *
 * Defaults live in code; a row here is an override. Flags gate navigation *and*
 * job/consumer registration, so a disabled module costs nothing at runtime. That
 * is what lets a half-finished phase merge to `main` instead of living on a branch
 * for six weeks.
 *
 * The table is defined here rather than in `@core/db` because the flag *service*
 * lives next to the consumers and schedules it gates, and a table belongs to the
 * package that owns its behaviour (`packages/platform/OWNERSHIP.md`).
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    userId: userIdColumn(),
    key: text('key').notNull(),
    enabled: flagColumn('enabled').notNull().default(false),
    updatedAt: updatedAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

export type FeatureFlagRow = typeof featureFlags.$inferSelect;
