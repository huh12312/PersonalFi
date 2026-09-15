// SPDX-License-Identifier: MIT
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { useEffect, useMemo, useRef, useState } from 'react';

import { listConnectionsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { useEventStream } from '../../lib/sse.ts';
import type { SyncStatus } from '../../components/patterns/SyncStatusPill.tsx';

/** A connection is stale enough to warrant the amber pill past this age. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Global sync status for the top bar / sidebar pill (deliverable 4:
 * "top-bar global sync status from GET /sync/stream"). Combines
 * `listConnections` (the baseline: who's in `reauth_required`/`error`, and
 * the most recent `lastSyncedAt`) with the live `/sync/stream` SSE feed,
 * which is what turns the pill from a page-load snapshot into something
 * that actually reflects a sync running right now.
 *
 * `connection.status` and `sync.completed` both invalidate `listConnections`
 * — a full refetch rather than a hand-patched cache entry, because the
 * event's `payload` is intentionally untyped (`lib/sse.ts`'s own doc) and a
 * connection's status/lastSyncedAt is cheap to just re-ask for.
 */
export function useSyncStatus(): SyncStatus {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(listConnectionsOptions());
  const { lastEvent } = useEventStream('/sync/stream');
  const [syncingSince, setSyncingSince] = useState<number | null>(null);
  const lastHandledSeq = useRef<string | null>(null);

  useEffect(() => {
    if (lastEvent === null) return;
    // `lib/sse.ts` only updates `lastEvent` for a *new* named frame, but
    // effects still re-run on every render that changes identity — guard on
    // occurredAt+type so the same event can't restart the "syncing" clock.
    const key = `${lastEvent.occurredAt}|${lastEvent.type}`;
    if (lastHandledSeq.current === key) return;
    lastHandledSeq.current = key;

    if (lastEvent.type === 'connection.status' || lastEvent.type === 'account.upserted') {
      // Reacting to a new SSE frame (an external event, not a derived prop) —
      // the canonical effect use case react-hooks/set-state-in-effect can't
      // tell apart from "should have been computed during render" here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSyncingSince((prev) => prev ?? Date.now());
    }
    if (lastEvent.type === 'sync.completed') {
      setSyncingSince(null);
      void queryClient.invalidateQueries({ queryKey: listConnectionsOptions().queryKey });
    }
    if (lastEvent.type === 'connection.status') {
      void queryClient.invalidateQueries({ queryKey: listConnectionsOptions().queryKey });
    }
  }, [lastEvent, queryClient]);

  return useMemo<SyncStatus>(() => {
    const connections = connectionsQuery.data?.connections ?? [];

    const attention = connections.find(
      (c) => c.status === 'reauth_required' || c.status === 'error',
    );
    if (attention !== undefined) {
      const count = connections.filter(
        (c) => c.status === 'reauth_required' || c.status === 'error',
      ).length;
      return {
        kind: 'error',
        label: count === 1 ? '1 connection needs attention' : `${count} connections need attention`,
      };
    }

    if (syncingSince !== null) {
      return { kind: 'syncing', current: connections.length, total: connections.length || 1 };
    }

    const lastSyncedTimes = connections
      .map((c) => c.lastSyncedAt)
      .filter((v): v is string => v !== null)
      .map((v) => new Date(v).getTime());

    if (lastSyncedTimes.length === 0) {
      return { kind: 'synced', label: 'No syncs yet' };
    }

    const mostRecent = Math.max(...lastSyncedTimes);
    // "Stale" is inherently wall-clock-relative; re-evaluated whenever
    // `connectionsQuery.data`/`syncingSince` change (a sync, a poll, an SSE
    // event), which is an accepted approximation rather than a live countdown.
    // eslint-disable-next-line react-hooks/purity
    if (Date.now() - mostRecent > STALE_AFTER_MS) {
      return {
        kind: 'stale',
        label: `Stale — last synced ${formatDistanceToNowStrict(mostRecent, { addSuffix: true })}`,
      };
    }

    return {
      kind: 'synced',
      label: `Synced ${formatDistanceToNowStrict(mostRecent, { addSuffix: true })}`,
    };
  }, [connectionsQuery.data, syncingSince]);
}
