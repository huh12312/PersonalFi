// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { FormEvent } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Bell } from 'lucide-react';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_EVENT_TYPES,
  useCreateNotificationChannelMutation,
  useNotificationChannelsQuery,
  useNotificationRulesQuery,
  useSendTestNotificationMutation,
  useUpdateNotificationChannelMutation,
  useUpdateNotificationRuleMutation,
  type NotificationChannelKind,
} from './api-pending.ts';

/**
 * Notification settings (WP 2.4/2.11 boundary). The REST surface behind this
 * screen does not exist yet — `api-pending.ts`'s header explains exactly what
 * is pending and why — so every request this screen makes 404s against
 * today's real API. The screen is built and tested against that stub so the
 * UI needs no rework once WP 2.4 ships the routes: only `api-pending.ts`'s
 * internals change.
 */
export function NotificationSettingsScreen() {
  const channelsQuery = useNotificationChannelsQuery();
  const rulesQuery = useNotificationRulesQuery();
  const createChannel = useCreateNotificationChannelMutation();
  const updateChannel = useUpdateNotificationChannelMutation();
  const sendTest = useSendTestNotificationMutation();
  const updateRule = useUpdateNotificationRuleMutation();

  const [kind, setKind] = useState<NotificationChannelKind>('ntfy');
  const [displayName, setDisplayName] = useState('');
  const [destination, setDestination] = useState('');
  const [testResultByChannel, setTestResultByChannel] = useState<
    Record<string, { ok: boolean; message: string } | undefined>
  >({});

  if (channelsQuery.isLoading || rulesQuery.isLoading) return <SkeletonText lines={4} />;

  const channelsFailed = channelsQuery.isError;
  const channels = channelsQuery.data?.channels ?? [];
  const rules = rulesQuery.data?.rules ?? [];

  async function handleAddChannel(event: FormEvent): Promise<void> {
    event.preventDefault();
    await createChannel.mutateAsync({ kind, displayName, destination });
    setDisplayName('');
    setDestination('');
  }

  async function handleSendTest(channelId: string): Promise<void> {
    const { result } = await sendTest.mutateAsync(channelId);
    setTestResultByChannel((prev) => ({ ...prev, [channelId]: result }));
  }

  return (
    <div className="flex flex-col gap-6">
      {channelsFailed && (
        <EmptyState
          icon={Bell}
          headline="Notifications aren't available yet"
          description="The notification delivery service is still being built (WP 2.4). This screen is ready and will work as soon as it ships."
        />
      )}

      <section>
        <h2 className="text-h3 text-text-primary">Channels</h2>
        {channels.length === 0 && !channelsFailed && (
          <p className="mt-2 text-small text-text-muted">No channels configured yet.</p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {channels.map((channel) => (
            <li
              key={channel.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
            >
              <div className="min-w-0">
                <p className="text-body font-medium text-text-primary">
                  {channel.displayName}{' '}
                  <span className="text-caption text-text-muted">({channel.kind})</span>
                </p>
                <p className="truncate text-small text-text-muted">{channel.destination}</p>
                {testResultByChannel[channel.id] !== undefined && (
                  <p
                    role="status"
                    className={
                      testResultByChannel[channel.id]?.ok
                        ? 'text-small text-status-good'
                        : 'text-small text-status-critical'
                    }
                  >
                    {testResultByChannel[channel.id]?.message}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={sendTest.isPending}
                  onClick={() => void handleSendTest(channel.id)}
                >
                  Send test
                </Button>
                <Switch
                  aria-label={`${channel.enabled ? 'Disable' : 'Enable'} ${channel.displayName}`}
                  checked={channel.enabled}
                  onCheckedChange={(checked: boolean) =>
                    updateChannel.mutate({ channelId: channel.id, body: { enabled: checked } })
                  }
                />
              </div>
            </li>
          ))}
        </ul>

        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => void handleAddChannel(event)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notif-channel-kind">Kind</Label>
            <select
              id="notif-channel-kind"
              className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
              value={kind}
              onChange={(event) => setKind(event.target.value as NotificationChannelKind)}
            >
              {NOTIFICATION_CHANNEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notif-channel-name">Name</Label>
            <Input
              id="notif-channel-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notif-channel-destination">
              {kind === 'ntfy' ? 'Topic' : 'Email address'}
            </Label>
            <Input
              id="notif-channel-destination"
              required
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={createChannel.isPending}>
            Add channel
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-h3 text-text-primary">Rules</h2>
        {rules.length === 0 && !channelsFailed && (
          <p className="mt-2 text-small text-text-muted">
            No notification rules yet — {NOTIFICATION_EVENT_TYPES.length} event types are available
            once a channel exists.
          </p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
            >
              <div>
                <p className="text-body text-text-primary">{rule.eventType}</p>
                {rule.quietHoursStart !== null && rule.quietHoursEnd !== null && (
                  <p className="text-caption text-text-muted">
                    Quiet hours {rule.quietHoursStart}–{rule.quietHoursEnd}
                  </p>
                )}
              </div>
              <Switch
                aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.eventType}`}
                checked={rule.enabled}
                onCheckedChange={(checked: boolean) =>
                  updateRule.mutate({ ruleId: rule.id, body: { enabled: checked } })
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
