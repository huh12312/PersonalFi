// SPDX-License-Identifier: MIT
import { createdAtColumn, instantColumn, updatedAtColumn, userIdColumn } from '@core/db/columns';
import { index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The work queue. Postgres is the queue: no Redis, no second stateful container,
 * no second durability story, and — the decisive property — enqueueing a job and
 * writing the data that justifies it happen in one transaction.
 *
 * Claimed with `FOR UPDATE SKIP LOCKED`, heartbeated while running, reclaimed by
 * a reaper when a worker dies. See `src/jobs/runner.ts`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    userId: userIdColumn(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /**
     * "Do not queue this twice." Unique among queued-or-running jobs. A webhook,
     * the nightly schedule, and the user clicking refresh is three concurrent
     * syncs of one connection, which is the fastest way to corrupt cursor state.
     */
    dedupeKey: text('dedupe_key'),
    /**
     * "Do not run two of these at once." Weaker than dedupe: others still queue
     * and run later, rather than being dropped on the floor.
     */
    singletonKey: text('singleton_key'),
    priority: integer('priority').notNull().default(100),
    runAfter: instantColumn('run_after').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** `pending` | `running` | `succeeded` | `failed` | `dead` | `cancelled`. */
    status: text('status').notNull().default('pending'),
    lockedBy: text('locked_by'),
    lockedAt: instantColumn('locked_at'),
    /**
     * A lock alone is not enough. One `docker kill` mid-sync leaves a job
     * `running` forever; the reaper reclaims anything whose heartbeat is stale.
     */
    heartbeatAt: instantColumn('heartbeat_at'),
    correlationId: uuid('correlation_id').notNull(),
    causationEventId: uuid('causation_event_id'),
    lastError: jsonb('last_error'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    completedAt: instantColumn('completed_at'),
  },
  (table) => [
    index('jobs_kind_status_idx').on(table.kind, table.status),
    index('jobs_correlation_idx').on(table.correlationId),
  ],
);

export type JobRow = typeof jobs.$inferSelect;

/**
 * One row per attempt, including the ones a killed worker never finished.
 *
 * This is the observability surface that matters: "why did last night's sync not
 * happen?" is answered from a table with a UI, not from a log file that has
 * rotated away.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id').notNull(),
    userId: userIdColumn(),
    attempt: integer('attempt').notNull(),
    workerId: text('worker_id').notNull(),
    startedAt: instantColumn('started_at').notNull().defaultNow(),
    finishedAt: instantColumn('finished_at'),
    /** `succeeded` | `failed` | `abandoned`. The last is what the reaper records. */
    outcome: text('outcome'),
    durationMs: integer('duration_ms'),
    error: jsonb('error'),
    correlationId: uuid('correlation_id').notNull(),
  },
  (table) => [
    unique('job_runs_job_id_attempt_key').on(table.jobId, table.attempt),
    index('job_runs_job_idx').on(table.jobId, table.attempt),
  ],
);

export type JobRunRow = typeof jobRuns.$inferSelect;
