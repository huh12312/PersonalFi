// SPDX-License-Identifier: MIT
/**
 * Channels and rules: create, seal, open, verify.
 *
 * ## Custody (decision D5)
 *
 * The channel config is sealed with `SecretBox` under a **per-record DEK**, the
 * same policy `connections.sealed_credentials` uses, with the AAD
 *
 *     personalfi/v1|notification_channels|sealed_config|<channel id>|<key version>
 *
 * Two portability properties follow, and `test/db/custody.test.ts` asserts both
 * rather than asserting the absence of a string and calling it a day:
 *
 * * **Across rows.** The AAD names the row, so lifting the bytes from channel A
 *   into channel B stops the Poly1305 tag verifying.
 * * **Across users.** The DEK is a per-user `encryption_keys` row, and
 *   `SecretBox.open` refuses a key the box does not own *before* any cipher
 *   runs. This is where the "bound to user" half of the binding lives, and it
 *   is stronger than putting a user id in the AAD would be: an AAD mismatch is
 *   a failed tag check, while a foreign key id is a refusal that never touches
 *   key material at all.
 *
 * ## The clear columns are checked against the sealed ones
 *
 * `destination_host`, `destination_port` and `scheme` exist twice: once in the
 * clear, where an operator can audit them and the egress guard can read them
 * without the passphrase, and once inside the envelope. `openChannelConfig`
 * compares them and refuses on a mismatch. That is what stops the obvious
 * attack on the split — an `UPDATE notification_channels SET destination_host =
 * 'db'` by someone with a psql prompt but not the passphrase.
 *
 * ## A destination is guarded before it is ever stored
 *
 * `createChannel` runs the synchronous half of the egress guard (scheme, host
 * allow-list, port, literal IP) and refuses to write a row that fails it. The
 * full guard, including DNS, runs again on every send — because an allow-list
 * can change and a name can be re-pointed — but refusing at the door means
 * `db:5432` never becomes a row that someone later has to notice.
 */
import { newId } from '@core/kernel';
import type { ColumnRef, SecretBox } from '@core/secretbox';
import { and, eq } from 'drizzle-orm';
import {
  channelConfigSchema,
  type ChannelConfig,
  type NotificationChannel,
  type RedactedChannel,
  type VerifyResult,
} from './channel.ts';
import type { NotificationsContext, NotificationsExecutor } from './db.ts';
import { checkDestination, type EgressPolicy, type RefusalCode } from './egress.ts';
import {
  notificationChannels,
  notificationRules,
  type ChannelKind,
  type DeliveryClass,
  type DigestCadence,
  type NotificationChannelRow,
  type NotificationRuleRow,
} from '../schema/index.ts';

export const CHANNEL_CONFIG_TABLE = 'notification_channels';
export const CHANNEL_CONFIG_COLUMN = 'sealed_config';

/** The one place the AAD for a channel config is constructed. */
export function channelConfigRef(channelId: string): ColumnRef {
  return { table: CHANNEL_CONFIG_TABLE, column: CHANNEL_CONFIG_COLUMN, rowId: channelId };
}

export class ChannelRefusedError extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, detail: string) {
    super(`channel refused (${code}): ${detail}`);
    this.name = 'ChannelRefusedError';
    this.code = code;
  }
}

/** The adapters available at run time, by kind. */
export type ChannelRegistry = Readonly<Record<ChannelKind, NotificationChannel>>;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface CreateChannelInput {
  readonly displayName: string;
  readonly config: ChannelConfig;
}

export interface CreateChannelDependencies {
  readonly secretBox: SecretBox;
  readonly policy: EgressPolicy;
}

export async function createChannel(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: CreateChannelInput,
  dependencies: CreateChannelDependencies,
): Promise<RedactedChannel> {
  const config = channelConfigSchema.parse(input.config);

  // The door. A destination that cannot pass the guard never becomes a row.
  const decision = checkDestination(
    { scheme: config.scheme, host: config.host, port: config.port },
    dependencies.policy,
  );
  if (!decision.ok) throw new ChannelRefusedError(decision.code, decision.detail);

  const id = newId();
  const sealed = await dependencies.secretBox.sealText(
    channelConfigRef(id),
    JSON.stringify(config),
  );
  const now = context.clock.now();

  const [row] = await executor
    .insert(notificationChannels)
    .values({
      id,
      userId: context.userId,
      kind: config.kind,
      displayName: input.displayName,
      destinationHost: decision.destination.host,
      destinationPort: config.port,
      scheme: config.scheme,
      sealedConfig: sealed,
      // Disabled until `verifyChannel` has actually reached the destination.
      // `notification_channels_enabled_is_verified` enforces the same thing.
      enabled: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (row === undefined) throw new Error('notification_channels insert returned no row');
  return redactChannel(row);
}

export async function listChannels(
  executor: NotificationsExecutor,
  userId: string,
): Promise<readonly RedactedChannel[]> {
  const rows = await executor
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, userId));
  return rows.map(redactChannel);
}

export async function findChannel(
  executor: NotificationsExecutor,
  userId: string,
  channelId: string,
): Promise<NotificationChannelRow | null> {
  const rows = await executor
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)));
  return rows[0] ?? null;
}

