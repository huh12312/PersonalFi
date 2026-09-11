// SPDX-License-Identifier: MIT
import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { flagColumn, updatedAtColumn, userIdColumn } from '../columns.ts';

/**
 * Progressive module rollout and safe degradation — not A/B testing.
 *
 * Defaults live in code; a row here is an override. Flags gate navigation *and*
 * job/consumer registration, so a disabled module costs nothing at runtime. That
 * is what lets a half-finished phase merge to `main` instead of living on a branch
 * for six weeks.
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
