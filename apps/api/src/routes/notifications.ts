// SPDX-License-Identifier: MIT
/**
 * `/notifications/*` — channels, rules and the delivery outbox, as HTTP.
 *
 * WP 2.4 shipped `@ctx/notifications`'s context and migration with no REST
 * surface by its own dispatch scope; `docs/evidence/phase-2/wp2.11-inbox-ui.md`
 * §2/§5 found the gap from the UI side and built `api-pending.ts` against the
 * shape it expected. This file is that surface — see §5 "Swap" in this WP's
 * own evidence for how the shape was reconciled with that stub.
 *
 * ## Auth policy
 *
 * Reading channels/rules/outbox and testing a channel are session-only.
 * Creating or deleting a channel, and deleting a rule, need a step-up
 * assertion — the same `connections.ts` policy for "attach or destroy a
 * credential": a channel's sealed config is exactly that shape of secret, and
 * a notification channel is the first outbound path a *user-supplied string*
 * controls (02-phase-2-dispatch.md §5).
 *
 * ## Egress: a refusal is a Problem, never a 500
 *
 * `createChannel`'s door check (`checkDestination`) throws a
 * `ChannelRefusedError` before a disallowed host is ever stored; with this
 * deployment's default deny-all allow-list (`config.notifications.allowedHosts`
 * empty), every channel creation refuses this way — a clean RFC 9457 problem,
 * never a 500. `POST .../verify` never throws for a refusal, by design: it
 * reaches the destination for real and reports what happened
 * (`{result: {ok, message, testedAt}}`), the same shape
 * `apps/web/src/features/notifications/api-pending.ts`'s stub already
 * expected — a 404 is reserved for a channel id that does not exist at all.
 *
 * ## Matching the WP 2.11 stub, not the other way around
 *
 * `api-pending.ts` was written against a guessed shape before this route
 * existed (`docs/evidence/phase-2/wp2.11-inbox-ui.md` §2). Per this WP's own
 * instructions, the route bends to that guess rather than the UI: `POST
 * /notifications/channels` accepts either the stub's simple `{kind,
 * displayName, destination}` (one address field, no host/port/credentials —
 * exactly what `NotificationSettingsScreen.tsx`'s form collects) or the full
 * `{displayName, config}` a richer client can send. The simple form fills in
 * per-kind defaults (`ntfy` → the public `ntfy.sh` relay over HTTPS, no
 * token; `smtp` → a placeholder relay derived from the address's own domain)
 * — good enough to prove the wire end to end, not a substitute for a real
 * "advanced" SMTP form, which is out of this WP's scope and named in the
 * evidence as follow-up UI work. `destination` and `lastTestResult` on the
 * read side are synthesised from the real, redacted columns
 * (`destinationHost:destinationPort`, `verifiedAt`/`verifyFailureCode`) —
 * never from the sealed config, which stays exactly as unreadable as before.
 *
 * ## Two things `@ctx/notifications`'s public surface does not export
 *
 * There is no `deleteChannel`, no per-field channel update, and no
 * `listRules`/`updateRule` keyed on anything but an event type
 * (`rulesForEvent`). `DELETE`/`PATCH /notifications/channels/{id}` and
 * `GET`/`PUT`/`PATCH /notifications/rules` read and write the tables directly
 * through the package's published `./schema` subpath — the same `apps/`
 * exemption `routes/budgets.ts` uses and `reports/budget-vs-actual.ts`
 * explains. The channel delete relies on
 * `notification_rules`/`notification_outbox`'s `ON DELETE CASCADE` (migration
 * `0011_notifications.sql`) rather than reproducing it. **Recommended context
 * change**: export `deleteChannel`, `renameChannel`, `listRules` and an
 * `upsertRule` keyed on `(userId, name)` from `@ctx/notifications`'s
 * `src/index.ts`.
 */
import { newId } from '@core/kernel';
import {
  ChannelRefusedError,
  channelConfigSchema,
  createChannel,
  findChannel,
  listChannels,
  listAttempts,
  listDeadLetters,
  listOutbox,
  redactChannel,
  retryNotification,
  setChannelEnabled,
  verifyChannel,
  type ChannelConfig,
  type AttemptEntry,
  type NotificationsContext,
  type OutboxEntry,
  type RedactedChannel,
} from '@ctx/notifications';
import {
  DELIVERY_CLASSES,
  DIGEST_CADENCES,
  notificationChannels,
  notificationRules,
  OUTBOX_STATUSES,
  type NotificationRuleRow,
} from '@ctx/notifications/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createNotificationChannels, createNotificationEgressPolicy } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): NotificationsContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

