// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@core/platform`.
 *
 * Hand-written SQL for them lives in `packages/db/migrations/0003_platform.sql`,
 * so there is one ordered, forward-only history for the whole database. These
 * definitions are how TypeScript reads and writes those tables, and what
 * `just migrate-check` diffs against the live schema.
 */
export { domainEvents, type DomainEventRow } from './domain-events.ts';
export {
  eventConsumerOffsets,
  processedEvents,
  type EventConsumerOffsetRow,
  type ProcessedEventRow,
} from './consumers.ts';
export { jobs, jobRuns, type JobRow, type JobRunRow } from './jobs.ts';
export { schedules, type ScheduleRow } from './schedules.ts';
export { configSnapshots, type ConfigSnapshotRow } from './config-snapshots.ts';
export { featureFlags, type FeatureFlagRow } from './feature-flags.ts';
