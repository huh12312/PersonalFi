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
  newEventSchema,
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
export {
  createLivenessWriter,
  type LivenessWriter,
  type LivenessWriterOptions,
} from './liveness.ts';
export { toInstant, toInstantOrNull, type TimestampValue } from './instants.ts';
export { createSleeper, type Sleeper } from './sleep.ts';
export {
  silentLogger,
  type Executor,
  type TransactionalExecutor,
  type PlatformLogger,
} from './executor.ts';
export {
  PlatformError,
  ConsumerHandlerError,
  PoolCannotCoverPinnedConnectionsError,
  serializeError,
  describeError,
} from './errors.ts';
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

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------
//
// The outbound-request guard and the transport that honours it. Written in WP
// 2.4 inside `@ctx/notifications`, moved here (not copied — `git log --follow`
// reaches WP 2.4) in WP 3.4 so the *second* egress surface, market data, reuses
// it rather than reimplementing it: 03-phase-3-dispatch.md §5 requires exactly
// that, and `personalfi/layer-imports` denies a context->context import, so the
// only place two contexts can share a module is the layer below both.
//
// It sits in `@core/platform` for the same reason the outbox does: it is
// substrate that must know nothing about who is calling it. It reaches no
// database and holds no state, so importing it costs a caller nothing.
export {
  createEgressPolicy,
  checkDestination,
  checkUrl,
  guardDestination,
  guardUrl,
  classifyAddress,
  classifyStatus,
  isPublicAddress,
  looksLikeIpLiteral,
  normaliseHost,
  assertHeaderValueSafe,
  systemResolver,
  EgressRefusedError,
  isEgressRefusedError,
  DENY_ALL_POLICY,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  REFUSAL_CODES,
  type AddressClass,
  type Destination,
  type DestinationInput,
  type EgressDecision,
  type EgressPolicy,
  type EgressPolicyInput,
  type RefusalCode,
  type Resolver,
  type StatusVerdict,
} from './egress/policy.ts';
export {
  createNodeTransport,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './egress/transport.ts';
// WP 5.2 (05-phase-5-dispatch.md §3): the *inverse* policy, as a second type
// rather than a switch on the one above — loopback/private only, one host and
// port, for `@advisor/local-model`'s Ollama client. `@core/platform`'s
// `exports` map is closed, so this block is the adapter's only way to reach it.
export {
  checkLocalEndpoint,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  guardLocalEndpoint,
  isLocalEndpointRefusedError,
  LocalEndpointRefusedError,
  LOCAL_ENDPOINT_REFUSAL_CODES,
  DEFAULT_LOCAL_MAX_RESPONSE_BYTES,
  DEFAULT_LOCAL_TIMEOUT_MS,
  type LocalAddressDecision,
  type LocalEndpointDecision,
  type LocalEndpointPolicy,
  type LocalEndpointPolicyInput,
  type LocalEndpointRefusalCode,
  type LocalEndpointRequest,
  type LocalEndpointResponse,
  type LocalEndpointTransport,
  type LocalEndpointTransportOptions,
} from './egress/local-endpoint.ts';

export * from './schema/index.ts';