/**
 * `ChannelRefusedError` and a malformed synthesised config → RFC 9457. Local
 * to this file — see the module header. The `ZodError` branch matters because
 * `configFromDestination`'s smtp guess needs `destination` to parse as
 * `z.email()`; a non-email string must not reach the client as a 500.
 */
async function mapChannelErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChannelRefusedError) {
      throw new AppError({
        status: 422,
        code: `notifications.${error.code}`,
        title: 'Unprocessable Content',
        detail: error.message,
        family: 'user',
      });
    }
    if (error instanceof z.ZodError) {
      throw new AppError({
        status: 422,
        code: 'notifications.channel_config_invalid',
        title: 'Unprocessable Content',
        detail: error.issues.map((issue) => issue.message).join('; '),
        family: 'user',
      });
    }
    throw error;
  }
}

/**
 * The simple `{kind, destination}` form → a full `ChannelConfig`, with
 * per-kind defaults `createChannel`'s body schema does not collect —
 * see this file's module comment.
 */
function configFromDestination(input: {
  readonly kind: 'ntfy' | 'smtp';
  readonly destination: string;
}): ChannelConfig {
  if (input.kind === 'ntfy') {
    return {
      kind: 'ntfy',
      scheme: 'https',
      host: 'ntfy.sh',
      port: 443,
      topic: input.destination,
      accessToken: null,
    };
  }
  const domain = input.destination.split('@')[1] ?? 'localhost';
  return {
    kind: 'smtp',
    scheme: 'smtp+starttls',
    host: `smtp.${domain}`,
    port: 587,
    username: input.destination,
    // No credential is collectible from a bare address; `verify` fails
    // cleanly on a bad login rather than crashing — see the module header.
    password: 'unset',
    from: input.destination,
    to: input.destination,
  };
}

/** The WP 2.11 stub's `NotificationTestResult` — same field names, verbatim. */
const testResultSchema = z.object({ ok: z.boolean(), message: z.string(), testedAt: isoInstant });

const channelSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['ntfy', 'smtp']),
    displayName: z.string(),
    destinationHost: z.string(),
    destinationPort: z.int(),
    scheme: z.string(),
    /** `${destinationHost}:${destinationPort}` — addressing only, matching the stub's single field. */
    destination: z.string(),
    enabled: z.boolean(),
    verifiedAt: isoInstant.nullable(),
    verifyFailureCode: z.string().nullable(),
    lastDeliveryAt: isoInstant.nullable(),
    /** Synthesised from `verifiedAt`/`verifyFailureCode` — the stub's shape for "last test result". */
    lastTestResult: testResultSchema.nullable(),
  })
  .meta({ id: 'NotificationChannel' });

function serialiseChannel(channel: RedactedChannel): z.infer<typeof channelSchema> {
  // `RedactedChannel` carries no "when did the last failure happen" column
  // (only `verifyFailureCode`, no timestamp), so a stale failure cannot be
  // dated honestly from this view. A success can: `verifiedAt` is exactly
  // that moment. `NotificationSettingsScreen.tsx` never reads this field from
  // the list anyway — its own `testResultByChannel` state comes straight off
  // each `POST .../verify` response — so under-reporting the failure case
  // here costs the UI nothing.
  const lastTestResult =
    channel.verifiedAt === null
      ? null
      : { ok: true, message: 'Verified', testedAt: channel.verifiedAt.toISOString() };
  return {
    id: channel.id,
    kind: channel.kind,
    displayName: channel.displayName,
    destinationHost: channel.destinationHost,
    destinationPort: channel.destinationPort,
    scheme: channel.scheme,
    destination: `${channel.destinationHost}:${String(channel.destinationPort)}`,
    enabled: channel.enabled,
    verifiedAt: channel.verifiedAt === null ? null : channel.verifiedAt.toISOString(),
    verifyFailureCode: channel.verifyFailureCode,
    lastDeliveryAt: channel.lastDeliveryAt === null ? null : channel.lastDeliveryAt.toISOString(),
    lastTestResult,
  };
}

