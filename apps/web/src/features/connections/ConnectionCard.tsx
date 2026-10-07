// SPDX-License-Identifier: MIT
import { ChevronDown, ChevronUp, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ConfirmDialog } from '../../components/patterns/ConfirmDialog.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import {
  describeConnectionHealth,
  canSyncNow,
  formatLastSynced,
  shouldOfferReconnect,
} from './connection-health.ts';
import { CONNECTOR_ICON_BY_KEY, DEFAULT_CONNECTOR_ICON } from './connector-icons.tsx';
import { SyncRunHistory } from './SyncRunHistory.tsx';
import {
  useConnectorsQuery,
  useDisconnectConnectionMutation,
  useSyncConnectionMutation,
} from './useConnections.ts';
import type { ConnectionSummary } from '../../api/generated/types.gen.ts';

const HEALTH_BADGE_VARIANT = {
  good: 'good',
  warning: 'warning',
  critical: 'critical',
  neutral: 'neutral',
} as const;

export interface ConnectionCardProps {
  connection: ConnectionSummary;
  onReconnect: (connection: ConnectionSummary) => void;
}

/** One connection: health, last sync, error kind, account count, and its actions (deliverable 3). */
export function ConnectionCard({ connection, onReconnect }: ConnectionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const health = describeConnectionHealth(connection);
  const connectorsQuery = useConnectorsQuery();
  const manifest = connectorsQuery.data?.connectors.find((c) => c.provider === connection.provider);
  const Icon = CONNECTOR_ICON_BY_KEY[manifest?.iconKey ?? ''] ?? DEFAULT_CONNECTOR_ICON;

  const syncNow = useSyncConnectionMutation();
  const disconnect = useDisconnectConnectionMutation();
  const stepUp = useStepUpRetry();

  async function handleDisconnect(): Promise<void> {
    await stepUp.run(() => disconnect.mutateAsync({ path: { connectionId: connection.id } }));
    setConfirmingDisconnect(false);
  }

  return (
    <div className="rounded-xl border border-border-hairline bg-bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-subtle text-text-secondary">
            <Icon size={18} aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">{connection.displayName}</span>
              <Badge variant={HEALTH_BADGE_VARIANT[health.tone]}>{health.label}</Badge>
            </div>
            <p className="text-small text-text-muted">
              {connection.accountCount} account{connection.accountCount === 1 ? '' : 's'} ·{' '}
              {formatLastSynced(connection.lastSyncedAt)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {shouldOfferReconnect(connection) && (
            <Button variant="secondary" size="sm" onClick={() => onReconnect(connection)}>
              Reconnect
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            disabled={!canSyncNow(connection) || syncNow.isPending}
            onClick={() => syncNow.mutate({ path: { connectionId: connection.id } })}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={syncNow.isPending ? 'motion-safe:animate-spin' : ''}
            />
            Sync now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-status-critical"
            onClick={() => setConfirmingDisconnect(true)}
          >
            <Unplug size={14} aria-hidden="true" />
            Disconnect
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={expanded ? 'Hide sync history' : 'Show sync history'}
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? (
              <ChevronUp size={16} aria-hidden="true" />
            ) : (
              <ChevronDown size={16} aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>

      {(stepUp.error !== null || disconnect.isError) && (
        <p className="mt-2 text-small text-status-critical">
          {stepUp.error ?? 'Could not disconnect this connection.'}
        </p>
      )}

      {expanded && <SyncRunHistory connectionId={connection.id} />}

      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title={`Disconnect ${connection.displayName}?`}
        description="Your transaction history stays. The connection stops syncing until you reconnect it."
        confirmLabel="Disconnect"
        busy={disconnect.isPending || stepUp.busy}
        onConfirm={() => void handleDisconnect()}
      />
    </div>
  );
}
