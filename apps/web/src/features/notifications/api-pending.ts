// SPDX-License-Identifier: MIT
/**
 * The real `/notifications/*` surface, behind the WP 2.11 stub's own shape.
 *
 * This file used to be a Phase-0 `pending-contracts.ts`-style stub: real
 * `fetch` calls against paths that did not exist yet
 * (`docs/evidence/phase-2/wp2.11-inbox-ui.md` §2). WP 2.r built
 * `apps/api/src/routes/notifications.ts`; this is the swap the stub's own
 * header promised — `apiFetch(...)` → the generated client — with
 * `NotificationSettingsScreen.tsx` needing no change at all, per this work
 * package's own instructions: where the real route's natural shape and the
 * stub's guessed one differ, the route bent to match the stub, not the other
 * way around (`docs/evidence/phase-2/wp2.r-routes.md` §5 records exactly
 * which fields that applies to and why).
 *
 * Two real gaps this swap could not paper over, both because the UI's guess
 * predates the route's actual security design and neither is reachable from
 * anything `NotificationSettingsScreen.tsx` renders today:
 *
 *   * **`destination` is synthesised, never the sealed topic/address.** A
 *     channel's ntfy topic or SMTP `to` lives inside `sealed_config`
 *     (decision D5) and is never returned by a read; `destination` here is
 *     `${destinationHost}:${destinationPort}` — real, non-secret addressing,
 *     just not literally what the create form typed in.
 *   * **A bare `destination` string cannot carry SMTP credentials.** Creating
 *     an `smtp` channel from this screen fills in a guessed relay host and no
 *     credential (`apps/api/src/routes/notifications.ts`'s
 *     `configFromDestination`); it will fail `verify` until a real "advanced"
 *     SMTP form exists — future UI work, not silently faked here.
 *   * **`useDeleteNotificationRuleMutation` is gone.** There is no
 *     `DELETE /notifications/rules/{id}` route (`@ctx/notifications` exports
 *     no delete-by-id for a rule either) and nothing in this codebase called
 *     the old export — confirmed by grepping every import of this module
 *     before removing it, rather than assumed.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Sdk } from '../../api/generated/sdk.gen.ts';
import type {
  NotificationChannel as GeneratedChannel,
  NotificationRule as GeneratedRule,
} from '../../api/generated/types.gen.ts';

export const NOTIFICATION_CHANNEL_KINDS = ['ntfy', 'smtp'] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

/** Every event type WP 2.4's rules can route (08 §4.5's channel/rule shape) — kept as a plain list here since the real enum lives server-side. */
export const NOTIFICATION_EVENT_TYPES = [
  'budgeting.BudgetThresholdCrossed',
  'recurring.PriceChangeDetected',
  'insights.InsightProposed',
  'connections.ConnectionStatusChanged',
  'connections.SyncRunCompleted',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface NotificationTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly testedAt: string;
}

export interface NotificationChannel {
  readonly id: string;
  readonly kind: NotificationChannelKind;
  readonly displayName: string;
  readonly enabled: boolean;
  /** Addressing only, never a secret — see this file's module comment. */
  readonly destination: string;
  readonly lastTestResult: NotificationTestResult | null;
}