const ruleSchema = z
  .object({
    id: z.uuid(),
    channelId: z.uuid(),
    name: z.string(),
    eventType: z.string(),
    conditions: z.record(z.string(), z.unknown()),
    deliveryClass: z.enum(DELIVERY_CLASSES),
    digestCadence: z.enum(DIGEST_CADENCES).nullable(),
    timezone: z.string(),
    quietHoursEnabled: z.boolean(),
    quietHoursStartMinute: z.int(),
    quietHoursEndMinute: z.int(),
    enabled: z.boolean(),
  })
  .meta({ id: 'NotificationRule' });

function serialiseRule(row: NotificationRuleRow): z.infer<typeof ruleSchema> {
  return {
    id: row.id,
    channelId: row.channelId,
    name: row.name,
    eventType: row.eventType,
    conditions: row.conditions as Record<string, unknown>,
    deliveryClass: row.deliveryClass,
    digestCadence: row.digestCadence,
    timezone: row.timezone,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStartMinute: row.quietHoursStartMinute,
    quietHoursEndMinute: row.quietHoursEndMinute,
    enabled: row.enabled,
  };
}

/** Not `.meta()`'d directly — `.extend()`'d below for the dead-letter shape too. */
const outboxEntryShape = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  ruleId: z.uuid().nullable(),
  status: z.enum(OUTBOX_STATUSES),
  heldReason: z.string().nullable(),
  deliveryClass: z.enum(DELIVERY_CLASSES),
  priority: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  deepLink: z.string().nullable(),
  groupKey: z.string().nullable(),
  groupCount: z.int().nonnegative(),
  attemptCount: z.int().nonnegative(),
  maxAttempts: z.int().nonnegative(),
  notBefore: isoInstant,
  queuedAt: isoInstant,
  deliveredAt: isoInstant.nullable(),
  deadAt: isoInstant.nullable(),
  lastFailureCode: z.string().nullable(),
});
const outboxEntrySchema = outboxEntryShape.meta({ id: 'NotificationOutboxEntry' });

const attemptSchema = z.object({
  attempt: z.int(),
  outcome: z.string(),
  refusalCode: z.string().nullable(),
  httpStatus: z.int().nullable(),
  detail: z.string().nullable(),
  durationMs: z.number().nullable(),
  nextAttemptAt: isoInstant.nullable(),
  finishedAt: isoInstant,
});
const deadLetterSchema = outboxEntryShape
  .extend({ attempts: z.array(attemptSchema) })
  .meta({ id: 'NotificationDeadLetter' });

function serialiseAttempt(attempt: AttemptEntry): z.infer<typeof attemptSchema> {
  return {
    attempt: attempt.attempt,
    outcome: attempt.outcome,
    refusalCode: attempt.refusalCode,
    httpStatus: attempt.httpStatus,
    detail: attempt.detail,
    durationMs: attempt.durationMs,
    nextAttemptAt: attempt.nextAttemptAt === null ? null : attempt.nextAttemptAt.toISOString(),
    finishedAt: attempt.finishedAt.toISOString(),
  };
}

function serialiseOutboxEntry(entry: OutboxEntry): z.infer<typeof outboxEntrySchema> {
  return {
    id: entry.id,
    channelId: entry.channelId,
    ruleId: entry.ruleId,
    status: entry.status,
    heldReason: entry.heldReason,
    deliveryClass: entry.deliveryClass,
    priority: entry.priority,
    title: entry.title,
    bodyMd: entry.bodyMd,
    deepLink: entry.deepLink,
    groupKey: entry.groupKey,
    groupCount: entry.groupCount,
    attemptCount: entry.attemptCount,
    maxAttempts: entry.maxAttempts,
    notBefore: entry.notBefore.toISOString(),
    queuedAt: entry.queuedAt.toISOString(),
    deliveredAt: entry.deliveredAt === null ? null : entry.deliveredAt.toISOString(),
    deadAt: entry.deadAt === null ? null : entry.deadAt.toISOString(),
    lastFailureCode: entry.lastFailureCode,
  };
}

