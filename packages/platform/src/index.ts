// SPDX-License-Identifier: MIT
/**
 * `@core/platform` — the substrate every bounded context stands on.
 *
 * Five things live here and nothing else does:
 *
 *   * the **outbox** (`appendEvent`, `defineEvent`) — how a context states a fact;
 *   * the **consumer pump** (`registerConsumer`, `replayConsumer`) — how another
 *     context hears it, exactly once, in order, with a replay button;
 *   * the **job queue** (`enqueueJob`, `createJobRunner`) — durable work that
 *     survives a `docker kill`;
 *   * the **scheduler** (`upsertSchedule`, `createScheduler`) — cron the user can
 *     see and edit, in the user's timezone, fired once across every worker;
 *   * **feature flags** — the switch that lets a half-finished module merge.
 *
 * The direction of every arrow: contexts import this; this imports no context.
 * That is enforced by `personalfi/layer-imports` and it is the entire point. The
 * outbox exists so `@ctx/ledger` can say "transactions arrived" without knowing
 * that budgeting, recurring, insights, and notifications are listening — and
 * without changing when a fifth listener appears in Phase 5.
 *
 * The rule, stated once so it can be quoted in review: **contexts write events,
 * never call each other.** An event is a past-tense fact, not a request; it
 * returns nothing and acknowledges nothing. Where a context needs "after X then
 * Y", Y reacts to the event X's consumer emits after its own write.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export {
  eventTypeSchema,
  redactionSchema,
  newEventSchema,
  eventEnvelopeSchema,
  type EventEnvelope,
  type NewEvent,
  type RecordedEvent,
  type EventContext,
  type Redaction,
} from './events/envelope.ts';
export {
  defineEvent,
  createEventRegistry,
  type EventDefinition,
  type DefineEventOptions,
  type EventRegistry,
} from './events/registry.ts';
export { appendEvent, appendEvents, type AppendOptions } from './events/outbox.ts';
export {
  registerConsumer,
  createConsumerPump,
  replayConsumer,
  setConsumerStatus,
  skipFailedEvent,
  outboxHealth,
  type ConsumerHandler,
  type ConsumerContext,
  type ConsumerOptions,
  type ConsumerPump,
  type ConsumerPumpOptions,
  type ConsumerStatus,
  type ConsumerHealth,
  type OutboxHealth,
  type RegisteredConsumer,
} from './events/pump.ts';

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export {
  enqueueJob,
  cancelJob,
  retryDeadJob,
  queueHealth,
  type EnqueueJobInput,
  type EnqueueResult,
  type EnqueueOptions,
  type JobStatus,
  type QueueHealth,
} from './jobs/queue.ts';
export {
  createJobRunner,
  defineJob,
  type JobContext,
  type JobHandler,
  type JobHandlerRegistration,
  type JobRunner,
  type JobRunnerOptions,
} from './jobs/runner.ts';
export {
  createScheduler,
  upsertSchedule,
  nextCronOccurrence,
  type Scheduler,
  type SchedulerOptions,
  type UpsertScheduleInput,
} from './jobs/scheduler.ts';

// ---------------------------------------------------------------------------
// Flags, config, and the plumbing contexts occasionally need
// ---------------------------------------------------------------------------
export {
  createFlagService,
  PLATFORM_FLAGS,
  type FlagDefinition,
  type FlagService,
  type FlagServiceOptions,
} from './flags/flags.ts';
export {
  recordConfigSnapshot,
  latestConfigSnapshot,
  configHash,
  canonicalJson,
  type ConfigSnapshotResult,
  type ProcessRole,
  type RecordConfigSnapshotInput,
} from './config-snapshot.ts';
export {
  backoffDelayMs,
  backoffCeilingMs,
  DEFAULT_JOB_BACKOFF,
  DEFAULT_CONSUMER_BACKOFF,
  type BackoffOptions,
} from './backoff.ts';
export {
  createMetrics,
  metricKey,
  METRIC,
  CONSUMER_STATUS_ORDINAL,
  type Metrics,
  type MetricsSnapshot,
  type MetricLabels,
} from './metrics.ts';
export { platformExecutor } from './database.ts';
export { toInstant, toInstantOrNull, type TimestampValue } from './instants.ts';
export { createSleeper, type Sleeper } from './sleep.ts';
export {
  silentLogger,
  type Executor,
  type TransactionalExecutor,
  type PlatformLogger,
} from './executor.ts';
export { PlatformError, ConsumerHandlerError, serializeError, describeError } from './errors.ts';
export {
  EVENT_SEQUENCE_ADVISORY_LOCK_KEY,
  SCHEDULER_ADVISORY_LOCK_KEY,
  JOB_REAPER_ADVISORY_LOCK_KEY,
  CONSUMER_ADVISORY_LOCK_CLASS,
  lockIdForName,
  tryAcquireAdvisoryLease,
  tryAcquireNamedAdvisoryLease,
  type AdvisoryLease,
} from './locks.ts';
export { CHANNEL, createNotifyListener, type Channel, type NotifyListener } from './notify.ts';
export * from './schema/index.ts';
