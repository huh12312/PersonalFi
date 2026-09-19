// SPDX-License-Identifier: MIT
/**
 * The `@ctx/notifications` test harness.
 *
 * `@core/testkit` is a dev-only dependency of this context, allowed by the
 * `notifications` entry in `scripts/eslint-boundaries.js` rather than by an
 * `eslint-disable` here — so the looseness is visible in the policy instead of
 * hidden at the top of a test file. No file under `src/` imports it.
 *
 * ## Nothing here can send a real message
 *
 * 02-phase-2-dispatch.md's rule for WP 2.4 is explicit: no test may send a real
 * email or a real ntfy push. Three things enforce it rather than one:
 *
 *   * every database-backed suite registers `createFakeChannel()` for **both**
 *     channel kinds, so even a bug that picked the wrong adapter reaches a
 *     recorder and not a socket;
 *   * the allow-list below names two hosts that exist in no zone
 *     (`*.notify.test`, an RFC 6761 reserved TLD), so a send that somehow
 *     escaped the fake would be refused at DNS and then again at the allow-list;
 *   * the ports the fixtures listen on are chosen by the OS and the only thing
 *     that ever connects to them is `test/egress-allowlist.test.ts`'s own
 *     transport.
 *
 * ## Why the upstream events are redeclared rather than imported
 *
 * `src/render.ts` names its triggers as **strings**, because importing
 * `@ctx/budgeting`'s or `@ctx/connections`'s `events.ts` would be importing
 * another context and the boundary lint correctly refuses. A duplicated string
 * is the honest cost of that decoupling, and a duplicated string can be wrong.
 * The definitions below are field-for-field copies of the real ones
 * (`packages/contexts/{budgeting,recurring,connections}/src/events.ts`), so a
 * rename on either side makes these suites go quiet — which is why every suite
 * starts by asserting the pump actually delivered something.
 */
import { newId, type Clock, type MutableClock } from '@core/kernel';
import { mutableClock } from '@core/kernel';
import { SecretBox } from '@core/secretbox';
import {
  createConsumerPump,
  defineEvent,
  platformExecutor,
  type ConsumerPump,
} from '@core/platform';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createFakeChannel, type FakeChannel } from '../src/adapters/fake.ts';
import type { ChannelConfig, NtfyChannelConfig, SmtpChannelConfig } from '../src/channel.ts';
import { createNotificationsConsumer } from '../src/consumer.ts';
import type { NotificationsContext } from '../src/db.ts';
import { createEgressPolicy, type EgressPolicy } from '../src/egress.ts';
import { drainNotifications, type DeliveryJobDependencies } from '../src/jobs.ts';
import { createChannel, createRule, type ChannelRegistry } from '../src/service.ts';
import type { DeliveryClass, DigestCadence } from '../schema/index.ts';

export { ADMIN_URL, createFakeChannel, type FakeChannel, type TestDatabase };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000d4';

/**
 * `America/New_York`, and not by accident: 2026-03-08 is 23 hours long there,
 * which is the boundary `test/db/quiet-hours.test.ts` is built on.
 */
export const ZONE = 'America/New_York';

/**
 * Two hosts under `.test`, which RFC 6761 §6.2 reserves and guarantees will
 * never resolve. The allow-list is real — these suites do not relax the policy —
 * so a send that escaped the fake adapter would be refused twice over.
 */
export const NTFY_HOST = 'ntfy.notify.test';
export const SMTP_HOST = 'smtp.notify.test';

/** The production policy shape, with two hosts an operator might have named. */
export const TEST_POLICY: EgressPolicy = createEgressPolicy({
  allowedHosts: [NTFY_HOST, SMTP_HOST],
});