export const notificationRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;
  const policy = () => createNotificationEgressPolicy(deps.config);
  const registry = () => createNotificationChannels(policy());

  return async (app) => {
    app.get(
      '/notifications/channels',
      {
        schema: {
          operationId: 'listNotificationChannels',
          summary: 'This user’s notification channels, redacted',
          tags: ['notifications'],
          response: {
            200: z.object({ channels: z.array(channelSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const channels = await listChannels(database, session.userId);
        return { channels: channels.map(serialiseChannel) };
      },
    );

    app.post(
      '/notifications/channels',
      {
        schema: {
          operationId: 'createNotificationChannel',
          summary: 'Add a channel — sealed on write, disabled until verified',
          description:
            'Needs a step-up assertion. Accepts either the simple `{kind, displayName, ' +
            'destination}` form (one address field, per-kind defaults for everything else — ' +
            "see this file's module comment) or the full `{displayName, config}` form for a " +
            'client that wants to set every field itself. The destination is checked against ' +
            'the egress allow-list before the row is written; with the default deny-all ' +
            'allow-list this refuses with `notifications.host_not_allowed` rather than a 500.',
          tags: ['notifications'],
          body: z.union([
            z.object({
              displayName: z.string().min(1).max(120),
              kind: z.enum(['ntfy', 'smtp']),
              destination: z.string().min(1),
            }),
            z.object({ displayName: z.string().min(1).max(120), config: channelConfigSchema }),
          ]),
          response: {
            201: z.object({ channel: channelSchema }),
            ...problems(400, 401, 403, 422, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const secretBox = deps.connections().secretBox;
        const config =
          'config' in request.body ? request.body.config : configFromDestination(request.body);
        const channel = await mapChannelErrors(() =>
          createChannel(
            database,
            contextOf(deps, session.userId, request),
            { displayName: request.body.displayName, config },
            { secretBox, policy: policy() },
          ),
        );
        return reply.code(201).send({ channel: serialiseChannel(channel) });
      },
    );

    app.post(
      '/notifications/channels/:channelId/verify',
      {
        schema: {
          operationId: 'verifyNotificationChannel',
          summary: 'Send a real test notification through this channel',
          description:
            'Reaches the destination for real, through the egress policy, and reports what ' +
            'happened — never throws for a refusal (`{result: {ok: false, message}}` for a ' +
            'disallowed host, a connection failure, or a bad credential); a 404 is reserved for ' +
            'a channel id that does not exist at all.',
          tags: ['notifications'],
          params: z.object({ channelId: z.uuid() }),
          response: {
            200: z.object({ result: testResultSchema }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const existing = await findChannel(database, session.userId, request.params.channelId);
        if (existing === null) {
          throw new AppError({
            status: 404,
            code: 'notifications.channel_not_found',
            title: 'Not Found',
            detail: `no channel ${request.params.channelId}`,
            family: 'user',
          });
        }
        const secretBox = deps.connections().secretBox;
        const result = await verifyChannel(
          database,
          contextOf(deps, session.userId, request),
          { channelId: request.params.channelId },
          { secretBox, registry: registry() },
        );
        // The refusal *code* (e.g. `host_not_allowed`) is folded into the
        // message rather than carried as a separate field, because the WP
        // 2.11 stub's `NotificationTestResult` has only `{ok, message,
        // testedAt}` — but it stays visible and machine-greppable rather
        // than being swallowed by the adapter's prose alone.
        const message = result.ok
          ? 'Verified'
          : result.refusalCode !== null && result.refusalCode !== undefined
            ? `${result.refusalCode}: ${result.detail ?? 'verification failed'}`
            : (result.detail ?? 'verification failed');
        return {
          result: { ok: result.ok, message, testedAt: deps.clock.now().toISOString() },
        };
      },
    );

    app.patch(
      '/notifications/channels/:channelId',
      {
        schema: {
          operationId: 'updateNotificationChannel',
          summary: 'Enable/disable a channel, or rename it',
          description:
            'Needs a step-up assertion, the same policy as creating a channel: `enabled` is ' +
            "kill-switch state, not decoration. `@ctx/notifications`'s own `setChannelEnabled` " +
            'is used for the enabled flag; the display name is a direct column write (see this ' +
            "file's module comment on what the context does not export).",
          tags: ['notifications'],
          params: z.object({ channelId: z.uuid() }),
          body: z
            .object({
              enabled: z.boolean().optional(),
              displayName: z.string().min(1).max(120).optional(),
            })
            .refine(
              (body) => body.enabled !== undefined || body.displayName !== undefined,
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ channel: channelSchema }),
            ...problems(400, 401, 403, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const existing = await findChannel(database, session.userId, request.params.channelId);
        if (existing === null) {
          throw new AppError({
            status: 404,
            code: 'notifications.channel_not_found',
            title: 'Not Found',
            detail: `no channel ${request.params.channelId}`,
            family: 'user',
          });
        }
        const context = contextOf(deps, session.userId, request);
        if (request.body.enabled !== undefined) {
          await setChannelEnabled(
            database,
            context,
            request.params.channelId,
            request.body.enabled,
          );
        }
        if (request.body.displayName !== undefined) {
          await database
            .update(notificationChannels)
            .set({ displayName: request.body.displayName, updatedAt: deps.clock.now() })
            .where(
              and(
                eq(notificationChannels.id, request.params.channelId),
                eq(notificationChannels.userId, session.userId),
              ),
            );
        }
        const refreshed = await findChannel(database, session.userId, request.params.channelId);
        if (refreshed === null) throw new Error('channel vanished mid-update');
        return { channel: serialiseChannel(redactChannel(refreshed)) };
      },
    );

    app.delete(
      '/notifications/channels/:channelId',
      {
        schema: {
          operationId: 'deleteNotificationChannel',
          summary: 'Delete a channel — its rules and outbox entries cascade with it',
          description:
            'Needs a step-up assertion, the same policy as creating one. Idempotent: deleting a ' +
            'channel that is not (or no longer) this user’s own returns `deleted: false`, not a 404.',
          tags: ['notifications'],
          params: z.object({ channelId: z.uuid() }),
          response: {
            200: z.object({ deleted: z.boolean() }),
            ...problems(401, 403, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const deleted = await database
          .delete(notificationChannels)
          .where(
            and(
              eq(notificationChannels.id, request.params.channelId),
              eq(notificationChannels.userId, session.userId),
            ),
          )
          .returning({ id: notificationChannels.id });
        return { deleted: deleted.length > 0 };
      },
    );

    app.get(
      '/notifications/rules',
      {
        schema: {
          operationId: 'listNotificationRules',
          summary: 'Every notification rule this user has',
          tags: ['notifications'],
          response: {
            200: z.object({ rules: z.array(ruleSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await database
          .select()
          .from(notificationRules)
          .where(eq(notificationRules.userId, session.userId))
          .orderBy(desc(notificationRules.createdAt));
        return { rules: rows.map(serialiseRule) };
      },
    );

    app.put(
      '/notifications/rules',
      {
        schema: {
          operationId: 'putNotificationRule',
          summary: 'Create a rule, or replace one by id',
          description:
            'Omit `id` to create; pass it to replace an existing rule this user owns. A ' +
            '`P0_SAFETY` rule may not also claim quiet hours (`notification_rules_p0_ignores_' +
            'quiet_hours`); this route enforces the same default `createRule` does.',
          tags: ['notifications'],
          body: z.object({
            id: z.uuid().optional(),
            channelId: z.uuid(),
            name: z.string().min(1).max(120),
            eventType: z.string().min(1),
            conditions: z.record(z.string(), z.unknown()).optional(),
            deliveryClass: z.enum(DELIVERY_CLASSES),
            digestCadence: z.enum(DIGEST_CADENCES).nullable().optional(),
            quietHoursEnabled: z.boolean().optional(),
            quietHoursStartMinute: z.int().min(0).max(1439).optional(),
            quietHoursEndMinute: z.int().min(0).max(1439).optional(),
            enabled: z.boolean().optional(),
          }),
          response: {
            200: z.object({ rule: ruleSchema }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timezone = await timezoneOf(deps);
        const quietHoursEnabled =
          request.body.deliveryClass === 'P0_SAFETY'
            ? false
            : (request.body.quietHoursEnabled ?? true);
        const digestCadence =
          request.body.deliveryClass === 'DIGEST' ? (request.body.digestCadence ?? 'WEEKLY') : null;
        const now = deps.clock.now();

        if (request.body.id === undefined) {
          const [row] = await database
            .insert(notificationRules)
            .values({
              id: newId(),
              userId: session.userId,
              channelId: request.body.channelId,
              name: request.body.name,
              eventType: request.body.eventType,
              conditions: request.body.conditions ?? {},
              deliveryClass: request.body.deliveryClass,
              digestCadence,
              timezone,
              quietHoursEnabled,
              quietHoursStartMinute: request.body.quietHoursStartMinute ?? 1320,
              quietHoursEndMinute: request.body.quietHoursEndMinute ?? 420,
              enabled: request.body.enabled ?? true,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (row === undefined) throw new Error('notification_rules insert returned no row');
          return { rule: serialiseRule(row) };
        }

        const [row] = await database
          .update(notificationRules)
          .set({
            channelId: request.body.channelId,
            name: request.body.name,
            eventType: request.body.eventType,
            conditions: request.body.conditions ?? {},
            deliveryClass: request.body.deliveryClass,
            digestCadence,
            quietHoursEnabled,
            quietHoursStartMinute: request.body.quietHoursStartMinute ?? 1320,
            quietHoursEndMinute: request.body.quietHoursEndMinute ?? 420,
            enabled: request.body.enabled ?? true,
            updatedAt: now,
          })
          .where(
            and(
              eq(notificationRules.id, request.body.id),
              eq(notificationRules.userId, session.userId),
            ),
          )
          .returning();
        if (row === undefined) {
          throw new AppError({
            status: 404,
            code: 'notifications.rule_not_found',
            title: 'Not Found',
            detail: `no rule ${request.body.id}`,
            family: 'user',
          });
        }
        return { rule: serialiseRule(row) };
      },
    );

    app.patch(
      '/notifications/rules/:ruleId',
      {
        schema: {
          operationId: 'updateNotificationRule',
          summary: 'Enable/disable a rule, or move its quiet-hours window',
          tags: ['notifications'],
          params: z.object({ ruleId: z.uuid() }),
          body: z
            .object({
              enabled: z.boolean().optional(),
              quietHoursStartMinute: z.int().min(0).max(1439).optional(),
              quietHoursEndMinute: z.int().min(0).max(1439).optional(),
            })
            .refine(
              (body) => Object.values(body).some((value) => value !== undefined),
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ rule: ruleSchema }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const [row] = await database
          .update(notificationRules)
          .set({
            ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
            ...(request.body.quietHoursStartMinute === undefined
              ? {}
              : { quietHoursStartMinute: request.body.quietHoursStartMinute }),
            ...(request.body.quietHoursEndMinute === undefined
              ? {}
              : { quietHoursEndMinute: request.body.quietHoursEndMinute }),
            updatedAt: deps.clock.now(),
          })
          .where(
            and(
              eq(notificationRules.id, request.params.ruleId),
              eq(notificationRules.userId, session.userId),
            ),
          )
          .returning();
        if (row === undefined) {
          throw new AppError({
            status: 404,
            code: 'notifications.rule_not_found',
            title: 'Not Found',
            detail: `no rule ${request.params.ruleId}`,
            family: 'user',
          });
        }
        return { rule: serialiseRule(row) };
      },
    );

    app.get(
      '/notifications/outbox',
      {
        schema: {
          operationId: 'listNotificationOutbox',
          summary: 'Recent deliveries and the dead-letter view',
          tags: ['notifications'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
          response: {
            200: z.object({
              recent: z.array(outboxEntrySchema),
              deadLetters: z.array(deadLetterSchema),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const [recent, deadLetters] = await Promise.all([
          listOutbox(database, session.userId, {
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
          }),
          listDeadLetters(database, session.userId),
        ]);
        return {
          recent: recent.map(serialiseOutboxEntry),
          deadLetters: deadLetters.map((entry) => ({
            ...serialiseOutboxEntry(entry),
            attempts: entry.attempts.map(serialiseAttempt),
          })),
        };
      },
    );

    app.get(
      '/notifications/outbox/:notificationId/attempts',
      {
        schema: {
          operationId: 'listNotificationAttempts',
          summary: 'The delivery-attempt history for one queued notification',
          tags: ['notifications'],
          params: z.object({ notificationId: z.uuid() }),
          response: {
            200: z.object({ attempts: z.array(attemptSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const attempts = await listAttempts(
          database,
          session.userId,
          request.params.notificationId,
        );
        return { attempts: attempts.map(serialiseAttempt) };
      },
    );

    app.post(
      '/notifications/outbox/:notificationId/retry',
      {
        schema: {
          operationId: 'retryNotification',
          summary: 'Put a dead letter back on the delivery ladder',
          tags: ['notifications'],
          params: z.object({ notificationId: z.uuid() }),
          response: {
            200: z.object({ retried: z.boolean() }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const retried = await retryNotification(
          database,
          contextOf(deps, session.userId, request),
          request.params.notificationId,
        );
        return { retried };
      },
    );
  };
};