/**
 * Open a channel's sealed config, and check it against the clear columns.
 *
 * The mismatch check is not belt-and-braces: it is the control that makes
 * splitting the destination across a sealed and an unsealed copy safe. Without
 * it, anyone with write access to Postgres but no passphrase could re-point a
 * verified channel at an internal host by editing three unsealed columns.
 */
export async function openChannelConfig(
  row: NotificationChannelRow,
  secretBox: SecretBox,
): Promise<ChannelConfig> {
  const plaintext = await secretBox.openText(channelConfigRef(row.id), row.sealedConfig);
  const config = channelConfigSchema.parse(JSON.parse(plaintext));
  if (
    config.kind !== row.kind ||
    config.scheme !== row.scheme ||
    config.host !== row.destinationHost ||
    config.port !== row.destinationPort
  ) {
    throw new ChannelRefusedError(
      'host_not_allowed',
      `channel ${row.id}: the stored destination does not match the sealed one`,
    );
  }
  return config;
}

/**
 * The "send test notification" action (08 §4.5).
 *
 * On success the channel becomes `enabled`; on failure it records the refusal
 * code and stays disabled. Both halves matter: the first is the only path that
 * can set `enabled`, and the second is what turns a typo into a message on a
 * settings screen rather than five entries in the dead-letter view at 03:00.
 */
export async function verifyChannel(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: { readonly channelId: string },
  dependencies: { readonly secretBox: SecretBox; readonly registry: ChannelRegistry },
): Promise<VerifyResult> {
  const row = await findChannel(executor, context.userId, input.channelId);
  if (row === null) return { ok: false, detail: 'no such channel' };

  let config: ChannelConfig;
  try {
    config = await openChannelConfig(row, dependencies.secretBox);
  } catch (error) {
    return {
      ok: false,
      refusalCode: error instanceof ChannelRefusedError ? error.code : null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const adapter = dependencies.registry[row.kind];
  const result = await adapter.verify(config);
  const now = context.clock.now();

  await executor
    .update(notificationChannels)
    .set(
      result.ok
        ? { enabled: true, verifiedAt: now, verifyFailureCode: null, updatedAt: now }
        : {
            enabled: false,
            verifyFailureCode: result.refusalCode ?? 'verify_failed',
            updatedAt: now,
          },
    )
    .where(
      and(eq(notificationChannels.id, row.id), eq(notificationChannels.userId, context.userId)),
    );

  return result;
}

/** Turn a channel off without deleting it, and without unsealing anything. */
export async function setChannelEnabled(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  channelId: string,
  enabled: boolean,
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(notificationChannels)
    .set({ enabled, updatedAt: now })
    .where(
      and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, context.userId)),
    );
}

export function redactChannel(row: NotificationChannelRow): RedactedChannel {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    destinationHost: row.destinationHost,
    destinationPort: row.destinationPort,
    scheme: row.scheme,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt,
    verifyFailureCode: row.verifyFailureCode,
    lastDeliveryAt: row.lastDeliveryAt,
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface CreateRuleInput {
  readonly channelId: string;
  readonly name: string;
  readonly eventType: string;
  readonly conditions?: Readonly<Record<string, unknown>>;
  readonly deliveryClass: DeliveryClass;
  readonly digestCadence?: DigestCadence | null;
  readonly timezone: string;
  readonly quietHoursEnabled?: boolean;
  readonly quietHoursStartMinute?: number;
  readonly quietHoursEndMinute?: number;
  readonly enabled?: boolean;
}

export async function createRule(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: CreateRuleInput,
): Promise<NotificationRuleRow> {
  const now = context.clock.now();
  // `notification_rules_p0_ignores_quiet_hours` refuses the contradiction in
  // SQL; defaulting it here means a caller does not have to know that.
  const quietHoursEnabled =
    input.deliveryClass === 'P0_SAFETY' ? false : (input.quietHoursEnabled ?? true);

  const [row] = await executor
    .insert(notificationRules)
    .values({
      id: newId(),
      userId: context.userId,
      channelId: input.channelId,
      name: input.name,
      eventType: input.eventType,
      conditions: input.conditions ?? {},
      deliveryClass: input.deliveryClass,
      digestCadence:
        input.deliveryClass === 'DIGEST' ? (input.digestCadence ?? 'WEEKLY') : null,
      timezone: input.timezone,
      quietHoursEnabled,
      quietHoursStartMinute: input.quietHoursStartMinute ?? 1320,
      quietHoursEndMinute: input.quietHoursEndMinute ?? 420,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (row === undefined) throw new Error('notification_rules insert returned no row');
  return row;
}

/**
 * The enabled rules for an event type, with their channel.
 *
 * A disabled channel yields no rules: `notification_channels.enabled` is the
 * kill switch for everything behind it, which is what "both built, both
 * disabled until configured" means once the rules exist.
 */
export async function rulesForEvent(
  executor: NotificationsExecutor,
  userId: string,
  eventType: string,
): Promise<readonly { readonly rule: NotificationRuleRow; readonly channel: NotificationChannelRow }[]> {
  const rows = await executor
    .select({ rule: notificationRules, channel: notificationChannels })
    .from(notificationRules)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationRules.channelId))
    .where(
      and(
        eq(notificationRules.userId, userId),
        eq(notificationRules.eventType, eventType),
        eq(notificationRules.enabled, true),
        eq(notificationChannels.enabled, true),
      ),
    );
  return rows;
}