/** Argon2id at the floor: these suites unlock a box per file, not per row. */
const TEST_KDF = { memoryKiB: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

export async function notificationsDatabase(suite: string): Promise<TestDatabase> {
  return createTestDatabase(`personalfi_wp_notif_${suite}`);
}

export function clockAt(instant: string): MutableClock {
  return mutableClock(instant);
}

export function contextFor(userId: string, clock: Clock): NotificationsContext {
  return { userId, clock, correlationId: CORRELATION_ID, causationId: null };
}

export async function unlockedSecretBox(
  database: TestDatabase,
  clock: Clock,
  userId: string = database.userId,
): Promise<SecretBox> {
  const box = new SecretBox({
    db: database.pool,
    userId,
    clock,
    kdfParams: TEST_KDF,
    kdfFloor: TEST_KDF,
  });
  await box.unlock('a passphrase that exists only in this test');
  return box;
}

/** Both kinds answered by a recorder. See the header. */
export function fakeRegistry(channel: FakeChannel): ChannelRegistry {
  return { ntfy: channel, smtp: channel };
}

export function ntfyConfig(overrides: Partial<NtfyChannelConfig> = {}): NtfyChannelConfig {
  return {
    kind: 'ntfy',
    scheme: 'https',
    host: NTFY_HOST,
    port: 443,
    topic: 'personalfi-test',
    accessToken: null,
    ...overrides,
  };
}

export function smtpConfig(overrides: Partial<SmtpChannelConfig> = {}): SmtpChannelConfig {
  return {
    kind: 'smtp',
    scheme: 'smtps',
    host: SMTP_HOST,
    port: 465,
    username: 'notifier@notify.test',
    password: 'correct-horse-battery-staple-DO-NOT-LEAK',
    from: 'notifier@notify.test',
    to: 'holder@notify.test',
    ...overrides,
  };
}

/**
 * A channel that is `enabled`.
 *
 * `createChannel` writes it disabled — `notification_channels_enabled_is_verified`
 * refuses anything else — so the enabling here goes through the same column a
 * successful `verifyChannel` would set, and never around the constraint.
 */
export async function enabledChannel(
  database: TestDatabase,
  context: NotificationsContext,
  secretBox: SecretBox,
  input: { readonly displayName?: string; readonly config?: ChannelConfig } = {},
): Promise<string> {
  const channel = await createChannel(
    database.db,
    context,
    {
      displayName: input.displayName ?? 'Test channel',
      config: input.config ?? ntfyConfig(),
    },
    { secretBox, policy: TEST_POLICY },
  );
  await database.db.execute(sql`
    UPDATE notification_channels
    SET verified_at = ${context.clock.now().toISOString()}::timestamptz, enabled = TRUE
    WHERE id = ${channel.id}::uuid
  `);
  return channel.id;
}

export async function ruleFor(
  database: TestDatabase,
  context: NotificationsContext,
  input: {
    readonly channelId: string;
    readonly eventType: string;
    readonly deliveryClass: DeliveryClass;
    readonly name?: string;
    readonly digestCadence?: DigestCadence;
    readonly quietHoursEnabled?: boolean;
    readonly conditions?: Readonly<Record<string, unknown>>;
  },
): Promise<string> {
  const rule = await createRule(database.db, context, {
    channelId: input.channelId,
    name: input.name ?? `rule-${newId().slice(0, 8)}`,
    eventType: input.eventType,
    deliveryClass: input.deliveryClass,
    digestCadence: input.digestCadence ?? null,
    timezone: ZONE,
    quietHoursEnabled: input.quietHoursEnabled ?? false,
    conditions: input.conditions ?? {},
  });
  return rule.id;
}

/** The real pump, wired to the real consumer. */
export function pumpFor(database: TestDatabase, clock: Clock): ConsumerPump {
  return createConsumerPump({
    pool: database.pool,
    db: platformExecutor(database.db),
    clock,
    consumers: [createNotificationsConsumer({ database: database.db })],
  });
}

/**
 * The delivery job's dependencies, with the backoff flattened to zero.
 *
 * A test that had to wait out the real ladder (30 s, then 60, then 120…) would
 * either sleep for four minutes or move the clock, and moving the clock is what
 * `test/db/quiet-hours.test.ts` is *for* — using it here too would make a
 * delivery failure and a quiet-hours hold indistinguishable in the assertions.
 * The ladder's arithmetic is `@core/platform`'s and is tested there; what these
 * suites assert is the *shape* of the walk: five attempts, then dead.
 */
export function deliveryDependencies(
  database: TestDatabase,
  clock: Clock,
  channel: FakeChannel,
  secretBox: SecretBox,
): DeliveryJobDependencies {
  return {
    database: database.db,
    registry: fakeRegistry(channel),
    secretBoxFor: () => secretBox,
    clock,
    backoff: { baseMs: 0, factor: 1, maxMs: 0, jitter: 'none' },
  };
}

export async function drainOnce(
  dependencies: DeliveryJobDependencies,
  userId: string,
): Promise<number> {
  return drainNotifications(dependencies, userId, CORRELATION_ID);
}

// ---------------------------------------------------------------------------
// The upstream events, redeclared. See the header.
// ---------------------------------------------------------------------------

const uuid = z.uuid();
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const minorUnits = z.string().regex(/^-?\d+$/);

/** `@ctx/budgeting`'s, field for field. */
export const BudgetThresholdCrossed = defineEvent({
  type: 'budgeting.BudgetThresholdCrossed',
  aggregateType: 'budget_line',
  description: 'An envelope crossed a spending threshold. Redeclared for the notifications suites.',
  schema: z.object({
    budgetId: uuid,
    periodId: uuid,
    lineId: uuid.nullable(),
    categoryId: uuid.nullable(),
    threshold: z.enum([
      'PCT_50',
      'PCT_80',
      'PCT_100',
      'OVERSPENT_CASH',
      'OVERSPENT_CREDIT',
      'RTA_NEGATIVE',
    ]),
    ratio: decimal.nullable(),
    available: decimal,
    currency: z.string().length(3),
  }),
});

/** `@ctx/recurring`'s, field for field. */
export const PriceChangeDetected = defineEvent({
  type: 'recurring.PriceChangeDetected',
  aggregateType: 'recurring_series',
  description: 'A changepoint was recorded for a series. Redeclared for the notifications suites.',
  schema: z.object({
    priceChangeEventId: uuid,
    seriesId: uuid,
    merchantId: uuid,
    direction: z.enum(['INCREASE', 'DECREASE']),
    effectiveDate: z.string(),
    confirmed: z.boolean(),
    annualImpactMinor: minorUnits,
    currency: z.string().length(3),
  }),
});

/** `@ctx/connections`'s, with the enums spelled out rather than imported. */
export const ConnectionStatusChanged = defineEvent({
  type: 'connections.ConnectionStatusChanged',
  aggregateType: 'connection',
  description: 'A connection changed status. Redeclared for the notifications suites.',
  schema: z.object({
    connectionId: uuid,
    provider: z.string().min(1),
    from: z.enum(['active', 'reauth_required', 'error', 'disconnected']),
    to: z.enum(['active', 'reauth_required', 'error', 'disconnected']),
    reason: z.string().nullable(),
    providerCode: z.string().nullable(),
  }),
});

export interface ThresholdFact {
  readonly budgetId: string;
  readonly periodId: string;
  readonly lineId: string;
  readonly threshold: 'PCT_50' | 'PCT_80' | 'PCT_100' | 'OVERSPENT_CASH' | 'OVERSPENT_CREDIT';
  readonly available?: string;
}

export type ThresholdPayload = z.infer<typeof BudgetThresholdCrossed.schema>;
export type StatusPayload = z.infer<typeof ConnectionStatusChanged.schema>;

export function thresholdPayload(fact: ThresholdFact): ThresholdPayload {
  return {
    budgetId: fact.budgetId,
    periodId: fact.periodId,
    lineId: fact.lineId,
    categoryId: null,
    threshold: fact.threshold,
    ratio: '1.00',
    available: fact.available ?? '-12.34',
    currency: 'USD',
  };
}

export function statusPayload(input: {
  readonly connectionId: string;
  readonly provider?: string;
  readonly from?: StatusPayload['from'];
  readonly to?: StatusPayload['to'];
}): StatusPayload {
  return {
    connectionId: input.connectionId,
    provider: input.provider ?? 'Chase',
    from: input.from ?? 'active',
    to: input.to ?? 'reauth_required',
    reason: null,
    providerCode: null,
  };
}