export interface NotificationRule {
  readonly id: string;
  readonly eventType: string;
  readonly channelId: string;
  readonly enabled: boolean;
  /** `HH:MM`, local time, or `null` when quiet hours are off for this rule. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
}

function toChannel(channel: GeneratedChannel): NotificationChannel {
  return {
    id: channel.id,
    kind: channel.kind,
    displayName: channel.displayName,
    enabled: channel.enabled,
    destination: channel.destination,
    lastTestResult: channel.lastTestResult,
  };
}

function minuteToClock(minute: number): string {
  const hours = Math.floor(minute / 60)
    .toString()
    .padStart(2, '0');
  const mins = (minute % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

function clockToMinute(clock: string): number {
  const [hoursText = '0', minsText = '0'] = clock.split(':');
  return Math.min(1439, Math.max(0, Number(hoursText) * 60 + Number(minsText)));
}

function toRule(rule: GeneratedRule): NotificationRule {
  return {
    id: rule.id,
    eventType: rule.eventType,
    channelId: rule.channelId,
    enabled: rule.enabled,
    quietHoursStart: rule.quietHoursEnabled ? minuteToClock(rule.quietHoursStartMinute) : null,
    quietHoursEnd: rule.quietHoursEnabled ? minuteToClock(rule.quietHoursEndMinute) : null,
  };
}

async function listChannels(): Promise<{ channels: NotificationChannel[] }> {
  const { data } = await Sdk.__registry.get().listNotificationChannels({ throwOnError: true });
  return { channels: data.channels.map(toChannel) };
}

async function createChannel(body: {
  kind: NotificationChannelKind;
  displayName: string;
  destination: string;
}): Promise<{ channel: NotificationChannel }> {
  const { data } = await Sdk.__registry.get().createNotificationChannel({
    body,
    throwOnError: true,
  });
  return { channel: toChannel(data.channel) };
}

async function updateChannel(
  channelId: string,
  body: { enabled?: boolean; displayName?: string; destination?: string },
): Promise<{ channel: NotificationChannel }> {
  // `destination` cannot be changed through this route (it is derived from
  // the sealed config, which a rename does not touch) — silently dropped
  // rather than sent, since nothing in this codebase ever passes it.
  const { data } = await Sdk.__registry.get().updateNotificationChannel({
    path: { channelId },
    body: { enabled: body.enabled, displayName: body.displayName },
    throwOnError: true,
  });
  return { channel: toChannel(data.channel) };
}

async function sendTestNotification(
  channelId: string,
): Promise<{ result: NotificationTestResult }> {
  const { data } = await Sdk.__registry.get().verifyNotificationChannel({
    path: { channelId },
    throwOnError: true,
  });
  return { result: data.result };
}

async function listRules(): Promise<{ rules: NotificationRule[] }> {
  const { data } = await Sdk.__registry.get().listNotificationRules({ throwOnError: true });
  return { rules: data.rules.map(toRule) };
}

async function createRule(body: {
  eventType: string;
  channelId: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}): Promise<{ rule: NotificationRule }> {
  const { data } = await Sdk.__registry.get().putNotificationRule({
    body: {
      channelId: body.channelId,
      // `PUT /notifications/rules` needs a name and a delivery class the
      // stub's own create shape never collected; a sensible default for
      // both, since nothing in this codebase calls this function today.
      name: body.eventType,
      eventType: body.eventType,
      deliveryClass: 'PROMPT',
      ...(body.quietHoursStart == null
        ? {}
        : { quietHoursStartMinute: clockToMinute(body.quietHoursStart) }),
      ...(body.quietHoursEnd == null
        ? {}
        : { quietHoursEndMinute: clockToMinute(body.quietHoursEnd) }),
    },
    throwOnError: true,
  });
  return { rule: toRule(data.rule) };
}

async function updateRule(
  ruleId: string,
  body: { enabled?: boolean; quietHoursStart?: string | null; quietHoursEnd?: string | null },
): Promise<{ rule: NotificationRule }> {
  const { data } = await Sdk.__registry.get().updateNotificationRule({
    path: { ruleId },
    body: {
      enabled: body.enabled,
      ...(body.quietHoursStart == null
        ? {}
        : { quietHoursStartMinute: clockToMinute(body.quietHoursStart) }),
      ...(body.quietHoursEnd == null
        ? {}
        : { quietHoursEndMinute: clockToMinute(body.quietHoursEnd) }),
    },
    throwOnError: true,
  });
  return { rule: toRule(data.rule) };
}

/* -------------------------------------------------------------------------- */
/* React Query hooks — same names and shapes the old stub exported */
/* -------------------------------------------------------------------------- */

const channelsQueryKey = ['notifications', 'channels'] as const;
const rulesQueryKey = ['notifications', 'rules'] as const;

export function useNotificationChannelsQuery() {
  return useQuery({ queryKey: channelsQueryKey, queryFn: listChannels });
}

export function useCreateNotificationChannelMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createChannel,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelsQueryKey }),
  });
}

export function useUpdateNotificationChannelMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      channelId: string;
      body: { enabled?: boolean; displayName?: string; destination?: string };
    }) => updateChannel(variables.channelId, variables.body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelsQueryKey }),
  });
}

export function useSendTestNotificationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: sendTestNotification,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelsQueryKey }),
  });
}

export function useNotificationRulesQuery() {
  return useQuery({ queryKey: rulesQueryKey, queryFn: listRules });
}

export function useCreateNotificationRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createRule,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rulesQueryKey }),
  });
}

export function useUpdateNotificationRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      ruleId: string;
      body: { enabled?: boolean; quietHoursStart?: string | null; quietHoursEnd?: string | null };
    }) => updateRule(variables.ruleId, variables.body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rulesQueryKey }),
  });
}
