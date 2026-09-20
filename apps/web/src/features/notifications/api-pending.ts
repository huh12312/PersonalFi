// SPDX-License-Identifier: MIT
/**
 * PENDING CONTRACT — no route behind this yet.
 *
 * WP 2.4 (`packages/contexts/notifications/**`) is building the
 * `NotificationChannel` port, the ntfy/SMTP adapters, and the egress
 * allow-list concurrently with this work package; its scope explicitly
 * covers the context and its migration, not a REST surface
 * (`apps/api/src/routes/notifications.ts` does not exist on this branch —
 * confirmed by inspection before writing this file). This module is the
 * Phase 0 `pending-contracts.ts` pattern applied to that gap: real `fetch`
 * calls, real Zod validation, real React Query hooks, against the paths the
 * REST surface will most plausibly use (`/api/notifications/*`, mirroring
 * `notification_channels`/`notification_rules`) — so that when the route
 * lands, the swap is `apiFetch(...)` → the generated client's
 * `…Options()`/`…Mutation()` factories, in this file only.
 * `NotificationSettingsScreen.tsx` imports the *hooks* this file exports and
 * needs no change at all.
 *
 * Until then, every call here 404s against a real deployment — by design,
 * not a bug this file is hiding. The evidence doc records this plainly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch } from '../../api/pending-contracts.ts';

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

const testResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  testedAt: z.string(),
});
export type NotificationTestResult = z.infer<typeof testResultSchema>;

const channelSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_CHANNEL_KINDS),
  displayName: z.string(),
  enabled: z.boolean(),
  /** Never a secret value, sealed or otherwise — WP 2.4's own custody rule (wp2.4-notifications.md §"custody"). What's shown here is addressing only: a topic name or a destination address, never a password or token. */
  destination: z.string(),
  lastTestResult: testResultSchema.nullable(),
});
export type NotificationChannel = z.infer<typeof channelSchema>;

const ruleSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  channelId: z.string(),
  enabled: z.boolean(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
});
export type NotificationRule = z.infer<typeof ruleSchema>;

function listChannels(): Promise<{ channels: NotificationChannel[] }> {
  return apiFetch('/api/notifications/channels', z.object({ channels: z.array(channelSchema) }));
}

function createChannel(body: {
  kind: NotificationChannelKind;
  displayName: string;
  destination: string;
}): Promise<{ channel: NotificationChannel }> {
  return apiFetch('/api/notifications/channels', z.object({ channel: channelSchema }), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function updateChannel(
  channelId: string,
  body: { enabled?: boolean; displayName?: string; destination?: string },
): Promise<{ channel: NotificationChannel }> {
  return apiFetch(
    `/api/notifications/channels/${channelId}`,
    z.object({ channel: channelSchema }),
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

function sendTestNotification(channelId: string): Promise<{ result: NotificationTestResult }> {
  return apiFetch(
    `/api/notifications/channels/${channelId}/test`,
    z.object({ result: testResultSchema }),
    { method: 'POST' },
  );
}

function listRules(): Promise<{ rules: NotificationRule[] }> {
  return apiFetch('/api/notifications/rules', z.object({ rules: z.array(ruleSchema) }));
}

function createRule(body: {
  eventType: string;
  channelId: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}): Promise<{ rule: NotificationRule }> {
  return apiFetch('/api/notifications/rules', z.object({ rule: ruleSchema }), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function updateRule(
  ruleId: string,
  body: { enabled?: boolean; quietHoursStart?: string | null; quietHoursEnd?: string | null },
): Promise<{ rule: NotificationRule }> {
  return apiFetch(`/api/notifications/rules/${ruleId}`, z.object({ rule: ruleSchema }), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function deleteRule(ruleId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/notifications/rules/${ruleId}`, z.object({ deleted: z.boolean() }), {
    method: 'DELETE',
  });
}

/* -------------------------------------------------------------------------- */
/* React Query hooks — named as the eventual generated client would name them */
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

export function useDeleteNotificationRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteRule,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rulesQueryKey }),
  });
}
