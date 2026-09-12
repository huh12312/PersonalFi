// SPDX-License-Identifier: MIT
import {
  createdAtColumn,
  flagColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db/columns';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Cron in a table rather than in code.
 *
 * Two reasons, both operational. The user must be able to see and change the
 * nightly sync time without editing a file and restarting a container. And a
 * missed window — the box was off for two days — must be detected and run *once*
 * on the next tick rather than forty times, which only works if "when should this
 * next run?" is state rather than a derived constant.
 *
 * Evaluated by whichever worker holds the scheduler advisory lock, so scaling to
 * two workers does not double every scheduled job.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    userId: userIdColumn(),
    name: text('name').notNull().unique(),
    cron: text('cron').notNull(),
    /**
     * IANA zone. The *user's*, never the container's `TZ`: 03:15 means 03:15
     * where the account holder lives, across DST, or the daily seal lands on the
     * wrong calendar day twice a year.
     */
    timezone: text('timezone').notNull().default('UTC'),
    jobKind: text('job_kind').notNull(),
    jobPayload: jsonb('job_payload').notNull().default({}),
    enabled: flagColumn('enabled').notNull().default(true),
    /** Spread against a provider rather than hitting it on the stroke of the hour. */
    jitterSeconds: integer('jitter_seconds').notNull().default(0),
    lastRunAt: instantColumn('last_run_at'),
    nextRunAt: instantColumn('next_run_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('schedules_due_idx').on(table.nextRunAt)],
);

export type ScheduleRow = typeof schedules.$inferSelect;
