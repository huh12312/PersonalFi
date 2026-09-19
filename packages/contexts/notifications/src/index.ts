// SPDX-License-Identifier: MIT
/**
 * `@ctx/notifications` — Notifications.
 *
 * Channels, rules, quiet hours, and the delivery outbox. Knows only about
 * events: it never imports a domain context. If Budgeting wants to notify, it
 * emits an event.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What a reader should know before using any of it
 *
 * **Egress is this package's security surface.** Nothing exported here will
 * open a socket to a destination that has not passed `guardDestination` — not
 * the adapters, not the delivery job, not `verifyChannel`. The guard is
 * exported so `apps/api` can build its policy from operator configuration and
 * so the Phase 2 gate can re-run the refusal matrix from inside the worker
 * container; it is not exported so that a caller can route around it, and
 * there is no exported path that does.
 *
 * **The channel config is sealed and is opened one send at a time.** A
 * plaintext SMTP password exists for the duration of a single `sendMail`.
 */

/** Stable identifier used by feature flags (`module.notifications`) and event metadata. */
export const CONTEXT_ID = 'notifications' as const;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export {
  NOTIFICATIONS_EVENTS,
  NotificationQueued,
  NotificationDelivered,
  NotificationFailed,
} from './events.ts';

// ---------------------------------------------------------------------------
// The consumer
// ---------------------------------------------------------------------------
export {
  createNotificationsConsumer,
  CONSUMER_NAME,
  CONSUMED_EVENT_TYPES,
  type NotificationsConsumerDependencies,
} from './consumer.ts';

// ---------------------------------------------------------------------------
// The port and its adapters
// ---------------------------------------------------------------------------
export {
  channelConfigSchema,
  ntfyConfigSchema,
  smtpConfigSchema,
  type AdapterKind,
  type ChannelCapabilities,
  type ChannelConfig,
  type DeliveryOutcome,
  type DeliveryResult,
  type Notification,
  type NotificationAction,
  type NotificationChannel,
  type NtfyChannelConfig,
  type RedactedChannel,
  type SmtpChannelConfig,
  type VerifyResult,
} from './channel.ts';
export { createNtfyChannel, truncate, type NtfyChannelOptions } from './adapters/ntfy.ts';
export {
  createSmtpChannel,
  type SmtpChannelOptions,
  type SmtpMessage,
  type SmtpTransport,
  type SmtpTransportFactory,
  type SmtpTransportOptions,
} from './adapters/smtp.ts';
export { createFakeChannel, type FakeChannel, type FakeDelivery } from './adapters/fake.ts';

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------
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
  type EgressDecision,
  type EgressPolicy,
  type EgressPolicyInput,
  type RefusalCode,
  type Resolver,
} from './egress.ts';
export {
  createNodeTransport,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './transport.ts';

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
export {
  createChannel,
  createRule,
  findChannel,
  listChannels,
  openChannelConfig,
  redactChannel,
  rulesForEvent,
  setChannelEnabled,
  verifyChannel,
  channelConfigRef,
  ChannelRefusedError,
  CHANNEL_CONFIG_COLUMN,
  CHANNEL_CONFIG_TABLE,
  type ChannelRegistry,
  type CreateChannelDependencies,
  type CreateChannelInput,
  type CreateRuleInput,
} from './service.ts';
export {
  matchesConditions,
  assertConditionsValid,
  ConditionError,
  type ConditionOperator,
  type Conditions,
} from './conditions.ts';
export { renderNotification, formatMinor, type RenderedNotification } from './render.ts';

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------
export {
  enqueueNotification,
  claimDueNotifications,
  markDelivered,
  markFailed,
  retryNotification,
  digestDedupeKey,
  DEFAULT_DELIVERY_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  type EnqueueNotificationInput,
  type EnqueueNotificationResult,
  type MarkFailedResult,
} from './outbox.ts';

// ---------------------------------------------------------------------------
// Jobs and schedules
// ---------------------------------------------------------------------------
export {
  createDeliveryJob,
  createDigestJob,
  closeDigestWindows,
  drainNotifications,
  digestBody,
  registerNotificationSchedules,
  backgroundCorrelationId,
  DELIVER_JOB_KIND,
  DIGEST_JOB_KIND,
  type DeliveryJobDependencies,
  type DigestJobDependencies,
  type SecretBoxProvider,
} from './jobs.ts';

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
export {
  listAttempts,
  listDeadLetters,
  listOutbox,
  type AttemptEntry,
  type DeadLetter,
  type OutboxEntry,
} from './read.ts';

// ---------------------------------------------------------------------------
// Time, exported because the API layer renders quiet-hours windows
// ---------------------------------------------------------------------------
export {
  digestWindowFor,
  instantForLocalTime,
  isQuietAt,
  isWithinQuietHours,
  localDateIn,
  localMinuteOfDay,
  localPartsIn,
  mondayOnOrBefore,
  quietHoursReleaseAt,
  MINUTES_PER_DAY,
  type DigestCadenceName,
  type DigestWindow,
  type LocalParts,
  type QuietHours,
} from './time.ts';

// ---------------------------------------------------------------------------
// Database handles
// ---------------------------------------------------------------------------
export type {
  NotificationsContext,
  NotificationsDatabase,
  NotificationsExecutor,
} from './db.ts';
