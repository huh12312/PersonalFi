// SPDX-License-Identifier: MIT
import { AlertTriangle, Plus, Plug } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { SyncStatusPill } from '../../components/patterns/SyncStatusPill.tsx';
import { Button } from '../../components/ui/button.tsx';
import { useSyncStatus } from '../sync/useSyncStatus.ts';
import { AddConnectionDialog } from './AddConnectionDialog.tsx';
import { ConnectionCard } from './ConnectionCard.tsx';
import { ReconnectDialog } from './ReconnectDialog.tsx';
import { useConnectionsQuery } from './useConnections.ts';
import type { ConnectionSummary } from '../../api/generated/types.gen.ts';

/**
 * `/accounts/connections` (deliverable 3 — see `src/app/shell/TopBar.tsx`
 * and `Sidebar.tsx`, both of which already navigate here on the sync pill's
 * error state). Sync status is live via the same `useSyncStatus` SSE-backed
 * hook the top bar and sidebar use (deliverable 4) rather than a second,
 * per-card `/connections/{id}/events` subscription per connection — one
 * live indicator per open tab, not one open SSE socket per card.
 */
export function ConnectionsScreen() {
  const connectionsQuery = useConnectionsQuery();
  const syncStatus = useSyncStatus();
  const [addOpen, setAddOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState<ConnectionSummary | null>(null);

  if (connectionsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton height={72} variant="block" />
        <Skeleton height={72} variant="block" />
      </div>
    );
  }

  if (connectionsQuery.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        headline="Couldn't load your connections"
        description="Something went wrong talking to the server. Try again."
        action={{ label: 'Retry', onClick: () => void connectionsQuery.refetch() }}
      />
    );
  }

  const connections = connectionsQuery.data?.connections ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <SyncStatusPill status={syncStatus} />
        <Button className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus size={16} aria-hidden="true" />
          Add connection
        </Button>
      </div>

      {connections.length === 0 ? (
        <EmptyState
          icon={Plug}
          headline="No connections yet"
          description="Link a bank, import a file, or add a manual account."
          action={{ label: 'Add connection', onClick: () => setAddOpen(true) }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              onReconnect={setReconnecting}
            />
          ))}
        </div>
      )}

      <AddConnectionDialog open={addOpen} onOpenChange={setAddOpen} />
      <ReconnectDialog
        connection={reconnecting}
        onOpenChange={(open) => !open && setReconnecting(null)}
      />
    </div>
  );
}
